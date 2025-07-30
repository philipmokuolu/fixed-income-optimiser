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

export const runOptimizer = (
  portfolio: Portfolio,
  benchmark: Benchmark,
  params: OptimizationParams,
  bondMasterData: Record<string, BondStaticData>
): OptimizationResult => {

  const beforeMetrics = calculateImpactMetrics(portfolio, benchmark);
  const rationaleParts: string[] = [];
  const emptyResult = {
      proposedTrades: [],
      impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
      estimatedCost: 0,
      estimatedCostBpsOfNav: 0,
      estimatedCostBpsPerTradeSum: 0,
  };


  if (beforeMetrics.trackingError < 2 && Math.abs(beforeMetrics.durationGap) < params.durationGapThreshold) {
     return {
          ...emptyResult,
          rationale: "Portfolio is already well-aligned with the benchmark. No trades are necessary."
      }
  }

  const proposedTrades: ProposedTrade[] = [];
  const turnoverAmount = (params.maxTurnover / 100) * portfolio.totalMarketValue;
  const newBondsMap = new Map<string, Bond>();
  portfolio.bonds.forEach(bond => newBondsMap.set(bond.isin, { ...bond }));
  
  const portfolioIsins = new Set(portfolio.bonds.map(b => b.isin));
  const buyUniverse = Object.entries(bondMasterData)
        .filter(([isin]) => !portfolioIsins.has(isin))
        .map(([isin, staticData]) => ({ ...staticData, isin } as BondStaticData & {isin: string}));
        
  const eligibleToSell = portfolio.bonds.filter(b => !params.excludedBonds.includes(b.isin));

  // --- Main Heuristic Logic ---
  
  const isDurationGapBreached = Math.abs(beforeMetrics.durationGap) > params.durationGapThreshold;
  const isPortfolioShort = beforeMetrics.durationGap < 0;
  
  if (isDurationGapBreached && params.mode === 'switch') {
      rationaleParts.push(`Primary objective: Correct the duration gap of ${beforeMetrics.durationGap.toFixed(2)} yrs (Threshold: ±${params.durationGapThreshold} yrs).`);
      
      const tradeAmount = turnoverAmount / 2;
      let bondToSell: Bond | undefined;
      let bondToBuy: (BondStaticData & {isin: string}) | undefined;

      if(isPortfolioShort) { 
          rationaleParts.push("Portfolio duration is too short; selling low-duration assets to buy high-duration assets.");
          bondToSell = eligibleToSell.sort((a,b) => a.modifiedDuration - b.modifiedDuration)[0];
          bondToBuy = buyUniverse.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
      } else {
          rationaleParts.push("Portfolio duration is too long; selling high-duration assets to buy low-duration assets.");
          bondToSell = eligibleToSell.sort((a,b) => b.modifiedDuration - a.modifiedDuration)[0];
          bondToBuy = buyUniverse.sort((a,b) => a.modifiedDuration - b.modifiedDuration)[0];
      }
      
      if (bondToSell && bondToBuy) {
          const actualSellAmount = Math.min(tradeAmount, bondToSell.marketValue);
          proposedTrades.push(createTradeObject('SELL', bondToSell, actualSellAmount));
          proposedTrades.push(createTradeObject('BUY', bondToBuy, actualSellAmount)); // Cash neutral
      }

  } else {
      rationaleParts.push("Primary objective: Minimize KRD-based tracking error.");
      let krdGaps = KRD_TENORS.map(t => {
          const krdKey: KrdKey = `krd_${t}`;
          return { tenor: krdKey, gap: portfolio[krdKey] - benchmark[krdKey] };
      });

      const maxOverweight = krdGaps.sort((a,b) => b.gap - a.gap)[0];
      const maxUnderweight = krdGaps.sort((a,b) => a.gap - b.gap)[0];
      
      let sellTradeAmount = 0;
      let buyTradeAmount = 0;

      if (params.mode === 'switch') {
          const sellValue = proposedTrades.find(t => t.action === 'SELL')?.marketValue ?? 0;
          const buyValue = proposedTrades.find(t => t.action === 'BUY')?.marketValue ?? 0;
          const remainingTurnover = (turnoverAmount / 2) - Math.max(sellValue, buyValue);
          
          sellTradeAmount = remainingTurnover;
          buyTradeAmount = remainingTurnover;

      } else { // buy-only
          buyTradeAmount = turnoverAmount;
      }

      if (params.mode === 'switch' && maxOverweight.gap > 0.01 && sellTradeAmount > 0) {
          const bondToSell = eligibleToSell.sort((a,b) => b[maxOverweight.tenor] - a[maxOverweight.tenor])[0];
          if (bondToSell) {
              const actualSellAmount = Math.min(sellTradeAmount, bondToSell.marketValue);
              if (actualSellAmount > 1000) {
                rationaleParts.push(`Reducing overweight in ${maxOverweight.tenor.replace('krd_','')} tenor.`);
                proposedTrades.push(createTradeObject('SELL', bondToSell, actualSellAmount));
                buyTradeAmount = actualSellAmount; // ensure cash neutrality for KRD leg
              }
          }
      }

      if (maxUnderweight.gap < -0.01 && buyTradeAmount > 0) {
          const bondToBuy = buyUniverse.sort((a,b) => b[maxUnderweight.tenor] - a[maxUnderweight.tenor])[0];
          if (bondToBuy) {
              rationaleParts.push(`Increasing exposure to underweight ${maxUnderweight.tenor.replace('krd_','')} tenor.`);
              proposedTrades.push(createTradeObject('BUY', bondToBuy, buyTradeAmount));
          }
      }
  }

  // --- Apply Trades and Calculate After Metrics ---

  if (proposedTrades.length === 0) {
      return {
          ...emptyResult,
          rationale: rationaleParts.length > 0 ? rationaleParts.join(' ') : "No profitable trades found to improve portfolio metrics."
      }
  }
  
  proposedTrades.forEach(trade => {
       if(trade.action === 'SELL') {
            const existing = newBondsMap.get(trade.isin)!;
            existing.marketValue -= trade.marketValue;
            existing.notional = existing.marketValue / (existing.price / 100);
            if(existing.marketValue < 1000) newBondsMap.delete(trade.isin);
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

  const afterPortfolio = calculatePortfolioMetrics(Array.from(newBondsMap.values()));
  const afterMetrics = calculateImpactMetrics(afterPortfolio, benchmark);
  const totalTradedValue = proposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
  const estimatedCost = totalTradedValue * (params.transactionCost / 10000);

  return {
    proposedTrades,
    impactAnalysis: {
      before: beforeMetrics,
      after: afterMetrics,
    },
    estimatedCost,
    estimatedCostBpsOfNav: portfolio.totalMarketValue > 0 ? (estimatedCost / portfolio.totalMarketValue) * 10000 : 0,
    estimatedCostBpsPerTradeSum: params.transactionCost * proposedTrades.length,
    rationale: rationaleParts.join(' '),
  };
};
