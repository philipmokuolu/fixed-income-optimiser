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

  const weight = (bond: Bond) => bond.marketValue / totalMarketValue;

  const modifiedDuration = bonds.reduce((sum, bond) => sum + bond.modifiedDuration * weight(bond), 0);
  
  const averageYield = bonds.reduce((sum, bond) => sum + bond.yieldToMaturity * weight(bond), 0);
  
  const krd = KRD_TENORS.reduce((acc, tenor) => {
    const krdKey: KrdKey = `krd_${tenor}`;
    acc[krdKey] = bonds.reduce((sum, bond) => sum + bond[krdKey] * weight(bond), 0);
    return acc;
  }, {} as KRDFields);

  return { 
      bonds, 
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
  let pnl = 0;
  
  const entityMarketValue = 'totalMarketValue' in entity ? entity.totalMarketValue : portfolioMarketValueForBenchmark;

  if (entityMarketValue === 0) return { pnl: 0, pnlPercent: 0 };

  KRD_TENORS.forEach(tenor => {
    const krdKey: KrdKey = `krd_${tenor}`;
    const rateChangeBps = scenario[tenor] || 0;
    if (rateChangeBps !== 0) {
      const krdValue = entity[krdKey];
      // P&L ≈ -MarketValue * Σ(KRD_tenor * (yield_change_for_tenor_in_bps / 10000))
      pnl -= entityMarketValue * krdValue * (rateChangeBps / 10000);
    }
  });

  const pnlPercent = (pnl / entityMarketValue) * 100;
  
  return { pnl, pnlPercent };
};