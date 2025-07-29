import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, KrdKey, KRD_TENORS, Bond, ProposedTrade, BondStaticData } from '@/types';
import { calculatePortfolioMetrics, calculateTrackingError } from './portfolioService';

const calculateImpactMetrics = (portfolio: Portfolio, benchmark: Benchmark) => {
    return {
        modifiedDuration: portfolio.modifiedDuration,
        durationGap: portfolio.modifiedDuration - benchmark.modifiedDuration,
        trackingError: calculateTrackingError(portfolio, benchmark),
        yield: portfolio.averageYield,
    };
};


export const runOptimizer = (
  portfolio: Portfolio,
  benchmark: Benchmark,
  params: OptimizationParams,
  bondMasterData: Record<string, BondStaticData>
): OptimizationResult => {

  const beforeMetrics = calculateImpactMetrics(portfolio, benchmark);
  const initialTrackingError = beforeMetrics.trackingError;

  if (initialTrackingError < 2) { // Don't trade if TE is already very low
     return {
          proposedTrades: [],
          impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
          estimatedCost: 0
      }
  }

  // Simple heuristic: find the KRD with the biggest underweight and biggest overweight
  let maxOverweight = 0;
  let minUnderweight = 0;
  let overweightTenor: KrdKey | null = null;
  let underweightTenor: KrdKey | null = null;

  KRD_TENORS.forEach(t => {
    const krdKey: KrdKey = `krd_${t}`;
    const gap = portfolio[krdKey] - benchmark[krdKey];
    if (gap > maxOverweight) {
      maxOverweight = gap;
      overweightTenor = krdKey;
    }
    if (gap < minUnderweight) {
      minUnderweight = gap;
      underweightTenor = krdKey;
    }
  });
  
  const proposedTrades: ProposedTrade[] = [];
  const turnoverAmount = (params.maxTurnover / 100) * portfolio.totalMarketValue;
  const tradeAmount = turnoverAmount / 2; // Split between buy and sell to be cash-neutral

  const newBondsMap = new Map<string, Bond>();
  portfolio.bonds.forEach(bond => newBondsMap.set(bond.isin, { ...bond }));

  // Propose a SELL trade to reduce the largest overweight KRD
  if (overweightTenor) {
      const eligibleToSell = portfolio.bonds.filter(b => !params.excludedBonds.includes(b.isin));
      const bondToSell = eligibleToSell.sort((a,b) => b[overweightTenor!] - a[overweightTenor!])[0];

      if (bondToSell && bondToSell.marketValue > tradeAmount) {
          proposedTrades.push({ action: 'SELL', bondId: bondToSell.isin, bondName: bondToSell.name, amount: tradeAmount });
          const existing = newBondsMap.get(bondToSell.isin)!;
          existing.marketValue -= tradeAmount;
          existing.notional = existing.marketValue / (existing.price / 100);
      }
  }

  // Propose a BUY trade to reduce the largest underweight KRD
  if (underweightTenor) {
      const portfolioIsins = new Set(portfolio.bonds.map(b => b.isin));
      const buyUniverse = Object.entries(bondMasterData)
        .filter(([isin]) => !portfolioIsins.has(isin))
        .map(([isin, staticData]) => ({ isin, ...staticData } as Bond));
      
      const bondToBuy = buyUniverse.sort((a,b) => b[underweightTenor!] - a[underweightTenor!])[0];
      
      if (bondToBuy) {
          proposedTrades.push({ action: 'BUY', bondId: bondToBuy.isin, bondName: bondToBuy.name, amount: tradeAmount });
          
          if (newBondsMap.has(bondToBuy.isin)) {
            const existing = newBondsMap.get(bondToBuy.isin)!;
            existing.marketValue += tradeAmount;
            existing.notional = existing.marketValue / (existing.price / 100);
          } else {
             const newNotional = tradeAmount / (bondToBuy.price / 100);
             newBondsMap.set(bondToBuy.isin, {
                ...bondToBuy,
                notional: newNotional,
                marketValue: tradeAmount,
                portfolioWeight: 0 // Will be recalculated
             });
          }
      }
  }
  
  if (proposedTrades.length === 0) {
      return {
          proposedTrades: [],
          impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
          estimatedCost: 0
      }
  }

  const afterPortfolio = calculatePortfolioMetrics(Array.from(newBondsMap.values()));
  const afterMetrics = calculateImpactMetrics(afterPortfolio, benchmark);
  const totalTradedValue = proposedTrades.reduce((sum, trade) => sum + trade.amount, 0);

  return {
    proposedTrades,
    impactAnalysis: {
      before: beforeMetrics,
      after: afterMetrics,
    },
    estimatedCost: (totalTradedValue / portfolio.totalMarketValue) * params.transactionCost,
  };
};