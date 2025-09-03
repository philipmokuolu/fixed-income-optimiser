import { Portfolio, Bond, KRDFields, KrdKey, KRD_TENORS, Benchmark, KrdTenor, PortfolioHolding, BondStaticData, BenchmarkHolding, ProposedTrade, FxRates } from '@/types';

export const buildPortfolio = (
  holdings: PortfolioHolding[], 
  bondMasterData: Record<string, BondStaticData>,
  fxRates: FxRates
): Bond[] => {

  return holdings.map(holding => {
    const staticData = bondMasterData[holding.isin];
    if (!staticData) {
      console.warn(`Master data not found for ISIN: ${holding.isin}. Skipping holding.`);
      return null;
    }

    const marketValue = holding.notional * (staticData.price / 100);
    const fxRate = fxRates[staticData.currency] || 1.0;
    const marketValueUSD = marketValue * fxRate;

    return {
      ...staticData,
      isin: holding.isin,
      notional: holding.notional,
      marketValue,
      marketValueUSD,
      portfolioWeight: 0, // Placeholder, calculated in calculatePortfolioMetrics
      durationContribution: 0, // Placeholder, calculated in calculatePortfolioMetrics
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
        if (staticData && typeof staticData[krdKey] === 'number' && typeof holding.weight === 'number') {
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
  const warnings: string[] = [];
  const totalMarketValue = bonds.reduce((sum, bond) => sum + bond.marketValueUSD, 0);

  const zeroKRDs = KRD_TENORS.reduce((acc, tenor) => ({ ...acc, [`krd_${tenor}`]: 0 }), {} as KRDFields);

  if (totalMarketValue === 0) {
    return {
      bonds: [],
      totalMarketValue: 0,
      modifiedDuration: 0,
      averageYield: 0,
      warnings: bonds.length > 0 ? ["Portfolio market value is zero."] : [],
      ...zeroKRDs,
    };
  }
  
  const bondsWithWeights = bonds.map(bond => ({
      ...bond,
      portfolioWeight: bond.marketValueUSD / totalMarketValue,
  }));
  
  const bondsWithMetrics = bondsWithWeights.map(bond => ({
      ...bond,
      durationContribution: bond.modifiedDuration * bond.portfolioWeight
  }));

  const weight = (bond: Bond) => bond.portfolioWeight;

  let modifiedDuration = bondsWithMetrics.reduce((sum, bond) => sum + (bond.modifiedDuration || 0) * weight(bond), 0);
  if (isNaN(modifiedDuration)) {
      warnings.push("Portfolio Duration could not be calculated due to invalid non-numeric data in the 'modifiedDuration' column of the Bond Master file.");
      modifiedDuration = 0;
  }
  
  let averageYield = bondsWithMetrics.reduce((sum, bond) => sum + (bond.yieldToMaturity || 0) * weight(bond), 0);
  if (isNaN(averageYield)) {
      warnings.push("Portfolio Yield could not be calculated due to invalid non-numeric data in the 'yieldToMaturity' column of the Bond Master file.");
      averageYield = 0;
  }
  
  const krd = KRD_TENORS.reduce((acc, tenor) => {
    const krdKey: KrdKey = `krd_${tenor}`;
    let krdValue = bondsWithMetrics.reduce((sum, bond) => sum + (bond[krdKey] || 0) * weight(bond), 0);
    if (isNaN(krdValue)) {
        warnings.push(`KRD for tenor '${tenor}' could not be calculated due to invalid non-numeric data in the '${krdKey}' column of the Bond Master file.`);
        krdValue = 0;
    }
    acc[krdKey] = krdValue;
    return acc;
  }, {} as KRDFields);

  return { 
      bonds: bondsWithMetrics, 
      totalMarketValue, 
      modifiedDuration,
      averageYield,
      warnings: warnings.length > 0 ? warnings : undefined,
      ...krd,
    };
};

export type RateScenario = Partial<Record<KrdTenor, number>>;

export const calculateScenarioPnl = (
  entity: Portfolio | Benchmark,
  scenario: RateScenario,
  portfolioMarketValueForBenchmark: number,
  scenarioType: 'parallel' | 'steepener' | 'flattener' | 'custom'
): { pnl: number, pnlPercent: number } => {
  const entityMarketValue = 'totalMarketValue' in entity ? entity.totalMarketValue : portfolioMarketValueForBenchmark;
  if (entityMarketValue === 0) return { pnl: 0, pnlPercent: 0 };
  
  let pnl = 0;

  // Use the correct mathematical model based on the scenario type.
  if (scenarioType === 'parallel') {
    // For a true parallel shift, total Modified Duration is the correct measure.
    // P&L ≈ -MarketValue * Duration * ΔYield
    const shiftBps = scenario['1y'] || 0; // In a parallel shift, all tenor shifts are the same.
    const shiftDecimal = shiftBps / 10000; // Convert bps to decimal (100 bps = 1% = 0.01)
    pnl = -entity.modifiedDuration * entityMarketValue * shiftDecimal;

  } else {
    // For non-parallel shifts (twists, custom curves), KRDs are the correct measure.
    // P&L ≈ -MarketValue * Σ(KRD_tenor * Δyield_tenor)
    KRD_TENORS.forEach(tenor => {
      const krdKey: KrdKey = `krd_${tenor}`;
      const rateChangeBps = scenario[tenor] || 0;
      if (rateChangeBps !== 0) {
        const krdValue = entity[krdKey];
        pnl -= entityMarketValue * krdValue * (rateChangeBps / 10000);
      }
    });
  }

  const pnlPercent = (pnl / entityMarketValue) * 100;
  
  return { pnl, pnlPercent };
};


// This function was previously in optimizerService, moved here for better separation of concerns
// and to fix circular dependency issues.
export const applyTradesToPortfolio = (
    currentBonds: Bond[], 
    tradesToApply: ProposedTrade[],
    bondMasterData: Record<string, BondStaticData>,
    fxRates: FxRates
): Bond[] => {
    const newBondsMap = new Map<string, {notional: number, staticData: BondStaticData}>();

    // Populate map with existing bonds
    currentBonds.forEach(bond => {
        const staticData: BondStaticData = {
            name: bond.name, currency: bond.currency, maturityDate: bond.maturityDate, coupon: bond.coupon,
            price: bond.price, yieldToMaturity: bond.yieldToMaturity, modifiedDuration: bond.modifiedDuration,
            creditRating: bond.creditRating, liquidityScore: bond.liquidityScore, bidAskSpread: bond.bidAskSpread,
            krd_1y: bond.krd_1y, krd_2y: bond.krd_2y, krd_3y: bond.krd_3y, krd_5y: bond.krd_5y, krd_7y: bond.krd_7y, krd_10y: bond.krd_10y,
        };
        newBondsMap.set(bond.isin, { notional: bond.notional, staticData });
    });

    // Apply trades
    tradesToApply.forEach(trade => {
        let existing = newBondsMap.get(trade.isin);
        
        if (!existing) {
            const masterData = bondMasterData[trade.isin];
            if (masterData) {
                existing = { notional: 0, staticData: masterData };
            } else {
                 console.warn(`Cannot apply trade for ISIN ${trade.isin}: Bond master data not found.`);
                 return;
            }
        }
        
        const newNotional = trade.action === 'BUY'
            ? existing.notional + trade.notional
            : existing.notional - trade.notional;
        
        if (newNotional > 1) { // Use a small threshold to avoid floating point issues
            newBondsMap.set(trade.isin, { ...existing, notional: newNotional });
        } else {
            newBondsMap.delete(trade.isin);
        }
    });

    // Convert map back to Bond array
    const bondsArray: Bond[] = Array.from(newBondsMap.entries()).map(([isin, {notional, staticData}]) => {
        const marketValue = notional * (staticData.price / 100);
        const fxRate = fxRates[staticData.currency] || 1.0;
        const marketValueUSD = marketValue * fxRate;
        return {
            ...staticData,
            isin,
            notional,
            marketValue,
            marketValueUSD,
            portfolioWeight: 0,
            durationContribution: 0,
        }
    });
    
    // The calculatePortfolioMetrics function will correctly recalculate weights and contributions
    return bondsArray;
}