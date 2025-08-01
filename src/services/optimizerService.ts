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
    const { maxDurationShortfall, maxDurationSurplus, mode } = params;

    const emptyResult = (rationale: string) => ({
        proposedTrades: [],
        impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
        estimatedCost: 0, estimatedCostBpsOfNav: 0, estimatedCostBpsPerTradeSum: 0,
        rationale,
    });

    // --- Mode Guard ---
    if (mode === 'buy-only') {
        return emptyResult("The 'Buy Only' mode is being rebuilt for stability. Please use 'Switch Trades' for now.");
    }

    // --- Check if optimization is needed ---
    const initialDurationGap = beforeMetrics.durationGap;
    if (initialDurationGap >= -maxDurationShortfall && initialDurationGap <= maxDurationSurplus) {
        return emptyResult("Portfolio duration is within the defined limits. No trades are necessary.");
    }

    // --- Core Logic for "Switch Trades" ---
    const isPortfolioShort = initialDurationGap < 0; // Need to INCREASE duration.
    
    const eligibleToSell = initialPortfolio.bonds.filter(b => !params.excludedBonds.includes(b.isin));
    if (eligibleToSell.length === 0) {
        return emptyResult("Halted: No eligible bonds available to sell.");
    }

    const portfolioIsins = new Set(initialPortfolio.bonds.map(b => b.isin));
    const buyUniverse = Object.entries(bondMasterData)
        .filter(([isin]) => !portfolioIsins.has(isin))
        .map(([isin, staticData]) => ({ ...staticData, isin } as (BondStaticData & {isin: string})));
    
    if (buyUniverse.length === 0) {
        return emptyResult("Halted: No eligible bonds available in the universe to buy.");
    }
    
    let bondToSell: Bond;
    let bondToBuy: (BondStaticData & {isin: string});

    if (isPortfolioShort) { // Sell low duration, buy high duration
        bondToSell = eligibleToSell.sort((a,b) => a.modifiedDuration - b.modifiedDuration)[0];
        bondToBuy = buyUniverse.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
    } else { // Sell high duration, buy low duration
        bondToSell = eligibleToSell.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
        bondToBuy = buyUniverse.sort((a,b) => a.modifiedDuration - a.modifiedDuration)[0];
    }

    if (!bondToSell || !bondToBuy) {
         return emptyResult("Could not find a suitable pair of bonds to trade.");
    }
    
    // Propose one single, simple trade. The size is a fraction of max turnover, to be less aggressive.
    const tradeAmount = Math.min(
        (params.maxTurnover / 100) * initialPortfolio.totalMarketValue, 
        bondToSell.marketValue
    );

    if (tradeAmount < MIN_TRADE_SIZE) {
        return emptyResult("Calculated trade size is below the minimum threshold.");
    }
    
    const sellTrade = createTradeObject('SELL', bondToSell, tradeAmount);
    const buyTrade = createTradeObject('BUY', bondToBuy, tradeAmount); // Cash neutral
    const proposedTrades = [sellTrade, buyTrade];
    
    const newBonds = applyTradesToPortfolio(initialPortfolio.bonds, proposedTrades, bondMasterData);
    const finalPortfolio = calculatePortfolioMetrics(newBonds);
    const afterMetrics = calculateImpactMetrics(finalPortfolio, benchmark);

    const totalTradedValue = sellTrade.marketValue + buyTrade.marketValue;
    const estimatedCost = totalTradedValue * (params.transactionCost / 10000);

    const rationale = isPortfolioShort 
        ? `Portfolio duration is too short (${initialDurationGap.toFixed(2)} yrs). Proposing a trade to sell a low-duration asset (${bondToSell.name}) and buy a high-duration asset (${bondToBuy.name}) to increase overall portfolio duration.`
        : `Portfolio duration is too long (${initialDurationGap.toFixed(2)} yrs). Proposing a trade to sell a high-duration asset (${bondToSell.name}) and buy a low-duration asset (${bondToBuy.name}) to decrease overall portfolio duration.`;

    return {
        proposedTrades,
        impactAnalysis: { before: beforeMetrics, after: afterMetrics },
        estimatedCost,
        estimatedCostBpsOfNav: initialPortfolio.totalMarketValue > 0 ? (estimatedCost / initialPortfolio.totalMarketValue) * 10000 : 0,
        estimatedCostBpsPerTradeSum: params.transactionCost * proposedTrades.length,
        rationale,
    };
};