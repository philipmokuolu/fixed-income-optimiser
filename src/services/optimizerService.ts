

import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, KrdKey, KRD_TENORS, Bond, ProposedTrade, BondStaticData, ImpactMetrics, Currency } from '@/types';
import { calculatePortfolioMetrics, applyTradesToPortfolio, calculateTrackingError } from './portfolioService';
import { formatCurrency } from '@/utils/formatting';

const MIN_TRADE_SIZE = 1000; // Minimum trade size in currency to be considered
const MAX_ITERATIONS = 50; // Safety break for loops
const TOP_N_CANDIDATES = 20; // Number of buy/sell candidates to consider in heuristic search

const RATING_SCALE: { [key: string]: number } = {
  'AAA': 1, 'AA+': 2, 'AA': 3, 'AA-': 4,
  'A+': 5, 'A': 6, 'A-': 7,
  'BBB+': 8, 'BBB': 9, 'BBB-': 10,
  'BB+': 11, 'BB': 12, 'BB-': 13,
  'B+': 14, 'B': 15, 'B-': 16,
  'CCC+': 17, 'CCC': 18, 'CCC-': 19,
  'CC': 20, 'C': 21, 'D': 22, 'N/A': 99
};

const parseMaturityDate = (dateStr: string): Date => {
  if (typeof dateStr !== 'string' || !dateStr || dateStr.toUpperCase() === 'N/A') {
    // Handle perpetuals or invalid date strings by returning a far-future date.
    return new Date('2200-01-01');
  }

  const parts = dateStr.split(/[\/-]/);
  if (parts.length === 3) {
      let year = parseInt(parts[2], 10);
      let month = parseInt(parts[0], 10) - 1;
      let day = parseInt(parts[1], 10);

      if (parts[0].length === 4) {
          year = parseInt(parts[0], 10);
          month = parseInt(parts[1], 10) - 1;
          day = parseInt(parts[2], 10);
      }
      
      if (year < 100) {
          year += (year < 70) ? 2000 : 1900;
      }
      return new Date(year, month, day);
  }
  try {
      // Fallback for standard date strings like "YYYY-MM-DD"
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
          return date;
      }
  } catch(e) { /* ignore parse errors and fall through */ }

  // If all else fails, treat as a perpetual.
  return new Date('2200-01-01');
};


export const calculateImpactMetrics = (portfolio: Portfolio, benchmark: Benchmark): ImpactMetrics => {
    return {
        modifiedDuration: portfolio.modifiedDuration,
        durationGap: portfolio.modifiedDuration - benchmark.modifiedDuration,
        trackingError: calculateTrackingError(portfolio, benchmark),
        yield: portfolio.averageYield,
        portfolio: portfolio,
    };
};

const createTradeObject = (action: 'BUY' | 'SELL', bond: Bond | (BondStaticData & {isin: string}), notional: number, pairId: number): ProposedTrade => {
    const marketValue = notional * (bond.price / 100);
    const spreadCost = notional * (bond.bidAskSpread / 100) / 2;

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
        spreadCost,
        creditRating: bond.creditRating,
    };
};

// Calculates how far a duration gap is from the allowed zone. Returns 0 if within limits.
const getDurationBreachDistance = (gap: number, shortfallLimit: number, surplusLimit: number): number => {
    if (gap < -shortfallLimit) {
        return Math.abs(gap) - shortfallLimit;
    }
    if (gap > surplusLimit) {
        return gap - surplusLimit;
    }
    return 0;
};

// Gets trade size constraints for a bond, providing defaults based on currency if not specified.
const getTradeConstraints = (bond: Bond | (BondStaticData & { isin: string })) => {
    let defaults = { minTradeSize: 1000, tradeIncrement: 1000 }; // Generic default
    if (bond.currency === Currency.USD) {
        defaults = { minTradeSize: 2000, tradeIncrement: 1000 };
    } else if (bond.currency === Currency.EUR || bond.currency === Currency.GBP) {
        defaults = { minTradeSize: 100000, tradeIncrement: 1000 };
    }
    
    return {
        minTradeSize: bond.minTradeSize ?? defaults.minTradeSize,
        tradeIncrement: bond.tradeIncrement ?? defaults.tradeIncrement,
    };
};


export const runOptimizer = (
  initialPortfolio: Portfolio,
  benchmark: Benchmark,
  params: OptimizationParams,
  bondMasterData: Record<string, BondStaticData>
): OptimizationResult => {
  try {
    // --- 1. SETUP ---
    const beforeMetrics = calculateImpactMetrics(initialPortfolio, benchmark);
    const { mode, maxTurnover, transactionCost } = params;
    const rationaleSteps: string[] = [];

    const portfolioIsins = new Set(initialPortfolio.bonds.map(b => b.isin));
    
    let buyUniverse = Object.entries(bondMasterData)
        .map(([isin, staticData]) => ({ ...staticData, isin } as (Bond & {isin: string}))) // Eagerly map to include ISIN
        .filter(bond => {
            if (portfolioIsins.has(bond.isin)) return false; // Exclude bonds already in portfolio

            const today = new Date();
            const maturityDate = parseMaturityDate(bond.maturityDate);
            const yearsToMaturity = (maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
            if (yearsToMaturity > params.investmentHorizonLimit) return false;
            
            const minRatingValue = RATING_SCALE[params.minimumPurchaseRating] ?? 99;
            const bondRatingValue = RATING_SCALE[bond.creditRating] ?? 99;
            return bondRatingValue <= minRatingValue;
        });
    
    const emptyResult = (rationale: string) => ({
        proposedTrades: [],
        impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
        estimatedCost: 0, estimatedFeeCost: 0, estimatedSpreadCost: 0, estimatedCostBpsOfNav: 0, aggregateFeeBps: 0,
        rationale,
    });

    let currentPortfolio = { ...initialPortfolio };
    let currentBonds = [...initialPortfolio.bonds];
    const proposedTrades: ProposedTrade[] = [];
    let pairIdCounter = 0;

    // --- 2. MAIN LOGIC ---

    if (mode === 'switch') {
        let totalTradedValue = 0;
        const maxTradeValue = (maxTurnover / 100) * initialPortfolio.totalMarketValue;
        const tradeValueIncrement = Math.max(maxTradeValue / 10, MIN_TRADE_SIZE * 5);
        let iterations = 0;

        while (totalTradedValue < maxTradeValue && iterations < MAX_ITERATIONS) {
            const currentDurationGap = currentPortfolio.modifiedDuration - benchmark.modifiedDuration;
            const currentTE = calculateTrackingError(currentPortfolio, benchmark);
            const currentBreachDistance = getDurationBreachDistance(currentDurationGap, params.maxDurationShortfall, params.maxDurationSurplus);
            
            const isInBreach = currentBreachDistance > 0;

            if (!isInBreach && currentTE < 1.0) { 
                rationaleSteps.push("Halted: Portfolio is within duration limits and tracking error is already minimal.");
                break;
            }

            const sellableBonds = currentBonds.filter(b => !params.excludedBonds.includes(b.isin));
            if (sellableBonds.length === 0 || buyUniverse.length === 0) {
                rationaleSteps.push("Halted: No eligible bonds available to sell or buy.");
                break;
            }

            // Find best trade pair using scoring
            let bestPair: { sell: ProposedTrade, buy: ProposedTrade, score: number } | null = null;

            // Sort candidates based on the primary objective
            const isPortfolioShort = currentDurationGap < 0;
            const sellCandidates = [...sellableBonds].sort((a,b) => isPortfolioShort ? b.modifiedDuration - a.modifiedDuration : a.modifiedDuration - b.modifiedDuration).slice(0, TOP_N_CANDIDATES);
            const buyCandidates = [...buyUniverse].sort((a,b) => isPortfolioShort ? a.modifiedDuration - b.modifiedDuration : b.modifiedDuration - a.modifiedDuration).slice(0, TOP_N_CANDIDATES);

            for (const sellBond of sellCandidates) {
                for (const buyBond of buyCandidates) {
                    const initialTradeValue = Math.min(tradeValueIncrement, maxTradeValue - totalTradedValue, sellBond.marketValue);
                    if (initialTradeValue < MIN_TRADE_SIZE) continue;

                    // Apply trade size constraints
                    const sellConstraints = getTradeConstraints(sellBond);
                    const sellIncrementValue = sellConstraints.tradeIncrement * (sellBond.price / 100);
                    const adjustedTradeValue = Math.floor(initialTradeValue / sellIncrementValue) * sellIncrementValue;

                    const finalSellNotional = adjustedTradeValue / (sellBond.price / 100);
                    const finalBuyNotional = adjustedTradeValue / (buyBond.price / 100);

                    const buyConstraints = getTradeConstraints(buyBond);

                    if (finalSellNotional < sellConstraints.minTradeSize || finalBuyNotional < buyConstraints.minTradeSize) {
                        continue;
                    }

                    const sellTrade = createTradeObject('SELL', sellBond, finalSellNotional, pairIdCounter);
                    const buyTrade = createTradeObject('BUY', buyBond, finalBuyNotional, pairIdCounter);

                    const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                    const tempPortfolio = calculatePortfolioMetrics(tempBonds);

                    const newDurGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                    const newTE = calculateTrackingError(tempPortfolio, benchmark);
                    const newBreachDistance = getDurationBreachDistance(newDurGap, params.maxDurationShortfall, params.maxDurationSurplus);
                    
                    let score;
                    if (isInBreach) {
                        // STAGE 1: Ruthlessly fix the breach. Only score based on breach improvement.
                        score = currentBreachDistance - newBreachDistance;
                        rationaleSteps.push(`Goal: Fix duration gap of ${currentDurationGap.toFixed(2)} yrs.`);
                    } else {
                        // STAGE 2: Optimize TE, but do not allow a new breach.
                        if (newBreachDistance > 0) {
                            score = -Infinity; // Forbid any trade that causes a new breach
                        } else {
                            const teImprovement = currentTE - newTE;
                            const yieldPenalty = Math.max(0, currentPortfolio.averageYield - tempPortfolio.averageYield);
                            score = (10 * teImprovement) - (5 * yieldPenalty);
                            rationaleSteps.push(`Goal: Reduce tracking error from ${currentTE.toFixed(2)} bps.`);
                        }
                    }
                    
                    if (isNaN(score)) continue;

                    if (bestPair === null || score > bestPair.score) {
                        bestPair = { sell: sellTrade, buy: buyTrade, score };
                    }
                }
            }

            if (bestPair && bestPair.score > 0) {
                const tradesForThisStep = [bestPair.sell, bestPair.buy];
                totalTradedValue += bestPair.sell.marketValue;
                proposedTrades.push(...tradesForThisStep);
                
                const newBonds = applyTradesToPortfolio(currentBonds, tradesForThisStep, bondMasterData);
                currentPortfolio = calculatePortfolioMetrics(newBonds);
                currentBonds = currentPortfolio.bonds;
                
                buyUniverse = buyUniverse.filter(b => b.isin !== bestPair!.buy.isin);
                pairIdCounter++;
            } else {
                rationaleSteps.push("Halted: No further beneficial trades found that satisfy all constraints.");
                break;
            }
            iterations++;
        }
    } 
    else if (mode === 'sell-only' || mode === 'buy-only') {
        // This is a simplified block for buy/sell only modes, can be expanded with similar logic
        rationaleSteps.push(`Mode '${mode}' is not fully implemented with the new logic yet.`);
    }

    // --- 3. FINALIZATION ---
    if (proposedTrades.length === 0) {
        return emptyResult("Portfolio is already optimal given the constraints, or no suitable trades were found in the universe.");
    }
    
    const finalPortfolio = calculatePortfolioMetrics(currentBonds);
    const afterMetrics = calculateImpactMetrics(finalPortfolio, benchmark);
    
    const finalTradedValue = proposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
    const estimatedFeeCost = (mode === 'switch' ? finalTradedValue / 2 : finalTradedValue) * (transactionCost / 10000);
    const estimatedSpreadCost = proposedTrades.reduce((sum, trade) => sum + trade.spreadCost, 0);
    const estimatedCost = estimatedFeeCost + estimatedSpreadCost;

    const uniqueRationale = [...new Set(rationaleSteps.filter(s => s.startsWith("Goal:") || s.startsWith("Halted:")))].join(' ');
    
    const aggregateFeeBps = proposedTrades.length * transactionCost;

    return {
        proposedTrades,
        impactAnalysis: { before: beforeMetrics, after: afterMetrics },
        estimatedCost,
        estimatedFeeCost,
        estimatedSpreadCost,
        estimatedCostBpsOfNav: initialPortfolio.totalMarketValue > 0 ? (estimatedCost / initialPortfolio.totalMarketValue) * 10000 : 0,
        aggregateFeeBps,
        rationale: uniqueRationale,
    };
  } catch (e: any) {
    console.error("Critical error in optimizer service:", e);
    // Re-throw a user-friendly error that the UI component can display.
    throw new Error(`The optimization engine failed. This is often caused by invalid data (e.g., text in a numeric column) in the bond master CSV. Original error: ${e.message}`);
  }
};