import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, KrdKey, KRD_TENORS, Bond, ProposedTrade, BondStaticData, ImpactMetrics } from '@/types';
import { calculatePortfolioMetrics, calculateTrackingError } from './portfolioService';

const MIN_TRADE_SIZE = 1000; // Minimum trade size in currency to be considered

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

    const emptyResult = (rationale: string) => ({
        proposedTrades: [],
        impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
        estimatedCost: 0, estimatedCostBpsOfNav: 0, estimatedCostBpsPerTradeSum: 0,
        rationale,
    });

    if (mode === 'buy-only') {
        return emptyResult("The 'Buy Only' mode is being rebuilt for stability. Please use 'Switch Trades' for now.");
    }

    // --- SETUP ---
    let currentBonds = [...initialPortfolio.bonds];
    let currentPortfolio = { ...initialPortfolio };
    const proposedTrades: ProposedTrade[] = [];
    const maxTradeValue = (maxTurnover / 100) * initialPortfolio.totalMarketValue;
    let totalTradedValue = 0;
    const tradeSizeIncrement = maxTradeValue / 10; // Make 10 small trades up to max turnover

    let eligibleToSell = initialPortfolio.bonds
        .filter(b => !params.excludedBonds.includes(b.isin))
        .sort((a, b) => a.modifiedDuration - b.modifiedDuration); // Sorted low to high duration

    const portfolioIsins = new Set(initialPortfolio.bonds.map(b => b.isin));
    let buyUniverse = Object.entries(bondMasterData)
        .filter(([isin]) => !portfolioIsins.has(isin))
        .map(([isin, staticData]) => ({ ...staticData, isin } as (BondStaticData & {isin: string})))
        .sort((a, b) => a.modifiedDuration - b.modifiedDuration); // Sorted low to high duration

    const rationaleSteps: string[] = [];
    
    // --- PHASE 1: Correct Duration Gap ---
    const MAX_ITERATIONS = 50; // Safety break
    let iterations = 0;
    let durationGap = beforeMetrics.durationGap;

    while (
        (durationGap < -maxDurationShortfall || durationGap > maxDurationSurplus) &&
        totalTradedValue < maxTradeValue &&
        iterations < MAX_ITERATIONS
    ) {
        const isPortfolioShort = durationGap < -maxDurationShortfall; // Needs more duration
        
        const bondToSell = isPortfolioShort 
            ? eligibleToSell[0] // sell lowest duration
            : eligibleToSell[eligibleToSell.length - 1]; // sell highest duration
            
        const bondToBuy = isPortfolioShort
            ? buyUniverse[buyUniverse.length - 1] // buy highest duration
            : buyUniverse[0]; // buy lowest duration

        if (!bondToSell || !bondToBuy) {
            rationaleSteps.push("Halted duration correction: no suitable buy/sell pair found.");
            break;
        }
        
        const tradeAmount = Math.min(tradeSizeIncrement, maxTradeValue - totalTradedValue, bondToSell.marketValue);

        if (tradeAmount < MIN_TRADE_SIZE) {
             rationaleSteps.push("Halted duration correction: next trade size is below minimum.");
             break;
        }
        
        const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount, iterations);
        const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, iterations); // cash neutral
        
        proposedTrades.push(sellTrade, buyTrade);
        totalTradedValue += tradeAmount * 2;
        
        // Update state for next iteration
        currentBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
        currentPortfolio = calculatePortfolioMetrics(currentBonds);
        durationGap = currentPortfolio.modifiedDuration - benchmark.modifiedDuration;

        // Remove traded bonds from pools
        eligibleToSell = eligibleToSell.filter(b => b.isin !== bondToSell.isin);
        buyUniverse = buyUniverse.filter(b => b.isin !== bondToBuy.isin);
        
        iterations++;
    }
    
    if (iterations > 0) {
        const initialGap = beforeMetrics.durationGap;
        const finalGap = durationGap;
        rationaleSteps.push(`Phase 1: Corrected duration gap from ${initialGap.toFixed(2)} to ${finalGap.toFixed(2)} yrs.`);
    }

    // --- PHASE 2: Minimize Tracking Error ---
    let teIterations = 0;
    while (
        totalTradedValue < maxTradeValue &&
        teIterations < MAX_ITERATIONS
    ) {
        const krdGaps = KRD_TENORS.map(tenor => {
            const krdKey: KrdKey = `krd_${tenor}`;
            return {
                tenor,
                gap: currentPortfolio[krdKey] - benchmark[krdKey]
            }
        }).sort((a,b) => Math.abs(b.gap) - Math.abs(a.gap));

        const largestGap = krdGaps[0];
        if (!largestGap || Math.abs(largestGap.gap) < 0.01) { // Threshold to stop optimizing
             if (!rationaleSteps.some(s => s.startsWith("Phase 2"))) {
                rationaleSteps.push("Phase 2: KRD gaps are already minimal.");
             }
             break;
        }

        const krdKeyToFix: KrdKey = `krd_${largestGap.tenor}`;
        const isKrdShort = largestGap.gap < 0; // Portfolio has less KRD than benchmark for this tenor

        const sellCandidates = [...eligibleToSell].sort((a, b) => isKrdShort ? a[krdKeyToFix] - b[krdKeyToFix] : b[krdKeyToFix] - a[krdKeyToFix]);
        const buyCandidates = [...buyUniverse].sort((a, b) => isKrdShort ? b[krdKeyToFix] - a[krdKeyToFix] : a[krdKeyToFix] - b[krdKeyToFix]);

        let bestTrade: ProposedTrade[] | null = null;
        let bestTradePair: { sell: Bond, buy: (BondStaticData & {isin: string})} | null = null;

        // Find a safe trade
        for (const bondToSell of sellCandidates) {
            for (const bondToBuy of buyCandidates) {
                const tradeAmount = Math.min(tradeSizeIncrement, maxTradeValue - totalTradedValue, bondToSell.marketValue);
                if (tradeAmount < MIN_TRADE_SIZE) continue;

                const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount, MAX_ITERATIONS + teIterations);
                const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount, MAX_ITERATIONS + teIterations);
                
                // --- What-if check ---
                const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                const tempPortfolio = calculatePortfolioMetrics(tempBonds);
                const tempDurationGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;

                if (tempDurationGap >= -maxDurationShortfall && tempDurationGap <= maxDurationSurplus) {
                    bestTrade = [sellTrade, buyTrade];
                    bestTradePair = { sell: bondToSell, buy: bondToBuy };
                    break;
                }
            }
            if (bestTrade) break;
        }

        if (bestTrade && bestTradePair) {
            proposedTrades.push(...bestTrade);
            totalTradedValue += bestTrade[0].marketValue * 2;
            
            currentBonds = applyTradesToPortfolio(currentBonds, bestTrade, bondMasterData);
            currentPortfolio = calculatePortfolioMetrics(currentBonds);
            
            eligibleToSell = eligibleToSell.filter(b => b.isin !== bestTradePair!.sell.isin);
            buyUniverse = buyUniverse.filter(b => b.isin !== bestTradePair!.buy.isin);
            
            if (!rationaleSteps.some(s => s.startsWith("Phase 2:"))) {
                 rationaleSteps.push(`Phase 2: Began reducing tracking error by targeting the ${largestGap.tenor} KRD gap.`);
            }

        } else {
            if (!rationaleSteps.some(s => s.startsWith("Phase 2:"))) {
               rationaleSteps.push("Phase 2: No further trades possible.");
            } else if (rationaleSteps.some(s => s.includes("Began reducing tracking error"))) {
                rationaleSteps.push("Could not find any more safe trades to reduce tracking error.");
            }
            break;
        }
        teIterations++;
    }

    if (proposedTrades.length === 0) {
        return emptyResult("Portfolio is already optimal given the constraints.");
    }

    // --- FINALIZATION ---
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
        estimatedCostBpsOfNav: initialPortfolio.totalMarketValue > 0 ? (estimatedCost / initialPortfolio.totalMarketValue) * 10000 : 0,
        estimatedCostBpsPerTradeSum: transactionCost * proposedTrades.length,
        rationale: finalRationale,
    };
};