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
const applyTradesToPortfolio = (
    currentBonds: Bond[], 
    tradesToApply: ProposedTrade[],
    bondMasterData: Record<string, BondStaticData>
): Bond[] => {
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
    
    return calculatePortfolioMetrics(Array.from(newBondsMap.values())).bonds;
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

    let remainingTurnover = (params.maxTurnover / 100) * initialPortfolio.totalMarketValue;
    let proposedTrades: ProposedTrade[] = [];
    let currentBonds = [...initialPortfolio.bonds];
    let iterations = 0;

    const portfolioIsins = new Set(initialPortfolio.bonds.map(b => b.isin));
    const buyUniverse = Object.entries(bondMasterData)
        .filter(([isin]) => !portfolioIsins.has(isin))
        .map(([isin, staticData]) => ({ ...staticData, isin } as Bond & BondStaticData));
    
    const isInitialDurationGapBreached = beforeMetrics.durationGap < -params.maxDurationShortfall || beforeMetrics.durationGap > params.maxDurationSurplus;
    
    if (isInitialDurationGapBreached) {
        rationaleParts.push(`Primary Objective: Correct the duration gap of ${beforeMetrics.durationGap.toFixed(2)} yrs.`);
    } else {
        rationaleParts.push("Primary Objective: Minimize KRD-based tracking error while respecting duration constraints.");
    }
    
    // --- Main Optimization Loop ---
    while (remainingTurnover > MIN_TRADE_SIZE && iterations < MAX_ITERATIONS) {
        iterations++;
        let tradeMadeInThisIteration = false;
        
        const currentPortfolio = calculatePortfolioMetrics(currentBonds);
        const currentMetrics = calculateImpactMetrics(currentPortfolio, benchmark);
        const eligibleToSell = currentBonds.filter(b => !params.excludedBonds.includes(b.isin));

        if (eligibleToSell.length === 0) {
            if (params.mode === 'switch') {
                rationaleParts.push("Halted: No eligible bonds available to sell.");
                break;
            }
        }
        
        const isDurationGapBreached = currentMetrics.durationGap < -params.maxDurationShortfall || currentMetrics.durationGap > params.maxDurationSurplus;
        
        // ** PRIMARY OBJECTIVE: Fix Duration Gap **
        if (isDurationGapBreached && params.mode === 'switch') {
            const isPortfolioShort = currentMetrics.durationGap < 0;
            const idealTradeAmount = Math.min(remainingTurnover / 2, initialPortfolio.totalMarketValue * 0.05); // Use 5% of portfolio value per trade leg
            
            let bondToSell: Bond | undefined;
            let bondToBuy: (BondStaticData & Bond) | undefined;

            if (isPortfolioShort) { // Need to INCREASE duration
                bondToSell = eligibleToSell.sort((a,b) => a.modifiedDuration - b.modifiedDuration)[0];
                bondToBuy = buyUniverse.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
            } else { // Need to DECREASE duration
                bondToSell = eligibleToSell.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
                bondToBuy = buyUniverse.sort((a,b) => a.modifiedDuration - b.modifiedDuration)[0];
            }

            if (bondToSell && bondToBuy) {
                const actualSellAmount = Math.min(idealTradeAmount, bondToSell.marketValue);

                if (actualSellAmount > MIN_TRADE_SIZE) {
                    const sellTrade = createTradeObject('SELL', bondToSell, actualSellAmount);
                    const buyTrade = createTradeObject('BUY', bondToBuy, actualSellAmount); // Cash neutral
                    
                    proposedTrades.push(sellTrade, buyTrade);
                    currentBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                    remainingTurnover -= (actualSellAmount * 2);
                    tradeMadeInThisIteration = true;
                    continue; // Re-evaluate state in next loop
                }
            }
        }

        // ** SECONDARY OBJECTIVE: Minimize Tracking Error **
        const krdGaps = KRD_TENORS.map(t => {
            const krdKey: KrdKey = `krd_${t}`;
            return { tenor: krdKey, gap: currentPortfolio[krdKey] - benchmark[krdKey] };
        }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
        
        const largestGap = krdGaps[0];
        const idealKrdTradeAmount = Math.min(remainingTurnover / 2, initialPortfolio.totalMarketValue * 0.025);
        
        if (Math.abs(largestGap.gap) < 0.01) {
            break; // No significant gaps to fix
        }

        const isUnderweight = largestGap.gap < 0;

        if (params.mode === 'switch') {
            let bondToSell: Bond | undefined;
            let bondToBuy: (BondStaticData & Bond) | undefined;
            
            if (isUnderweight) { // Need to BUY exposure to this tenor. Sell an overweight.
                bondToBuy = buyUniverse.sort((a, b) => b[largestGap.tenor] - a[largestGap.tenor])[0];
                const largestOverweight = krdGaps.find(g => g.gap > 0.01);
                if (largestOverweight) {
                    bondToSell = eligibleToSell.sort((a, b) => b[largestOverweight.tenor] - a[largestOverweight.tenor])[0];
                }
            } else { // Overweight, must sell. Buy an underweight.
                 bondToSell = eligibleToSell.sort((a, b) => b[largestGap.tenor] - a[largestGap.tenor])[0];
                 const largestUnderweight = krdGaps.find(g => g.gap < -0.01);
                 if (largestUnderweight) {
                     bondToBuy = buyUniverse.sort((a, b) => b[largestUnderweight.tenor] - a[largestUnderweight.tenor])[0];
                 }
            }

            if (bondToSell && bondToBuy) {
                const actualSellAmount = Math.min(idealKrdTradeAmount, bondToSell.marketValue);
                if (actualSellAmount > MIN_TRADE_SIZE) {
                    const sellTrade = createTradeObject('SELL', bondToSell, actualSellAmount);
                    const buyTrade = createTradeObject('BUY', bondToBuy, actualSellAmount);

                    // --- WHAT-IF CHECK ---
                    const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                    const tempPortfolio = calculatePortfolioMetrics(tempBonds);
                    const tempDurationGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;

                    if (tempDurationGap < -params.maxDurationShortfall && tempDurationGap > params.maxDurationSurplus) {
                        // This trade would breach the duration gap. Do nothing and let the loop find another combination.
                    } else {
                        // Trade is safe, proceed.
                        proposedTrades.push(sellTrade, buyTrade);
                        currentBonds = tempBonds;
                        remainingTurnover -= (actualSellAmount * 2);
                        tradeMadeInThisIteration = true;
                        continue;
                    }
                }
            }

        } else { // Buy-only mode
             if (isUnderweight) {
                 const bondToBuy = buyUniverse.sort((a, b) => b[largestGap.tenor] - a[largestGap.tenor])[0];
                 if(bondToBuy) {
                    const buyAmount = Math.min(remainingTurnover, idealKrdTradeAmount * 2);
                    if (buyAmount > MIN_TRADE_SIZE) {
                       const buyTrade = createTradeObject('BUY', bondToBuy, buyAmount);
                       proposedTrades.push(buyTrade);
                       currentBonds = applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData);
                       remainingTurnover -= buyTrade.marketValue;
                       tradeMadeInThisIteration = true;
                       continue;
                    }
                 }
             }
        }

        if (!tradeMadeInThisIteration) {
            break; 
        }
    }

    if (proposedTrades.length === 0) {
        return { ...emptyResult, rationale: "No trades recommended. Portfolio is optimal given constraints." };
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
        rationale: Array.from(new Set(rationaleParts)).join(' '),
    };
};
getComputedStyle
