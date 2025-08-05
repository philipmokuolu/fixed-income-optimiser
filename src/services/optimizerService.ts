import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, KrdKey, KRD_TENORS, Bond, ProposedTrade, BondStaticData, ImpactMetrics } from '@/types';
import { calculatePortfolioMetrics, calculateTrackingError } from './portfolioService';
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

export const calculateImpactMetrics = (portfolio: Portfolio, benchmark: Benchmark): ImpactMetrics => {
    return {
        modifiedDuration: portfolio.modifiedDuration,
        durationGap: portfolio.modifiedDuration - benchmark.modifiedDuration,
        trackingError: calculateTrackingError(portfolio, benchmark),
        yield: portfolio.averageYield,
    };
};

const createTradeObject = (action: 'BUY' | 'SELL', bond: Bond | (BondStaticData & {isin: string}), marketValue: number, pairId: number): ProposedTrade => {
    const notional = marketValue / (bond.price / 100);
    return {
        action,
        isin: bond.isin,
        name: bond.name,
        notional,
        marketValue,
        price: bond.price,
        modifiedDuration: bond.modifiedDuration,
        yieldToMaturity: bond.yieldToMaturity,
        creditRating: bond.creditRating,
        pairId,
    };
};

// Helper to apply trades and return the new portfolio state
export const applyTradesToPortfolio = (
    currentBonds: Bond[], 
    tradesToApply: ProposedTrade[],
    bondMasterData: Record<string, BondStaticData>
): Bond[] => {
    const newBondsMap = new Map<string, Bond>();
    currentBonds.forEach(bond => newBondsMap.set(bond.isin, { ...bond }));

    tradesToApply.forEach(trade => {
       if(trade.action === 'SELL') {
            const existing = newBondsMap.get(trade.isin);
            if (!existing) {
                console.warn(`Attempted to SELL ${trade.isin} which is not in the current portfolio state. Skipping.`);
                return;
            }
            const newMarketValue = existing.marketValue - trade.marketValue;
            if (newMarketValue < MIN_TRADE_SIZE) {
                newBondsMap.delete(trade.isin);
            } else {
                existing.marketValue = newMarketValue;
                existing.notional = newMarketValue / (existing.price / 100);
            }
       } else { // BUY
            if (newBondsMap.has(trade.isin)) {
                const existing = newBondsMap.get(trade.isin);
                if (!existing) return; // Should not happen due to .has() check, but for safety.
                existing.marketValue += trade.marketValue;
                existing.notional = existing.marketValue / (existing.price / 100);
            } else {
                 const bondData = bondMasterData[trade.isin];
                 if (!bondData) {
                    console.warn(`Cannot apply BUY trade for ISIN ${trade.isin}: Bond master data not found. Skipping trade.`);
                    return; 
                 }
                 newBondsMap.set(trade.isin, {
                    ...bondData,
                    isin: trade.isin,
                    notional: trade.notional,
                    marketValue: trade.marketValue,
                    portfolioWeight: 0, 
                    durationContribution: 0,
                 });
            }
       }
    });
    
    // Recalculate metrics for the new set of bonds
    const finalBonds = Array.from(newBondsMap.values());
    const finalPortfolio = calculatePortfolioMetrics(finalBonds);
    return finalPortfolio.bonds;
}


export const runOptimizer = (
  initialPortfolio: Portfolio,
  benchmark: Benchmark,
  params: OptimizationParams,
  bondMasterData: Record<string, BondStaticData>
): OptimizationResult => {

    const beforeMetrics = calculateImpactMetrics(initialPortfolio, benchmark);
    const { maxDurationShortfall, maxDurationSurplus, mode, maxTurnover, transactionCost } = params;
    const MAX_ITERATIONS = 50; // Safety break for loops

    const emptyResult = (rationale: string) => ({
        proposedTrades: [],
        impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
        estimatedCost: 0, estimatedCostBpsOfNav: 0, estimatedCostBpsPerTradeSum: 0,
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
        .map(([isin, staticData]) => ({ ...staticData, isin } as (BondStaticData & {isin: string})))
        .filter(bond => {
            // Maturity filter
            const limit = params.investmentHorizonLimit;
            const today = new Date();
            const maturityDate = new Date(bond.maturityDate);
            const yearsToMaturity = (maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
            
            // Exclude if limit is invalid, maturity is invalid, or maturity exceeds limit.
            if (isNaN(limit) || isNaN(yearsToMaturity) || yearsToMaturity > limit) {
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
    
    // --- MODE: BUY ONLY ---
    if (mode === 'buy-only') {
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

            // Edge Case: If trying to shorten duration, but the lowest duration bond available is still longer than the portfolio's average, stop.
            if (!isPortfolioShort && bondToBuy.modifiedDuration > currentPortfolio.modifiedDuration) {
                rationaleSteps.push(`Halted duration correction: Lowest duration bond available (${bondToBuy.modifiedDuration.toFixed(2)}) is still higher than the portfolio's average (${currentPortfolio.modifiedDuration.toFixed(2)}), so buying it would worsen the gap.`);
                break;
            }

            const tradeAmount = Math.min(cashToInvest / 10, cashToInvest - cashSpent); // Spend in 10% increments
            if (tradeAmount < MIN_TRADE_SIZE) break;

            const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, iterations);
            proposedTrades.push(buyTrade);
            cashSpent += tradeAmount;
            
            currentBonds = applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData);
            currentPortfolio = calculatePortfolioMetrics(currentBonds);
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
                // Find best bond to fix largest KRD gap
                const krdGaps = KRD_TENORS.map(t => ({ tenor: t, gap: currentPortfolio[`krd_${t}`] - benchmark[`krd_${t}`] })).sort((a,b) => Math.abs(b.gap) - Math.abs(a.gap));
                const largestGap = krdGaps[0];
                if (!largestGap || Math.abs(largestGap.gap) < 0.01) break;

                const krdKeyToFix: KrdKey = `krd_${largestGap.tenor}`;
                const isKrdShort = largestGap.gap < 0; // if true, we need to buy a bond with high KRD for this tenor

                const buyCandidates = [...buyUniverse].sort((a,b) => isKrdShort ? b[krdKeyToFix] - a[krdKeyToFix] : a[krdKeyToFix] - b[krdKeyToFix]);

                let bestSafeBuy: { trade: ProposedTrade, bond: (BondStaticData & {isin: string}) } | null = null;
                for (const bondToBuy of buyCandidates) {
                     const tradeAmount = Math.min(cashRemaining / 10, cashRemaining - teCashSpent);
                     if (tradeAmount < MIN_TRADE_SIZE) continue;

                     const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, MAX_ITERATIONS + teIterations);
                     const tempBonds = applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData);
                     const tempPortfolio = calculatePortfolioMetrics(tempBonds);
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
        let eligibleToSell = initialPortfolio.bonds.filter(b => !params.excludedBonds.includes(b.isin)).sort((a, b) => a.modifiedDuration - b.modifiedDuration);

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
            proposedTrades.push(sellTrade, buyTrade);
            totalTradedValue += tradeAmount; // In switch mode, turnover is one-sided
            
            currentBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
            currentPortfolio = calculatePortfolioMetrics(currentBonds);
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

            let bestTradePair: { sellTrade: ProposedTrade, buyTrade: ProposedTrade, sellBond: Bond, buyBond: (BondStaticData & {isin: string})} | null = null;
            for (const bondToSell of sellCandidates) {
                for (const bondToBuy of buyCandidates) {
                    const tradeAmount = Math.min(tradeSizeIncrement, maxTradeValue - totalTradedValue, bondToSell.marketValue);
                    if (tradeAmount < MIN_TRADE_SIZE) continue;

                    const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount, MAX_ITERATIONS + teIterations);
                    const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, MAX_ITERATIONS + teIterations);
                    
                    const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                    const tempPortfolio = calculatePortfolioMetrics(tempBonds);
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
    const estimatedCost = finalTradedValue * (transactionCost / 10000);

    let finalRationale = rationaleSteps.join(' ');
    if (finalRationale.trim() === '') {
        finalRationale = 'Trades were proposed to bring the portfolio closer to benchmark characteristics.';
    }

    return {
        proposedTrades,
        impactAnalysis: { before: beforeMetrics, after: afterMetrics },
        estimatedCost,
        estimatedCostBpsOfNav: initialPortfolio.totalMarketValue > 0 ? (estimatedCost / finalPortfolio.totalMarketValue) * 10000 : 0,
        estimatedCostBpsPerTradeSum: transactionCost * proposedTrades.length,
        rationale: finalRationale,
    };
};
