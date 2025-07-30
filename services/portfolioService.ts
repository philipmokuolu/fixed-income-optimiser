import { Portfolio, Bond, KRDFields, KrdKey, KRD_TENORS, Benchmark, KrdTenor, PortfolioHolding, BondStaticData, BenchmarkHolding } from '@/types';

export const buildPortfolio = (
  holdings: PortfolioHolding[], 
  bondMasterData: Record<string, BondStaticData>
): Bond[] => {
  const totalMarketValue = holdings.reduce((sum, holding) => {
    const staticData = bondMasterData[holding.isin];
    if (staticData) {
      return sum + (holding.notional * (staticData.price / 100));
    }
    return sum;
  }, 0);

  return holdings.map(holding => {
    const staticData = bondMasterData[holding.isin];
    if (!staticData) {
      console.warn(`Master data not found for ISIN: ${holding.isin}. Skipping holding.`);
      return null;
    }

    const marketValue = holding.notional * (staticData.price / 100);

    return {
      ...staticData,
      isin: holding.isin,
      notional: holding.notional,
      marketValue,
      portfolioWeight: totalMarketValue > 0 ? marketValue / totalMarketValue : 0,
      durationContribution: 0, // Placeholder, will be calculated in calculatePortfolioMetrics
    };
  }).filter(Boolean) as Bond[];
};

export const buildBenchmark = (
  benchmarkHoldings: BenchmarkHolding[],
  bondMasterData: Record<string, BondStaticData>
): KRDFields => {
  const zeroKRDs = KRD_TENORS.reduce((acc, tenor) => ({ ...acc, [`krd_${tenor}`]: 0 }), {} as KRDFields);
  
  if (benchmarkHoldings.length === 0) return zeroKRDs;

  const totalWeight = benchmarkHoldings.reduce((sum, h) => sum + h.weight, 0);
  if (totalWeight === 0) return zeroKRDs;

  const weightedKRDs = KRD_TENORS.reduce((acc, tenor) => {
    const krdKey: KrdKey = `krd_${tenor}`;
    acc[krdKey] = benchmarkHoldings.reduce((sum, holding) => {
        const staticData = bondMasterData[holding.isin];
        if (staticData && staticData[krdKey] && holding.weight) {
            return sum + staticData[krdKey] * holding.weight;
        }
        return sum;
    }, 0);
    return acc;
  }, {} as KRDFields);
  
  // Normalize KRDs by total weight in case weights don't sum to 1 (or 100)
  Object.keys(weightedKRDs).forEach(key => {
      const krdKey = key as KrdKey;
      weightedKRDs[krdKey] /= totalWeight;
  });

  return weightedKRDs;
};


export const calculateTrackingError = (portfolio: KRDFields, benchmark: KRDFields): number => {
  const sumOfSquares = KRD_TENORS.reduce((sum, tenor) => {
    const krdKey: KrdKey = `krd_${tenor}`;
    const diff = (portfolio[krdKey] || 0) - (benchmark[krdKey] || 0);
    return sum + diff * diff;
  }, 0);
  return Math.sqrt(sumOfSquares) * 100; // in bps
};

export const calculatePortfolioMetrics = (bonds: Bond[]): Portfolio => {
  const totalMarketValue = bonds.reduce((sum, bond) => sum + bond.marketValue, 0);

  if (totalMarketValue === 0) {
    const zeroKRDs = KRD_TENORS.reduce((acc, tenor) => ({ ...acc, [`krd_${tenor}`]: 0 }), {} as KRDFields);

    return {
      bonds: [],
      totalMarketValue: 0,
      modifiedDuration: 0,
      averageYield: 0,
      ...zeroKRDs,
    };
  }
  
  const bondsWithWeights = bonds.map(bond => ({
      ...bond,
      portfolioWeight: bond.marketValue / totalMarketValue,
  }));
  
  const bondsWithMetrics = bondsWithWeights.map(bond => ({
      ...bond,
      durationContribution: bond.modifiedDuration * bond.portfolioWeight
  }));

  const weight = (bond: Bond) => bond.marketValue / totalMarketValue;

  const modifiedDuration = bondsWithMetrics.reduce((sum, bond) => sum + bond.modifiedDuration * weight(bond), 0);
  
  const averageYield = bondsWithMetrics.reduce((sum, bond) => sum + bond.yieldToMaturity * weight(bond), 0);
  
  const krd = KRD_TENORS.reduce((acc, tenor) => {
    const krdKey: KrdKey = `krd_${tenor}`;
    acc[krdKey] = bondsWithMetrics.reduce((sum, bond) => sum + bond[krdKey] * weight(bond), 0);
    return acc;
  }, {} as KRDFields);

  return { 
      bonds: bondsWithMetrics, 
      totalMarketValue, 
      modifiedDuration,
      averageYield,
      ...krd,
    };
};

export type RateScenario = Partial<Record<KrdTenor, number>>;

export const calculateScenarioPnl = (
  entity: Portfolio | Benchmark,
  scenario: RateScenario,
  portfolioMarketValueForBenchmark: number
): { pnl: number, pnlPercent: number } => {
  // This function calculates the estimated Profit & Loss (P&L) based on Key Rate Durations (KRDs).
  // The formula is an industry-standard approximation for P&L from small interest rate changes:
  // P&L ≈ -MarketValue * Σ(KRD_tenor * Δyield_tenor)
  //
  // Where:
  // - MarketValue: The market value of the portfolio or benchmark.
  // - KRD_tenor: The Key Rate Duration for a specific point on the yield curve (e.g., 2y, 5y, 10y).
  //              It measures the sensitivity of the price to a 1% (100bps) change in that specific key rate.
  // - Δyield_tenor: The change in yield for that tenor, in decimal form (e.g., 50 bps = 0.005).
  //
  // Why the negative sign?
  // There's an inverse relationship between interest rates and bond prices.
  // - If rates go UP (Δyield is positive), bond prices go DOWN, resulting in a negative P&L.
  // - If rates go DOWN (Δyield is negative), bond prices go UP, resulting in a positive P&L.
  // The negative sign in the formula correctly models this relationship.
  //
  // Regarding user query on underperformance:
  // If Portfolio Duration < Benchmark Duration and rates FALL, the portfolio will gain LESS value than the benchmark.
  // This results in negative Active P&L (underperformance), which is correct. The code implements this logic.
  
  let pnl = 0;
  
  const entityMarketValue = 'totalMarketValue' in entity ? entity.totalMarketValue : portfolioMarketValueForBenchmark;

  if (entityMarketValue === 0) return { pnl: 0, pnlPercent: 0 };

  KRD_TENORS.forEach(tenor => {
    const krdKey: KrdKey = `krd_${tenor}`;
    const rateChangeBps = scenario[tenor] || 0;
    if (rateChangeBps !== 0) {
      const krdValue = entity[krdKey];
      pnl -= entityMarketValue * krdValue * (rateChangeBps / 10000);
    }
  });

  const pnlPercent = (pnl / entityMarketValue) * 100;
  
  return { pnl, pnlPercent };
};
