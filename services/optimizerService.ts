import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, KrdKey, KRD_TENORS, Bond, ProposedTrade, BondStaticData } from '@/types';
import { calculatePortfolioMetrics, calculateTrackingError } from './portfolioService';

const MIN_TRADE_SIZE = 1000; // Minimum trade size in currency to be considered
const MAX_ITERATIONS = 20; // Prevent infinite loops

const calculateImpactMetrics = (portfolio: Portfolio, benchmark: Benchmark) => {
    return {
        modifiedDuration: portfolio.modifiedDuration,
        durationGap: portfolio.modifiedDuration - benchmark.modifiedDuration,
        trackingError: calculateTrackingError(portfolio, benchmark),
        yield: portfolio.averageYield,
    };
};

const createTradeObject = (action: 'BUY' | 'SELL', bond: Bond | (BondStaticData & {isin: string}), marketValue: number): ProposedTrade => {
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
    };
};

// Helper to apply trades and return the new portfolio state
const applyTradesToPortfolio = (
    currentBonds: Bond[], 
    tradesToApply: ProposedTrade[],
    bondMasterData: Record<string, BondStaticData>
): Portfolio => {
    const newBondsMap = new Map<string, Bond>();
    currentBonds.forEach(bond => newBondsMap.set(bond.isin, { ...bond }));

    tradesToApply.forEach(trade => {
       if(trade.action === 'SELL') {
            const existing = newBondsMap.get(trade.isin)!;
            const newMarketValue = existing.marketValue - trade.marketValue;
            if (newMarketValue < MIN_TRADE_SIZE) {
                newBondsMap.delete(trade.isin);
            } else {
                existing.marketValue = newMarketValue;
                existing.notional = newMarketValue / (existing.price / 100);
            }
       } else { // BUY
            if (newBondsMap.has(trade.isin)) {
                const existing = newBondsMap.get(trade.isin)!;
                existing.marketValue += trade.marketValue;
                existing.notional = existing.marketValue / (existing.price / 100);
            } else {
                 const bondData = bondMasterData[trade.isin];
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
    
    return calculatePortfolioMetrics(Array.from(newBondsMap.values()));
}


export const runOptimizer = (
  initialPortfolio: Portfolio,
  benchmark: Benchmark,
  params: OptimizationParams,
  bondMasterData: Record<string, BondStaticData>
): OptimizationResult => {

    const beforeMetrics = calculateImpactMetrics(initialPortfolio, benchmark);
    const rationaleParts: string[] = [];
    const emptyResult = {
        proposedTrades: [],
        impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
        estimatedCost: 0, estimatedCostBpsOfNav: 0, estimatedCostBpsPerTradeSum: 0,
    };

    if (beforeMetrics.trackingError < 2 && Math.abs(beforeMetrics.durationGap) < params.durationGapThreshold) {
        return { ...emptyResult, rationale: "Portfolio is already well-aligned with the benchmark. No trades needed." };
    }

    let remainingTurnover = (params.maxTurnover / 100) * initialPortfolio.totalMarketValue;
    let proposedTrades: ProposedTrade[] = [];
    let currentBonds = [...initialPortfolio.bonds];
    let iterations = 0;

    const portfolioIsins = new Set(initialPortfolio.bonds.map(b => b.isin));
    const buyUniverse = Object.entries(bondMasterData)
        .filter(([isin]) => !portfolioIsins.has(isin))
        .map(([isin, staticData]) => ({ ...staticData, isin } as Bond & BondStaticData));
    
    // --- Main Optimization Loop ---
    while (remainingTurnover > MIN_TRADE_SIZE && iterations < MAX_ITERATIONS) {
        iterations++;
        const currentPortfolio = calculatePortfolioMetrics(currentBonds);
        const currentMetrics = calculateImpactMetrics(currentPortfolio, benchmark);

        const eligibleToSell = currentBonds.filter(b => !params.excludedBonds.includes(b.isin));
        if (eligibleToSell.length === 0) {
            rationaleParts.push("Halted: No eligible bonds available to sell.");
            break;
        }

        const isDurationGapBreached = Math.abs(currentMetrics.durationGap) > params.durationGapThreshold;
        
        // ** PRIMARY OBJECTIVE: Fix Duration Gap **
        if (isDurationGapBreached && params.mode === 'switch') {
            if (iterations === 1) rationaleParts.push(`Primary Objective: Correct the duration gap of ${currentMetrics.durationGap.toFixed(2)} yrs.`);
            
            const isPortfolioShort = currentMetrics.durationGap < 0;
            const tradeAmount = Math.min(remainingTurnover / 2, initialPortfolio.totalMarketValue * 0.05); // Use 5% of portfolio value per trade leg to avoid huge single trades
            
            let bondToSell: Bond | undefined;
            let bondToBuy: (BondStaticData & Bond) | undefined;

            if (isPortfolioShort) {
                bondToSell = eligibleToSell.sort((a,b) => a.modifiedDuration - b.modifiedDuration)[0];
                bondToBuy = buyUniverse.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
            } else {
                bondToSell = eligibleToSell.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
                bondToBuy = buyUniverse.sort((a,b) => a.modifiedDuration - b.modifiedDuration)[0];
            }

            if (bondToSell && bondToBuy && bondToSell.marketValue > tradeAmount) {
                const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount);
                const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount); // Cash neutral
                
                proposedTrades.push(sellTrade, buyTrade);
                currentBonds = Array.from(applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData).bonds);
                remainingTurnover -= (tradeAmount * 2);
                continue; // Re-evaluate state in next loop
            }
        }

        // ** SECONDARY OBJECTIVE: Minimize Tracking Error **
        if (iterations === 1) rationaleParts.push("Primary Objective: Minimize KRD-based tracking error while respecting duration constraints.");
        
        const krdGaps = KRD_TENORS.map(t => {
            const krdKey: KrdKey = `krd_${t}`;
            return { tenor: krdKey, gap: currentPortfolio[krdKey] - benchmark[krdKey] };
        }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
        
        const largestGap = krdGaps[0];

        if (Math.abs(largestGap.gap) < 0.01) {
            rationaleParts.push("KRDs are well-aligned. Halting further trades.");
            break; // No significant gaps to fix
        }

        const isUnderweight = largestGap.gap < 0;
        const tradeAmount = Math.min(remainingTurnover / 2, initialPortfolio.totalMarketValue * 0.025);

        if (isUnderweight) {
            // We need to BUY exposure to this tenor
            const bondToBuy = buyUniverse.sort((a, b) => b[largestGap.tenor] - a[largestGap.tenor])[0];
            if (params.mode === 'switch') {
                const otherGaps = krdGaps.filter(g => g.gap > 0);
                const largestOverweight = otherGaps.length > 0 ? otherGaps[0] : null;

                if (bondToBuy && largestOverweight) {
                    const bondToSell = eligibleToSell.sort((a, b) => b[largestOverweight.tenor] - a[largestOverweight.tenor])[0];
                    if (bondToSell && bondToSell.marketValue > tradeAmount) {
                         if (iterations < 3) rationaleParts.push(`- Reducing overweight in ${largestOverweight.tenor.replace('krd_', '')} to fund underweight in ${largestGap.tenor.replace('krd_', '')}.`);
                        const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount);
                        const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount);
                        proposedTrades.push(sellTrade, buyTrade);
                        currentBonds = Array.from(applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData).bonds);
                        remainingTurnover -= (tradeAmount * 2);
                        continue;
                    }
                }
            } else { // Buy-only mode
                 if (bondToBuy) {
                    if (iterations < 3) rationaleParts.push(`+ Increasing exposure to underweight ${largestGap.tenor.replace('krd_', '')}.`);
                    const buyTrade = createTradeObject('BUY', bondToBuy, Math.min(remainingTurnover, tradeAmount*2));
                    proposedTrades.push(buyTrade);
                    currentBonds = Array.from(applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData).bonds);
                    remainingTurnover -= buyTrade.marketValue;
                    continue;
                 }
            }
        } else { // Overweight, must sell
             if (params.mode === 'switch') {
                 const bondToSell = eligibleToSell.sort((a, b) => b[largestGap.tenor] - a[largestGap.tenor])[0];
                 const otherGaps = krdGaps.filter(g => g.gap < 0);
                 const largestUnderweight = otherGaps.length > 0 ? otherGaps[0] : null;

                 if (bondToSell && largestUnderweight && bondToSell.marketValue > tradeAmount) {
                     const bondToBuy = buyUniverse.sort((a, b) => b[largestUnderweight.tenor] - a[largestUnderweight.tenor])[0];
                     if (bondToBuy) {
                        if (iterations < 3) rationaleParts.push(`- Reducing overweight in ${largestGap.tenor.replace('krd_', '')} to fund underweight in ${largestUnderweight.tenor.replace('krd_', '')}.`);
                        const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount);
                        const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount);
                        proposedTrades.push(sellTrade, buyTrade);
                        currentBonds = Array.from(applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData).bonds);
                        remainingTurnover -= (tradeAmount * 2);
                        continue;
                     }
                 }
             }
        }
        // If no trades were made in this iteration, break to prevent infinite loops
        break;
    }

    if (proposedTrades.length === 0) {
        return { ...emptyResult, rationale: rationaleParts.length > 0 ? rationaleParts.join(' ') : "Could not find any beneficial trades." };
    }

    const afterPortfolio = calculatePortfolioMetrics(currentBonds);
    const afterMetrics = calculateImpactMetrics(afterPortfolio, benchmark);
    const totalTradedValue = proposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
    const estimatedCost = totalTradedValue * (params.transactionCost / 10000);

    return {
        proposedTrades,
        impactAnalysis: { before: beforeMetrics, after: afterMetrics },
        estimatedCost,
        estimatedCostBpsOfNav: initialPortfolio.totalMarketValue > 0 ? (estimatedCost / initialPortfolio.totalMarketValue) * 10000 : 0,
        estimatedCostBpsPerTradeSum: params.transactionCost * proposedTrades.length,
        rationale: rationaleParts.join(' '),
    };
};
