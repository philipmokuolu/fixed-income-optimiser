import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, KrdKey, KRD_TENORS, Bond, ProposedTrade, BondStaticData } from '@/types';
import { calculatePortfolioMetrics, calculateTrackingError } from './portfolioService';

const MIN_TRADE_SIZE = 1000; // Minimum trade size in currency to be considered
const MAX_ITERATIONS = 50; // Prevent infinite loops, increased for more trades

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
    const rationaleParts: string[] = [];
    const emptyResult = {
        proposedTrades: [],
        impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
        estimatedCost: 0, estimatedCostBpsOfNav: 0, estimatedCostBpsPerTradeSum: 0,
        rationale: "No trades recommended. Portfolio is optimal given constraints.",
    };

    let remainingTurnover = (params.maxTurnover / 100) * initialPortfolio.totalMarketValue;
    let proposedTrades: ProposedTrade[] = [];
    let currentBonds = [...initialPortfolio.bonds];
    let iterations = 0;

    const portfolioIsins = new Set(initialPortfolio.bonds.map(b => b.isin));
    
    // Convert to `let` so it can be updated during the optimization loop.
    let buyUniverse = Object.entries(bondMasterData)
        .filter(([isin]) => !portfolioIsins.has(isin))
        .map(([isin, staticData]) => ({ ...staticData, isin } as (BondStaticData & {isin: string})));
    
    const isInitialDurationGapBreached = beforeMetrics.durationGap < -params.maxDurationShortfall || beforeMetrics.durationGap > params.maxDurationSurplus;
    
    if (isInitialDurationGapBreached) {
        rationaleParts.push(`Primary Objective: Correct the duration gap of ${beforeMetrics.durationGap.toFixed(2)} yrs to be within (-${params.maxDurationShortfall}, +${params.maxDurationSurplus}).`);
    } else {
        rationaleParts.push("Primary Objective: Minimize KRD-based tracking error while respecting duration constraints.");
    }
    
    while (remainingTurnover > MIN_TRADE_SIZE && iterations < MAX_ITERATIONS) {
        iterations++;
        let tradeMadeInThisIteration = false;
        
        const currentPortfolio = calculatePortfolioMetrics(currentBonds);
        const currentMetrics = calculateImpactMetrics(currentPortfolio, benchmark);
        const eligibleToSell = currentBonds.filter(b => !params.excludedBonds.includes(b.isin));

        if (eligibleToSell.length === 0 && params.mode === 'switch') {
             rationaleParts.push("Halted: No eligible bonds available to sell for switch trades.");
             break;
        }
        
        const isDurationGapBreached = currentMetrics.durationGap < -params.maxDurationShortfall || currentMetrics.durationGap > params.maxDurationSurplus;
        
        // --- PRIMARY OBJECTIVE: Fix Duration Gap ---
        if (isDurationGapBreached) {
            const isPortfolioShort = currentMetrics.durationGap < 0; // e.g., -0.26 < 0 is true, need to INCREASE duration
            const idealTradeAmount = Math.min(remainingTurnover, initialPortfolio.totalMarketValue * 0.05);

            if (params.mode === 'switch') {
                let bondToSell: Bond | undefined;
                let bondToBuy: (BondStaticData & {isin: string}) | undefined;

                if (isPortfolioShort) { // Need to INCREASE duration
                    bondToSell = eligibleToSell.sort((a,b) => a.modifiedDuration - b.modifiedDuration)[0];
                    bondToBuy = buyUniverse.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
                } else { // Need to DECREASE duration
                    bondToSell = eligibleToSell.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
                    bondToBuy = buyUniverse.sort((a,b) => a.modifiedDuration - a.modifiedDuration)[0];
                }

                if (bondToSell && bondToBuy) {
                    const actualSellAmount = Math.min(idealTradeAmount / 2, bondToSell.marketValue);
                    if (actualSellAmount > MIN_TRADE_SIZE) {
                        const sellTrade = createTradeObject('SELL', bondToSell, actualSellAmount);
                        const buyTrade = createTradeObject('BUY', bondToBuy, actualSellAmount);
                        proposedTrades.push(sellTrade, buyTrade);
                        currentBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                        remainingTurnover -= (actualSellAmount * 2);
                        buyUniverse = buyUniverse.filter(b => b.isin !== buyTrade.isin);
                        tradeMadeInThisIteration = true;
                        continue;
                    }
                }
            } else { // 'buy-only' mode for duration gap
                let bondToBuy: (BondStaticData & {isin: string}) | undefined;
                 if (isPortfolioShort) { // Need to INCREASE duration
                    bondToBuy = buyUniverse.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
                } else { // Need to DECREASE duration
                    bondToBuy = buyUniverse.sort((a,b) => a.modifiedDuration - a.modifiedDuration)[0];
                }
                if (bondToBuy) {
                    const buyAmount = Math.min(idealTradeAmount, remainingTurnover);
                    if (buyAmount > MIN_TRADE_SIZE) {
                         const buyTrade = createTradeObject('BUY', bondToBuy, buyAmount);
                         proposedTrades.push(buyTrade);
                         currentBonds = applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData);
                         remainingTurnover -= buyAmount;
                         buyUniverse = buyUniverse.filter(b => b.isin !== buyTrade.isin);
                         tradeMadeInThisIteration = true;
                         continue;
                    }
                }
            }
        }

        // --- SECONDARY OBJECTIVE: Minimize Tracking Error ---
        const krdGaps = KRD_TENORS.map(t => {
            const krdKey: KrdKey = `krd_${t}`;
            return { tenor: krdKey, gap: currentPortfolio[krdKey] - benchmark[krdKey] };
        }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
        
        const largestGap = krdGaps[0];
        if (!largestGap || Math.abs(largestGap.gap) < 0.01) {
            rationaleParts.push("Halting: All significant KRD gaps have been addressed.");
            break;
        }
        
        const idealKrdTradeAmount = Math.min(remainingTurnover, initialPortfolio.totalMarketValue * 0.025);
        const isUnderweight = largestGap.gap < 0;

        if (params.mode === 'switch') {
            let bondToSell: Bond | undefined;
            let bondToBuy: (BondStaticData & {isin: string}) | undefined;
            
            if (isUnderweight) {
                bondToBuy = buyUniverse.sort((a, b) => b[largestGap.tenor] - a[largestGap.tenor])[0];
                const largestOverweight = krdGaps.find(g => g.gap > 0.01);
                if (largestOverweight) bondToSell = eligibleToSell.sort((a, b) => b[largestOverweight.tenor] - a[largestOverweight.tenor])[0];
            } else {
                 bondToSell = eligibleToSell.sort((a, b) => b[largestGap.tenor] - a[largestGap.tenor])[0];
                 const largestUnderweight = krdGaps.find(g => g.gap < -0.01);
                 if (largestUnderweight) bondToBuy = buyUniverse.sort((a, b) => b[largestUnderweight.tenor] - a[largestUnderweight.tenor])[0];
            }

            if (bondToSell && bondToBuy) {
                const actualSellAmount = Math.min(idealKrdTradeAmount / 2, bondToSell.marketValue);
                if (actualSellAmount > MIN_TRADE_SIZE) {
                    const sellTrade = createTradeObject('SELL', bondToSell, actualSellAmount);
                    const buyTrade = createTradeObject('BUY', bondToBuy, actualSellAmount);
                    
                    const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                    const tempPortfolio = calculatePortfolioMetrics(tempBonds);
                    const tempDurationGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;

                    if (tempDurationGap >= -params.maxDurationShortfall && tempDurationGap <= params.maxDurationSurplus) {
                        proposedTrades.push(sellTrade, buyTrade);
                        currentBonds = tempBonds;
                        remainingTurnover -= (actualSellAmount * 2);
                        buyUniverse = buyUniverse.filter(b => b.isin !== buyTrade.isin);
                        tradeMadeInThisIteration = true;
                    }
                }
            }
        } else { // Buy-only mode for KRDs
             if (isUnderweight) {
                 const bondToBuy = buyUniverse.sort((a, b) => b[largestGap.tenor] - a[largestGap.tenor])[0];
                 if(bondToBuy) {
                    const buyAmount = Math.min(idealKrdTradeAmount, remainingTurnover);
                    if (buyAmount > MIN_TRADE_SIZE) {
                       const buyTrade = createTradeObject('BUY', bondToBuy, buyAmount);

                       const tempBonds = applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData);
                       const tempPortfolio = calculatePortfolioMetrics(tempBonds);
                       const tempDurationGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                       
                       if (tempDurationGap >= -params.maxDurationShortfall && tempDurationGap <= params.maxDurationSurplus) {
                           proposedTrades.push(buyTrade);
                           currentBonds = tempBonds;
                           remainingTurnover -= buyAmount;
                           buyUniverse = buyUniverse.filter(b => b.isin !== buyTrade.isin);
                           tradeMadeInThisIteration = true;
                       }
                    }
                 }
             } else {
                rationaleParts.push(`Cannot fix overweight in ${largestGap.tenor} in buy-only mode.`);
             }
        }

        if (!tradeMadeInThisIteration) {
            rationaleParts.push("Halting: No further optimal trades found that satisfy all constraints.");
            break; 
        }
    }

    if (proposedTrades.length === 0) {
        return emptyResult;
    }

    const finalPortfolio = calculatePortfolioMetrics(currentBonds);
    const afterMetrics = calculateImpactMetrics(finalPortfolio, benchmark);
    const totalTradedValue = proposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
    const estimatedCost = totalTradedValue * (params.transactionCost / 10000);

    if (iterations >= MAX_ITERATIONS) {
        rationaleParts.push("Halted: Reached maximum optimisation iterations.");
    }

    return {
        proposedTrades,
        impactAnalysis: { before: beforeMetrics, after: afterMetrics },
        estimatedCost,
        estimatedCostBpsOfNav: initialPortfolio.totalMarketValue > 0 ? (estimatedCost / initialPortfolio.totalMarketValue) * 10000 : 0,
        estimatedCostBpsPerTradeSum: params.transactionCost * proposedTrades.length,
        rationale: Array.from(new Set(rationaleParts)).join(' '),
    };
};
