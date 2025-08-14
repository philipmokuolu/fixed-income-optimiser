import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, KrdKey, KRD_TENORS, Bond, ProposedTrade, BondStaticData, ImpactMetrics } from '@/types';
import { calculatePortfolioMetrics, applyTradesToPortfolio, calculateTrackingError } from './portfolioService';
import { formatCurrency } from '@/utils/formatting';

const MIN_TRADE_SIZE = 1000; // Minimum trade size in currency to be considered

const RATING_SCALE: { [key: string]: number } = {
  'AAA': 1, 'AA+': 2, 'AA': 3, 'AA-': 4,
  'A+': 5, 'A': 6, 'A-': 7,
  'BBB+': 8, 'BBB': 9, 'BBB-': 10,
  'BB+': 11, 'BB': 12, 'BB-': 13,
  'B+': 14, 'B': 15, 'B-': 16,
  'CCC+': 17, 'CCC': 18, 'CCC-': 19,
  'CC': 20, 'C': 21, 'D': 22
};

const parseMaturityDate = (dateStr: string): Date => {
  const parts = dateStr.split(/[\/-]/); // Handles 'YYYY-MM-DD' and 'MM/DD/YYYY'
  if (parts.length === 3) {
      let year = parseInt(parts[2], 10);
      let month = parseInt(parts[0], 10) - 1;
      let day = parseInt(parts[1], 10);

      // Handle YYYY-MM-DD format
      if (parts[0].length === 4) {
          year = parseInt(parts[0], 10);
          month = parseInt(parts[1], 10) - 1;
          day = parseInt(parts[2], 10);
      }
      
      // Handle two-digit years (e.g., '48' -> 2048)
      if (year < 100) {
          year += (year < 70) ? 2000 : 1900; // Pivot year is '70
      }
      return new Date(year, month, day);
  }
  return new Date(dateStr); // Fallback
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
    // Cost of crossing half the spread: Notional * (Spread_in_Price_Terms / 100) / 2
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

    const beforeMetrics = calculateImpactMetrics(initialPortfolio, benchmark);
    const { maxDurationShortfall, maxDurationSurplus, mode, maxTurnover, transactionCost, minimumYield } = params;
    const MAX_ITERATIONS = 50; // Safety break for loops

    const emptyResult = (rationale: string) => ({
        proposedTrades: [],
        impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
        estimatedCost: 0, estimatedFeeCost: 0, estimatedSpreadCost: 0, estimatedCostBpsOfNav: 0, aggregateFeeBps: 0,
        rationale,
    });

    // --- SETUP ---
    let currentBonds = [...initialPortfolio.bonds];
    let currentPortfolio = { ...initialPortfolio };
    const proposedTrades: ProposedTrade[] = [];
    const rationaleSteps: string[] = [];
    const portfolioIsins = new Set(initialPortfolio.bonds.map(b => b.isin));
    
    let buyUniverse = Object.entries(bondMasterData)
        .filter(([isin]) => !portfolioIsins.has(isin))
        .map(([isin, staticData]) => ({ ...staticData, isin } as (Bond & {isin: string})))
        .filter(bond => {
            // Maturity filter using robust date parsing
            const today = new Date();
            const maturityDate = parseMaturityDate(bond.maturityDate);
            const yearsToMaturity = (maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
            if (yearsToMaturity > params.investmentHorizonLimit) {
                return false;
            }
            
            // Rating filter
            const minRatingValue = RATING_SCALE[params.minimumPurchaseRating];
            const bondRatingValue = RATING_SCALE[bond.creditRating];
            if (!minRatingValue || !bondRatingValue || bondRatingValue > minRatingValue) {
                return false;
            }
            return true;
        })
        .sort((a, b) => a.modifiedDuration - b.modifiedDuration); // Sorted low to high duration
    
    let eligibleToSell = initialPortfolio.bonds.filter(b => !params.excludedBonds.includes(b.isin)).sort((a, b) => a.modifiedDuration - b.modifiedDuration);
    
    const checkYieldConstraint = (tempPortfolio: Portfolio, currentAvgYield: number): boolean => {
        const targetYield = minimumYield || 0;
        const initialYield = beforeMetrics.yield;

        if (targetYield > initialYield) { // Goal is to IMPROVE yield
            return tempPortfolio.averageYield >= currentAvgYield;
        } else { // Goal is to MAINTAIN yield
            return tempPortfolio.averageYield >= targetYield;
        }
    };


    // --- MODE: SELL ONLY ---
    if (mode === 'sell-only') {
        const cashToRaise = params.cashToRaise || 0;
        let cashRaised = 0;
        let iterations = 0;
        
        while (cashRaised < cashToRaise && eligibleToSell.length > 0 && iterations < MAX_ITERATIONS) {
            const tradeAmount = Math.min(cashToRaise / 5, cashToRaise - cashRaised); // Raise in 5 increments or remaining amount
            if (tradeAmount < MIN_TRADE_SIZE) break;

            let bestSafeSale: { trade: ProposedTrade, bond: Bond, te: number } | null = null;
            let leastBadSale: { trade: ProposedTrade, bond: Bond, te: number } | null = null;
            
            // Find the best bond to sell
            for (const bondToSell of eligibleToSell) {
                if(bondToSell.marketValue < tradeAmount) continue; // can't sell more than we have

                const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount, iterations);
                const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade], bondMasterData);
                const tempPortfolio = calculatePortfolioMetrics(tempBonds);
                
                if (!checkYieldConstraint(tempPortfolio, currentPortfolio.averageYield)) continue;

                const tempTE = calculateTrackingError(tempPortfolio, benchmark);
                const tempDurationGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                
                // Track the absolute best TE regardless of constraints
                if(leastBadSale === null || tempTE < leastBadSale.te) {
                    leastBadSale = { trade: sellTrade, bond: bondToSell, te: tempTE };
                }

                // We prefer sales that don't breach duration limits
                if (tempDurationGap > -maxDurationShortfall && tempDurationGap < maxDurationSurplus) {
                    if (bestSafeSale === null || tempTE < bestSafeSale.te) {
                        bestSafeSale = { trade: sellTrade, bond: bondToSell, te: tempTE };
                    }
                }
            }
            
            const saleToExecute = bestSafeSale || leastBadSale;

            if (saleToExecute) {
                if (!bestSafeSale && leastBadSale) {
                    rationaleSteps.push(`Note: A duration limit was breached to meet the cash target. The sale with the lowest TE impact was chosen.`);
                }
                proposedTrades.push(saleToExecute.trade);
                cashRaised += saleToExecute.trade.marketValue;
                currentBonds = applyTradesToPortfolio(currentBonds, [saleToExecute.trade], bondMasterData);
                currentPortfolio = calculatePortfolioMetrics(currentBonds);
                // Make bond ineligible for next iteration to ensure diversity of sales
                eligibleToSell = eligibleToSell.filter(b => b.isin !== saleToExecute!.bond.isin);
                if (!rationaleSteps.length) rationaleSteps.push(`Objective: Raise ${formatCurrency(cashToRaise,0,0)} cash.`);
            } else {
                rationaleSteps.push("Halted: No further sales possible without breaching the yield constraint.");
                break;
            }
            iterations++;
        }
        if (iterations > 0 && !rationaleSteps.some(s => s.startsWith("Note:"))) rationaleSteps.push(`Raised ${formatCurrency(cashRaised,0,0)} by selling bonds with the least impact on tracking error within constraints.`);
    }

    // --- MODE: BUY ONLY ---
    else if (mode === 'buy-only') {
        const cashToInvest = (maxTurnover / 100) * initialPortfolio.totalMarketValue;
        let cashSpent = 0;
        let durationGap = beforeMetrics.durationGap;
        let iterations = 0;
        
        // PHASE 1 (Buy-Only): Correct Duration Gap
        while (
            (durationGap < -maxDurationShortfall || durationGap > maxDurationSurplus) &&
            cashSpent < cashToInvest &&
            iterations < MAX_ITERATIONS &&
            buyUniverse.length > 0
        ) {
            const isPortfolioShort = durationGap < -maxDurationShortfall; // Needs more duration
            
            const bondToBuy = isPortfolioShort 
                ? buyUniverse[buyUniverse.length - 1] // buy highest duration
                : buyUniverse[0]; // buy lowest duration

            if (!isPortfolioShort && bondToBuy.modifiedDuration > currentPortfolio.modifiedDuration) {
                rationaleSteps.push(`Halted duration correction: Lowest duration bond available (${bondToBuy.modifiedDuration.toFixed(2)}) is still higher than the portfolio's average (${currentPortfolio.modifiedDuration.toFixed(2)}), so buying it would worsen the gap.`);
                break;
            }

            const tradeAmount = Math.min(cashToInvest / 10, cashToInvest - cashSpent); // Spend in 10% increments
            if (tradeAmount < MIN_TRADE_SIZE) break;

            const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, iterations);

            // Check yield constraint before applying
            const tempBonds = applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData);
            const tempPortfolio = calculatePortfolioMetrics(tempBonds);
            if (!checkYieldConstraint(tempPortfolio, currentPortfolio.averageYield)) {
                rationaleSteps.push(`Skipped buying ${bondToBuy.isin} as it would not meet yield objective.`);
                buyUniverse = buyUniverse.filter(b => b.isin !== bondToBuy.isin); // don't try this bond again
                continue;
            }

            proposedTrades.push(buyTrade);
            cashSpent += tradeAmount;
            
            currentBonds = tempBonds;
            currentPortfolio = tempPortfolio;
            durationGap = currentPortfolio.modifiedDuration - benchmark.modifiedDuration;

            buyUniverse = buyUniverse.filter(b => b.isin !== bondToBuy.isin);
            iterations++;
        }
        
        if (iterations > 0) rationaleSteps.push(`Phase 1: Deployed ${formatCurrency(cashSpent,0,0)} of new capital to adjust duration gap from ${beforeMetrics.durationGap.toFixed(2)} to ${durationGap.toFixed(2)} yrs.`);

        // PHASE 2 (Buy-Only): Minimize Tracking Error with remaining cash
        const cashRemaining = cashToInvest - cashSpent;
        if (cashRemaining > MIN_TRADE_SIZE && buyUniverse.length > 0) {
            let teCashSpent = 0;
            let teIterations = 0;
            while(teCashSpent < cashRemaining && teIterations < MAX_ITERATIONS && buyUniverse.length > 0) {
                const krdGaps = KRD_TENORS.map(t => ({ tenor: t, gap: currentPortfolio[`krd_${t}`] - benchmark[`krd_${t}`] })).sort((a,b) => Math.abs(b.gap) - Math.abs(a.gap));
                const largestGap = krdGaps[0];
                if (!largestGap || Math.abs(largestGap.gap) < 0.01) break;

                const krdKeyToFix: KrdKey = `krd_${largestGap.tenor}`;
                const isKrdShort = largestGap.gap < 0; // if true, we need to buy a bond with high KRD for this tenor

                const buyCandidates = [...buyUniverse].sort((a,b) => isKrdShort ? b[krdKeyToFix] - a[krdKeyToFix] : a[krdKeyToFix] - b[krdKeyToFix]);

                let bestSafeBuy: { trade: ProposedTrade, bond: (Bond & {isin: string}) } | null = null;
                for (const bondToBuy of buyCandidates) {
                     const tradeAmount = Math.min(cashRemaining / 10, cashRemaining - teCashSpent);
                     if (tradeAmount < MIN_TRADE_SIZE) continue;

                     const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, MAX_ITERATIONS + teIterations);
                     const tempBonds = applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData);
                     const tempPortfolio = calculatePortfolioMetrics(tempBonds);

                     if (!checkYieldConstraint(tempPortfolio, currentPortfolio.averageYield)) continue;

                     const tempDurationGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                     if (tempDurationGap >= -maxDurationShortfall && tempDurationGap <= maxDurationSurplus) {
                         bestSafeBuy = { trade: buyTrade, bond: bondToBuy };
                         break;
                     }
                }

                if (bestSafeBuy) {
                    proposedTrades.push(bestSafeBuy.trade);
                    teCashSpent += bestSafeBuy.trade.marketValue;
                    currentBonds = applyTradesToPortfolio(currentBonds, [bestSafeBuy.trade], bondMasterData);
                    currentPortfolio = calculatePortfolioMetrics(currentBonds);
                    buyUniverse = buyUniverse.filter(b => b.isin !== bestSafeBuy!.bond.isin);
                    if (!rationaleSteps.some(s => s.startsWith("Phase 2:"))) rationaleSteps.push(`Phase 2: Began using remaining ${formatCurrency(cashRemaining,0,0)} to reduce tracking error.`);
                } else {
                    if (!rationaleSteps.some(s => s.startsWith("Phase 2:"))) rationaleSteps.push("Phase 2: No safe trades found to reduce tracking error with remaining capital.");
                    break;
                }
                teIterations++;
            }
        }
    }
    // --- MODE: SWITCH TRADES ---
    else if (mode === 'switch') {
        let totalTradedValue = 0;
        const maxTradeValue = (maxTurnover / 100) * initialPortfolio.totalMarketValue;
        const tradeSizeIncrement = maxTradeValue / 10; // Make 10 small trades up to max turnover
        
        let durationGap = beforeMetrics.durationGap;
        let iterations = 0;

        // PHASE 1 (Switch): Correct Duration Gap
        while (
            (durationGap < -maxDurationShortfall || durationGap > maxDurationSurplus) &&
            totalTradedValue < maxTradeValue &&
            iterations < MAX_ITERATIONS &&
            eligibleToSell.length > 0 && buyUniverse.length > 0
        ) {
            const isPortfolioShort = durationGap < -maxDurationShortfall;
            const bondToSell = isPortfolioShort ? eligibleToSell[0] : eligibleToSell[eligibleToSell.length - 1];
            const bondToBuy = isPortfolioShort ? buyUniverse[buyUniverse.length - 1] : buyUniverse[0];

            if (!bondToSell || !bondToBuy) { rationaleSteps.push("Halted duration correction: no suitable buy/sell pair found."); break; }
            
            const tradeAmount = Math.min(tradeSizeIncrement, maxTradeValue - totalTradedValue, bondToSell.marketValue);
            if (tradeAmount < MIN_TRADE_SIZE) { rationaleSteps.push("Halted: next trade size below minimum."); break; }
            
            const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount, iterations);
            const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, iterations);
            
            const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
            const tempPortfolio = calculatePortfolioMetrics(tempBonds);

            if (!checkYieldConstraint(tempPortfolio, currentPortfolio.averageYield)) {
                rationaleSteps.push(`Skipped trade pair ${bondToSell.isin}/${bondToBuy.isin} as it would not meet yield objective.`);
                buyUniverse = buyUniverse.filter(b => b.isin !== bondToBuy.isin); // Invalidate this buy bond for now
                eligibleToSell = eligibleToSell.filter(b => b.isin !== bondToSell.isin); // Try a different sell bond
                continue; // try another pair
            }
            
            proposedTrades.push(sellTrade, buyTrade);
            totalTradedValue += tradeAmount; // In switch mode, turnover is one-sided
            
            currentBonds = tempBonds;
            currentPortfolio = tempPortfolio;
            durationGap = currentPortfolio.modifiedDuration - benchmark.modifiedDuration;

            eligibleToSell = eligibleToSell.filter(b => b.isin !== bondToSell.isin);
            buyUniverse = buyUniverse.filter(b => b.isin !== bondToBuy.isin);
            iterations++;
        }
        
        if (iterations > 0) rationaleSteps.push(`Phase 1: Corrected duration gap from ${beforeMetrics.durationGap.toFixed(2)} to ${durationGap.toFixed(2)} yrs.`);

        // PHASE 2 (Switch): Minimize Tracking Error
        let teIterations = 0;
        while (totalTradedValue < maxTradeValue && teIterations < MAX_ITERATIONS && eligibleToSell.length > 0 && buyUniverse.length > 0) {
            const krdGaps = KRD_TENORS.map(t => ({ tenor: t, gap: currentPortfolio[`krd_${t}`] - benchmark[`krd_${t}`] })).sort((a,b) => Math.abs(b.gap) - Math.abs(a.gap));
            const largestGap = krdGaps[0];
            if (!largestGap || Math.abs(largestGap.gap) < 0.01) { if (!rationaleSteps.some(s => s.startsWith("Phase 2"))) rationaleSteps.push("Phase 2: KRD gaps are already minimal."); break; }

            const krdKeyToFix: KrdKey = `krd_${largestGap.tenor}`;
            const isKrdShort = largestGap.gap < 0;

            const sellCandidates = [...eligibleToSell].sort((a, b) => isKrdShort ? a[krdKeyToFix] - b[krdKeyToFix] : b[krdKeyToFix] - a[krdKeyToFix]);
            const buyCandidates = [...buyUniverse].sort((a, b) => isKrdShort ? b[krdKeyToFix] - a[krdKeyToFix] : a[krdKeyToFix] - b[krdKeyToFix]);

            let bestTradePair: { sellTrade: ProposedTrade, buyTrade: ProposedTrade, sellBond: Bond, buyBond: (Bond & {isin: string})} | null = null;
            for (const bondToSell of sellCandidates) {
                for (const bondToBuy of buyCandidates) {
                    const tradeAmount = Math.min(tradeSizeIncrement, maxTradeValue - totalTradedValue, bondToSell.marketValue);
                    if (tradeAmount < MIN_TRADE_SIZE) continue;

                    const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount, MAX_ITERATIONS + teIterations);
                    const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, MAX_ITERATIONS + teIterations);
                    
                    const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                    const tempPortfolio = calculatePortfolioMetrics(tempBonds);

                    if (!checkYieldConstraint(tempPortfolio, currentPortfolio.averageYield)) continue;

                    const tempDurationGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                    if (tempDurationGap >= -maxDurationShortfall && tempDurationGap <= maxDurationSurplus) {
                        bestTradePair = { sellTrade, buyTrade, sellBond: bondToSell, buyBond: bondToBuy };
                        break;
                    }
                }
                if (bestTradePair) break;
            }

            if (bestTradePair) {
                proposedTrades.push(bestTradePair.sellTrade, bestTradePair.buyTrade);
                totalTradedValue += bestTradePair.sellTrade.marketValue;
                currentBonds = applyTradesToPortfolio(currentBonds, [bestTradePair.sellTrade, bestTradePair.buyTrade], bondMasterData);
                currentPortfolio = calculatePortfolioMetrics(currentBonds);
                eligibleToSell = eligibleToSell.filter(b => b.isin !== bestTradePair!.sellBond.isin);
                buyUniverse = buyUniverse.filter(b => b.isin !== bestTradePair!.buyBond.isin);
                if (!rationaleSteps.some(s => s.startsWith("Phase 2:"))) rationaleSteps.push(`Phase 2: Began reducing tracking error by targeting the ${largestGap.tenor} KRD gap.`);
            } else {
                if (!rationaleSteps.some(s => s.includes("Began reducing tracking error"))) rationaleSteps.push("Phase 2: No further safe trades found to reduce tracking error.");
                break;
            }
            teIterations++;
        }
    }
    
    // --- FINALIZATION ---
    if (proposedTrades.length === 0) {
        return emptyResult("Portfolio is already optimal given the constraints. No suitable trades found in the universe.");
    }

    const finalPortfolio = calculatePortfolioMetrics(currentBonds);
    const afterMetrics = calculateImpactMetrics(finalPortfolio, benchmark);
    
    const finalTradedValue = proposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
    const estimatedFeeCost = finalTradedValue * (transactionCost / 10000);
    const estimatedSpreadCost = proposedTrades.reduce((sum, trade) => sum + trade.spreadCost, 0);
    const estimatedCost = estimatedFeeCost + estimatedSpreadCost;

    let finalRationale = rationaleSteps.join(' ');
    if (finalRationale.trim() === '') {
        finalRationale = 'Trades were proposed to bring the portfolio closer to benchmark characteristics.';
    }

    return {
        proposedTrades,
        impactAnalysis: { before: beforeMetrics, after: afterMetrics },
        estimatedCost,
        estimatedFeeCost,
        estimatedSpreadCost,
        estimatedCostBpsOfNav: initialPortfolio.totalMarketValue > 0 ? (estimatedCost / finalPortfolio.totalMarketValue) * 10000 : 0,
        aggregateFeeBps: transactionCost * proposedTrades.length,
        rationale: finalRationale,
    };
};