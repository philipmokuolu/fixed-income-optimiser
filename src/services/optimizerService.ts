import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, KrdKey, KRD_TENORS, Bond, ProposedTrade, BondStaticData, ImpactMetrics } from '@/types';
import { calculatePortfolioMetrics, applyTradesToPortfolio, calculateTrackingError } from './portfolioService';
import { formatCurrency } from '@/utils/formatting';

const MIN_TRADE_SIZE = 1000; // Minimum trade size in currency to be considered
const MAX_ITERATIONS = 50; // Safety break for loops
const TOP_N_CANDIDATES = 20; // Number of buy/sell candidates to consider in heuristic search

const RATING_SCALE: { [key: string]: number } = {
  'AAA': 1, 'AA+': 2, 'AA': 3, 'AA-': 4,
  'A+': 5, 'A': 6, 'A-': 7,
  'BBB+': 8, 'BBB': 9, 'BBB-': 10,
  'BB+': 11, 'BB': 12, 'BB-': 13,
  'B+': 14, 'B': 15, 'B-': 16,
  'CCC+': 17, 'CCC': 18, 'CCC-': 19,
  'CC': 20, 'C': 21, 'D': 22, 'N/A': 99
};

const parseMaturityDate = (dateStr: string): Date => {
  const parts = dateStr.split(/[\/-]/);
  if (parts.length === 3) {
      let year = parseInt(parts[2], 10);
      let month = parseInt(parts[0], 10) - 1;
      let day = parseInt(parts[1], 10);

      if (parts[0].length === 4) {
          year = parseInt(parts[0], 10);
          month = parseInt(parts[1], 10) - 1;
          day = parseInt(parts[2], 10);
      }
      
      if (year < 100) {
          year += (year < 70) ? 2000 : 1900;
      }
      return new Date(year, month, day);
  }
  return new Date(dateStr);
};


export const calculateImpactMetrics = (portfolio: Portfolio, benchmark: Benchmark): ImpactMetrics => {
    return {
        modifiedDuration: portfolio.modifiedDuration,
        durationGap: portfolio.modifiedDuration - benchmark.modifiedDuration,
        trackingError: calculateTrackingError(portfolio, benchmark),
        yield: portfolio.averageYield,
        portfolio: portfolio,
    };
};

const createTradeObject = (action: 'BUY' | 'SELL', bond: Bond | (BondStaticData & {isin: string}), marketValue: number, pairId: number): ProposedTrade => {
    const notional = marketValue / (bond.price / 100);
    const spreadCost = notional * (bond.bidAskSpread / 100) / 2;

    return {
        action,
        isin: bond.isin,
        name: bond.name,
        notional,
        marketValue,
        price: bond.price,
        modifiedDuration: bond.modifiedDuration,
        yieldToMaturity: bond.yieldToMaturity,
        pairId,
        spreadCost,
    };
};

export const runOptimizer = (
  initialPortfolio: Portfolio,
  benchmark: Benchmark,
  params: OptimizationParams,
  bondMasterData: Record<string, BondStaticData>
): OptimizationResult => {
    
    // --- 1. SETUP ---
    const beforeMetrics = calculateImpactMetrics(initialPortfolio, benchmark);
    const { mode, maxTurnover, transactionCost } = params;
    const rationaleSteps: string[] = [];

    const portfolioIsins = new Set(initialPortfolio.bonds.map(b => b.isin));
    
    let buyUniverse = Object.entries(bondMasterData)
        .filter(([isin]) => !portfolioIsins.has(isin))
        .map(([isin, staticData]) => ({ ...staticData, isin } as (Bond & {isin: string})))
        .filter(bond => {
            const today = new Date();
            const maturityDate = parseMaturityDate(bond.maturityDate);
            const yearsToMaturity = (maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
            if (yearsToMaturity > params.investmentHorizonLimit) return false;
            
            const minRatingValue = RATING_SCALE[params.minimumPurchaseRating] ?? 99;
            const bondRatingValue = RATING_SCALE[bond.creditRating] ?? 99;
            return bondRatingValue <= minRatingValue;
        });
    
    let eligibleToSell = initialPortfolio.bonds.filter(b => !params.excludedBonds.includes(b.isin));

    const emptyResult = (rationale: string) => ({
        proposedTrades: [],
        impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
        estimatedCost: 0, estimatedFeeCost: 0, estimatedSpreadCost: 0, estimatedCostBpsOfNav: 0, aggregateFeeBps: 0,
        rationale,
    });

    let currentPortfolio = { ...initialPortfolio };
    let currentBonds = [...initialPortfolio.bonds];
    const proposedTrades: ProposedTrade[] = [];
    let pairIdCounter = 0;

    // --- 2. MAIN LOGIC ---

    if (mode === 'switch') {
        let totalTradedValue = 0;
        const maxTradeValue = (maxTurnover / 100) * initialPortfolio.totalMarketValue;
        const tradeSizeIncrement = Math.max(maxTradeValue / 10, MIN_TRADE_SIZE * 5);
        let iterations = 0;

        while (totalTradedValue < maxTradeValue && iterations < MAX_ITERATIONS) {
            const currentDurationGap = currentPortfolio.modifiedDuration - benchmark.modifiedDuration;
            const currentTE = calculateTrackingError(currentPortfolio, benchmark);
            const isDurationGapBreached = currentDurationGap < -params.maxDurationShortfall || currentDurationGap > params.maxDurationSurplus;
            
            if (!isDurationGapBreached && currentTE < 1.0) { 
                rationaleSteps.push("Halted: Portfolio is within duration limits and tracking error is already minimal.");
                break;
            }

            // Define goal and sort candidates
            let sellCandidates: Bond[];
            let buyCandidates: (Bond & {isin: string})[];

            if (isDurationGapBreached) {
                rationaleSteps.push(`Goal: Fix duration gap of ${currentDurationGap.toFixed(2)} yrs.`);
                const isPortfolioShort = currentDurationGap < 0;
                sellCandidates = [...eligibleToSell].sort((a,b) => isPortfolioShort ? b.modifiedDuration - a.modifiedDuration : a.modifiedDuration - b.modifiedDuration).slice(0, TOP_N_CANDIDATES);
                buyCandidates = [...buyUniverse].sort((a,b) => isPortfolioShort ? b.modifiedDuration - a.modifiedDuration : a.modifiedDuration - b.modifiedDuration).slice(0, TOP_N_CANDIDATES);
            } else {
                const krdGaps = KRD_TENORS.map(t => ({ tenor: t, gap: currentPortfolio[`krd_${t}`] - benchmark[`krd_${t}`] })).sort((a,b) => Math.abs(b.gap) - Math.abs(a.gap));
                const largestGap = krdGaps[0];
                rationaleSteps.push(`Goal: Reduce tracking error by targeting the ${largestGap.tenor} KRD gap.`);
                const krdKeyToFix: KrdKey = `krd_${largestGap.tenor}`;
                const isKrdShort = largestGap.gap < 0;
                sellCandidates = [...eligibleToSell].sort((a,b) => isKrdShort ? a[krdKeyToFix] - b[krdKeyToFix] : b[krdKeyToFix] - a[krdKeyToFix]).slice(0, TOP_N_CANDIDATES);
                buyCandidates = [...buyUniverse].sort((a,b) => isKrdShort ? b[krdKeyToFix] - a[krdKeyToFix] : a[krdKeyToFix] - b[krdKeyToFix]).slice(0, TOP_N_CANDIDATES);
            }

            // Find best trade pair using scoring
            let bestPair: { sell: ProposedTrade, buy: ProposedTrade, afterPortfolio: Portfolio, score: number } | null = null;

            for (const sellBond of sellCandidates) {
                for (const buyBond of buyCandidates) {
                    const tradeAmount = Math.min(tradeSizeIncrement, maxTradeValue - totalTradedValue, sellBond.marketValue);
                    if (tradeAmount < MIN_TRADE_SIZE) continue;

                    const sellTrade = createTradeObject('SELL', sellBond, tradeAmount, pairIdCounter);
                    const buyTrade = createTradeObject('BUY', buyBond, tradeAmount, pairIdCounter);

                    const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                    const tempPortfolio = calculatePortfolioMetrics(tempBonds);

                    const newDurGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                    const newTE = calculateTrackingError(tempPortfolio, benchmark);
                    
                    const durGapImprovement = Math.abs(currentDurationGap) - Math.abs(newDurGap);
                    const teImprovement = currentTE - newTE;
                    const yieldDrop = Math.max(0, currentPortfolio.averageYield - tempPortfolio.averageYield); // Only penalize drops
                    
                    const score = (100 * durGapImprovement) + (2 * teImprovement) - (50 * yieldDrop);

                    if (bestPair === null || score > bestPair.score) {
                        bestPair = { sell: sellTrade, buy: buyTrade, afterPortfolio: tempPortfolio, score };
                    }
                }
            }

            if (bestPair && bestPair.score > 0) {
                proposedTrades.push(bestPair.sell, bestPair.buy);
                totalTradedValue += bestPair.sell.marketValue;
                currentPortfolio = bestPair.afterPortfolio;
                currentBonds = [...currentPortfolio.bonds];
                
                eligibleToSell = eligibleToSell.filter(b => b.isin !== bestPair!.sell.isin);
                buyUniverse = buyUniverse.filter(b => b.isin !== bestPair!.buy.isin);
                pairIdCounter++;
            } else {
                rationaleSteps.push("Halted: No further beneficial trades found that satisfy all constraints.");
                break;
            }
            iterations++;
        }
    } 
    else if (mode === 'sell-only') {
        const cashToRaise = params.cashToRaise || 0;
        let cashRaised = 0;
        let iterations = 0;
        rationaleSteps.push(`Goal: Raise ${formatCurrency(cashToRaise, 0, 0)} cash while minimizing risk.`);

        while(cashRaised < cashToRaise && iterations < MAX_ITERATIONS && eligibleToSell.length > 0) {
            let bestSale: { trade: ProposedTrade, afterPortfolio: Portfolio, score: number } | null = null;
            
            // Prioritize selling bonds with lowest duration impact first
            const sellCandidates = [...eligibleToSell].sort((a,b) => a.modifiedDuration - b.modifiedDuration).slice(0, TOP_N_CANDIDATES);

            for (const bondToSell of sellCandidates) {
                const tradeAmount = Math.min(bondToSell.marketValue, cashToRaise - cashRaised, cashToRaise/5);
                if (tradeAmount < MIN_TRADE_SIZE) continue;

                const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount, pairIdCounter);
                const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade], bondMasterData);
                const tempPortfolio = calculatePortfolioMetrics(tempBonds);

                const teIncrease = calculateTrackingError(tempPortfolio, benchmark) - calculateTrackingError(currentPortfolio, benchmark);
                const yieldDrop = Math.max(0, currentPortfolio.averageYield - tempPortfolio.averageYield);
                
                // Score seeks to minimize damage (lower score is better)
                const score = (2 * teIncrease) + (50 * yieldDrop);
                
                if(bestSale === null || score < bestSale.score) {
                    bestSale = { trade: sellTrade, afterPortfolio: tempPortfolio, score };
                }
            }

            if(bestSale) {
                proposedTrades.push(bestSale.trade);
                cashRaised += bestSale.trade.marketValue;
                currentPortfolio = bestSale.afterPortfolio;
                currentBonds = [...currentPortfolio.bonds];

                eligibleToSell = eligibleToSell.filter(b => b.isin !== bestSale!.trade.isin);
                pairIdCounter++;
            } else {
                 rationaleSteps.push("Halted: No further sales possible without negatively impacting risk/yield profile.");
                 break;
            }
            iterations++;
        }
    }
    else if (mode === 'buy-only') {
        const cashToInvest = (maxTurnover / 100) * initialPortfolio.totalMarketValue;
        let cashSpent = 0;
        let iterations = 0;
        const tradeSizeIncrement = Math.max(cashToInvest / 10, MIN_TRADE_SIZE * 5);
        
        while(cashSpent < cashToInvest && iterations < MAX_ITERATIONS && buyUniverse.length > 0) {
            const currentDurationGap = currentPortfolio.modifiedDuration - benchmark.modifiedDuration;
            const currentTE = calculateTrackingError(currentPortfolio, benchmark);
            const isDurationGapBreached = currentDurationGap < -params.maxDurationShortfall || currentDurationGap > params.maxDurationSurplus;
            
            let buyCandidates: (Bond & {isin: string})[];
            if (isDurationGapBreached) {
                 rationaleSteps.push(`Goal: Fix duration gap of ${currentDurationGap.toFixed(2)} yrs with new cash.`);
                const isPortfolioShort = currentDurationGap < 0;
                buyCandidates = [...buyUniverse].sort((a,b) => isPortfolioShort ? b.modifiedDuration - a.modifiedDuration : a.modifiedDuration - b.modifiedDuration).slice(0, TOP_N_CANDIDATES);
            } else {
                 const krdGaps = KRD_TENORS.map(t => ({ tenor: t, gap: currentPortfolio[`krd_${t}`] - benchmark[`krd_${t}`] })).sort((a,b) => Math.abs(b.gap) - Math.abs(a.gap));
                 const largestGap = krdGaps[0];
                 rationaleSteps.push(`Goal: Reduce TE with new cash by targeting ${largestGap.tenor} KRD gap.`);
                 const krdKeyToFix: KrdKey = `krd_${largestGap.tenor}`;
                 const isKrdShort = largestGap.gap < 0;
                 buyCandidates = [...buyUniverse].sort((a,b) => isKrdShort ? b[krdKeyToFix] - a[krdKeyToFix] : a[krdKeyToFix] - b[krdKeyToFix]).slice(0, TOP_N_CANDIDATES);
            }
            
            let bestBuy: { trade: ProposedTrade, afterPortfolio: Portfolio, score: number } | null = null;
            for(const bondToBuy of buyCandidates) {
                const tradeAmount = Math.min(tradeSizeIncrement, cashToInvest - cashSpent);
                if (tradeAmount < MIN_TRADE_SIZE) continue;

                const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, pairIdCounter);
                const tempBonds = applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData);
                const tempPortfolio = calculatePortfolioMetrics(tempBonds);
                
                const newDurGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                const newTE = calculateTrackingError(tempPortfolio, benchmark);
                
                const durGapImprovement = Math.abs(currentDurationGap) - Math.abs(newDurGap);
                const teImprovement = currentTE - newTE;
                const yieldDrop = Math.max(0, currentPortfolio.averageYield - tempPortfolio.averageYield);
                
                const score = (100 * durGapImprovement) + (2 * teImprovement) - (50 * yieldDrop);
                
                if(bestBuy === null || score > bestBuy.score) {
                    bestBuy = { trade: buyTrade, afterPortfolio: tempPortfolio, score };
                }
            }

            if(bestBuy && bestBuy.score > 0) {
                proposedTrades.push(bestBuy.trade);
                cashSpent += bestBuy.trade.marketValue;
                currentPortfolio = bestBuy.afterPortfolio;
                currentBonds = [...currentPortfolio.bonds];

                buyUniverse = buyUniverse.filter(b => b.isin !== bestBuy!.trade.isin);
                pairIdCounter++;
            } else {
                 rationaleSteps.push("Halted: No further beneficial buys found that satisfy all constraints.");
                 break;
            }
            iterations++;
        }
    }

    // --- 3. FINALIZATION ---
    if (proposedTrades.length === 0) {
        return emptyResult("Portfolio is already optimal given the constraints, or no suitable trades were found in the universe.");
    }
    
    const finalPortfolio = calculatePortfolioMetrics(currentBonds);
    const afterMetrics = calculateImpactMetrics(finalPortfolio, benchmark);
    
    const finalTradedValue = proposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
    const estimatedFeeCost = (mode === 'switch' ? finalTradedValue / 2 : finalTradedValue) * (transactionCost / 10000);
    const estimatedSpreadCost = proposedTrades.reduce((sum, trade) => sum + trade.spreadCost, 0);
    const estimatedCost = estimatedFeeCost + estimatedSpreadCost;

    const uniqueRationale = [...new Set(rationaleSteps.filter(s => s.startsWith("Goal:") || s.startsWith("Halted:")))].join(' ');
    
    const aggregateFeeBps = proposedTrades.length * transactionCost;

    return {
        proposedTrades,
        impactAnalysis: { before: beforeMetrics, after: afterMetrics },
        estimatedCost,
        estimatedFeeCost,
        estimatedSpreadCost,
        estimatedCostBpsOfNav: initialPortfolio.totalMarketValue > 0 ? (estimatedCost / initialPortfolio.totalMarketValue) * 10000 : 0,
        aggregateFeeBps,
        rationale: uniqueRationale,
    };
};