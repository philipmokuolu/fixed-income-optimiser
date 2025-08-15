import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, KrdKey, KRD_TENORS, Bond, ProposedTrade, BondStaticData, ImpactMetrics, Currency } from '@/types';
import { calculatePortfolioMetrics, applyTradesToPortfolio, calculateTrackingError } from './portfolioService';
import { formatNumber, formatCurrency } from '@/utils/formatting';

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
    const wasInitiallyInBreach = getDurationBreachDistance(beforeMetrics.durationGap, params.maxDurationShortfall, params.maxDurationSurplus) > 0;

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
    let iterations = 0;

    // --- 2. MAIN LOGIC ---

    if (mode === 'switch') {
        let totalTradedValue = 0;
        const maxTradeValue = (maxTurnover / 100) * initialPortfolio.totalMarketValue;

        while (totalTradedValue < maxTradeValue && iterations < MAX_ITERATIONS) {
            const currentDurationGap = currentPortfolio.modifiedDuration - benchmark.modifiedDuration;
            const currentTE = calculateTrackingError(currentPortfolio, benchmark);
            const currentBreachDistance = getDurationBreachDistance(currentDurationGap, params.maxDurationShortfall, params.maxDurationSurplus);
            
            const isInBreach = currentBreachDistance > 0;
            
            rationaleSteps.push(`\n--- Iteration ${iterations + 1} ---`);
            rationaleSteps.push(`Current State: Duration Gap = ${formatNumber(currentDurationGap)} yrs, TE = ${formatNumber(currentTE)} bps.`);

            if (!isInBreach && currentTE < 1.0) { 
                rationaleSteps.push("Halt Condition: Portfolio is within duration limits and tracking error is already minimal.");
                break;
            }

            const sellableBonds = currentBonds.filter(b => !params.excludedBonds.includes(b.isin));
            if (sellableBonds.length === 0 || buyUniverse.length === 0) {
                rationaleSteps.push("Halt Condition: No eligible bonds available to sell or buy.");
                break;
            }

            let bestPair: { sell: ProposedTrade, buy: ProposedTrade, score: number } | null = null;
            
            const needsToIncreaseDuration = currentDurationGap < -params.maxDurationShortfall;
            const needsToDecreaseDuration = currentDurationGap > params.maxDurationSurplus;
            
            // Heuristically sort candidates to check the most promising ones first
            const sellCandidates = [...sellableBonds].sort((a,b) => needsToIncreaseDuration ? a.modifiedDuration - b.modifiedDuration : b.modifiedDuration - a.modifiedDuration).slice(0, TOP_N_CANDIDATES);
            const buyCandidates = [...buyUniverse].sort((a,b) => needsToIncreaseDuration ? b.modifiedDuration - a.modifiedDuration : a.modifiedDuration - b.modifiedDuration).slice(0, TOP_N_CANDIDATES);

            for (const sellBond of sellCandidates) {
                for (const buyBond of buyCandidates) {

                    const durationDiff = buyBond.modifiedDuration - sellBond.modifiedDuration;
                    if ( (needsToIncreaseDuration && durationDiff <= 0) || (needsToDecreaseDuration && durationDiff >= 0) ) {
                        continue; // Skip pairs that move duration in the wrong direction
                    }
                    
                    let tradeMarketValue: number;

                    if (isInBreach) {
                        // **INTELLIGENT TARGETING**: Aim to fix only the breached portion of the gap.
                        let gapToFix = 0;
                        if (currentDurationGap < -params.maxDurationShortfall) {
                            gapToFix = currentDurationGap - (-params.maxDurationShortfall); // e.g., -0.26 - (-0.1) = -0.16
                        } else if (currentDurationGap > params.maxDurationSurplus) {
                            gapToFix = currentDurationGap - params.maxDurationSurplus; // e.g., 0.25 - 0.1 = 0.15
                        }
                        
                        // Calculate the ideal trade size to get back to the boundary
                        const idealTradeMV = Math.abs((-gapToFix * currentPortfolio.totalMarketValue) / durationDiff);

                        const maxAllowedTradeMV = Math.min(
                            maxTradeValue - totalTradedValue,
                            sellBond.marketValue
                        );
                        const sellConstraints = getTradeConstraints(sellBond);
                        const minSellNotionalAsMV = sellConstraints.minTradeSize * (sellBond.price / 100);
                        const buyConstraints = getTradeConstraints(buyBond);
                        const minBuyNotionalAsMV = buyConstraints.minTradeSize * (buyBond.price / 100);
                        const minPracticalMV = Math.max(minSellNotionalAsMV, minBuyNotionalAsMV);
                        
                        if (minPracticalMV > maxAllowedTradeMV) {
                            continue; // This trade is impossible at any practical size
                        }
                        
                        // Determine the best effort trade size
                        if (idealTradeMV > maxAllowedTradeMV) {
                            tradeMarketValue = maxAllowedTradeMV; // Cap at max
                        } else if (idealTradeMV < minPracticalMV) {
                            tradeMarketValue = minPracticalMV; // Use minimum practical size if ideal is too small
                        } else {
                            tradeMarketValue = idealTradeMV; // Ideal trade is possible
                        }

                    } else {
                        // When not in breach, use a smaller, exploratory trade size
                        tradeMarketValue = Math.min(maxTradeValue / 10, sellBond.marketValue);
                    }
                    
                    if (tradeMarketValue <= 0) continue;

                    let sellNotional = tradeMarketValue / (sellBond.price / 100);
                    let buyNotional = tradeMarketValue / (buyBond.price / 100);

                    // Apply increments and check against minimums again after rounding
                    const sellConstraints = getTradeConstraints(sellBond);
                    sellNotional = Math.floor(sellNotional / sellConstraints.tradeIncrement) * sellConstraints.tradeIncrement;
                    
                    const buyConstraints = getTradeConstraints(buyBond);
                    buyNotional = Math.floor(buyNotional / buyConstraints.tradeIncrement) * buyConstraints.tradeIncrement;

                    if (sellNotional < sellConstraints.minTradeSize || buyNotional < buyConstraints.minTradeSize) {
                        continue;
                    }
                    
                    const sellTrade = createTradeObject('SELL', sellBond, sellNotional, pairIdCounter);
                    const buyTrade = createTradeObject('BUY', buyBond, buyNotional, pairIdCounter);

                    const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade, buyTrade], bondMasterData);
                    const tempPortfolio = calculatePortfolioMetrics(tempBonds);

                    const newDurGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                    const newTE = calculateTrackingError(tempPortfolio, benchmark);
                    const newBreachDistance = getDurationBreachDistance(newDurGap, params.maxDurationShortfall, params.maxDurationSurplus);
                    
                    let score;
                    if (isInBreach) {
                        const breachImprovement = currentBreachDistance - newBreachDistance;
                        const teWorsening = newTE - currentTE; 
                        score = (1000 * breachImprovement) - teWorsening;
                    } else {
                        // If not in breach, score based on TE, but penalize going into breach.
                        if (newBreachDistance > 0) { 
                            score = -Infinity;
                        } else {
                            const teImprovement = currentTE - newTE;
                            const yieldPenalty = Math.max(0, currentPortfolio.averageYield - tempPortfolio.averageYield);
                            score = (10 * teImprovement) - (5 * yieldPenalty);
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
                rationaleSteps.push(`Action: Execute trade. Sell ${bestPair.sell.name}, Buy ${bestPair.buy.name}. Score: ${formatNumber(bestPair.score)}.`);

                totalTradedValue += bestPair.sell.marketValue;
                proposedTrades.push(...tradesForThisStep);
                
                const newBonds = applyTradesToPortfolio(currentBonds, tradesForThisStep, bondMasterData);
                currentPortfolio = calculatePortfolioMetrics(newBonds);
                currentBonds = currentPortfolio.bonds;
                
                buyUniverse = buyUniverse.filter(b => b.isin !== bestPair!.buy.isin);
                pairIdCounter++;
            } else {
                rationaleSteps.push("Halt Condition: No further beneficial trades found that improve the portfolio's risk profile.");
                break;
            }
            iterations++;
        }
    } 
    else if (mode === 'buy-only') {
        let cashToSpend = params.newCashToInvest ?? 0;
        rationaleSteps.push(`Starting Buy-Only mode with ${formatCurrency(cashToSpend)} to invest.`);
    
        while (cashToSpend > MIN_TRADE_SIZE && iterations < MAX_ITERATIONS) {
            const currentDurationGap = currentPortfolio.modifiedDuration - benchmark.modifiedDuration;
            const currentTE = calculateTrackingError(currentPortfolio, benchmark);
    
            let bestBuy: { trade: ProposedTrade, score: number } | null = null;
            
            for (const buyBond of buyUniverse) {
                const buyConstraints = getTradeConstraints(buyBond);
                const maxBuyNotional = cashToSpend / (buyBond.price / 100);
                
                if (maxBuyNotional < buyConstraints.minTradeSize) continue;
    
                let buyNotional = Math.floor(maxBuyNotional / buyConstraints.tradeIncrement) * buyConstraints.tradeIncrement;
                if (buyNotional < buyConstraints.minTradeSize) continue;
    
                const buyTrade = createTradeObject('BUY', buyBond, buyNotional, pairIdCounter);
                
                const tempBonds = applyTradesToPortfolio(currentBonds, [buyTrade], bondMasterData);
                const tempPortfolio = calculatePortfolioMetrics(tempBonds);
    
                const newDurGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                const newTE = calculateTrackingError(tempPortfolio, benchmark);
                
                const currentBreachDistance = getDurationBreachDistance(currentDurationGap, params.maxDurationShortfall, params.maxDurationSurplus);
                const newBreachDistance = getDurationBreachDistance(newDurGap, params.maxDurationShortfall, params.maxDurationSurplus);
                
                let score;
                if (currentBreachDistance > 0) {
                    const breachImprovement = currentBreachDistance - newBreachDistance;
                    const teWorsening = newTE - currentTE;
                    score = (1000 * breachImprovement) - teWorsening;
                } else {
                    if (newBreachDistance > 0) {
                        score = -Infinity;
                    } else {
                        const teImprovement = currentTE - newTE;
                        const yieldImprovement = tempPortfolio.averageYield - currentPortfolio.averageYield;
                        score = (10 * teImprovement) + (5 * yieldImprovement);
                    }
                }
                if (isNaN(score)) continue;
    
                if (bestBuy === null || score > bestBuy.score) {
                    bestBuy = { trade: buyTrade, score };
                }
            }
            
            if (bestBuy && bestBuy.score > 0) {
                rationaleSteps.push(`Action: Buy ${formatCurrency(bestBuy.trade.notional)} of ${bestBuy.trade.name}.`);
                proposedTrades.push(bestBuy.trade);
                cashToSpend -= bestBuy.trade.marketValue;
                
                const newBonds = applyTradesToPortfolio(currentBonds, [bestBuy.trade], bondMasterData);
                currentPortfolio = calculatePortfolioMetrics(newBonds);
                currentBonds = currentPortfolio.bonds;
                
                buyUniverse = buyUniverse.filter(b => b.isin !== bestBuy!.trade.isin);
                pairIdCounter++;
            } else {
                rationaleSteps.push("Halt Condition: No further beneficial buy trades found.");
                break;
            }
            iterations++;
        }
    }
    else if (mode === 'sell-only') {
        let cashRaised = 0;
        const cashToRaise = params.cashToRaise ?? 0;
        rationaleSteps.push(`Starting Sell-Only mode with a target of ${formatCurrency(cashToRaise)} to raise.`);
    
        while (cashRaised < cashToRaise && iterations < MAX_ITERATIONS) {
            const sellableBonds = currentBonds.filter(b => !params.excludedBonds.includes(b.isin));
            if (sellableBonds.length === 0) {
                rationaleSteps.push("Halt Condition: No more bonds available to sell.");
                break;
            }
    
            const currentDurationGap = currentPortfolio.modifiedDuration - benchmark.modifiedDuration;
            const currentTE = calculateTrackingError(currentPortfolio, benchmark);
    
            let bestSell: { trade: ProposedTrade, score: number } | null = null;
            
            for (const sellBond of sellableBonds) {
                const cashStillNeeded = cashToRaise - cashRaised;
                const maxSellMV = Math.min(sellBond.marketValue, cashStillNeeded);
                
                let sellNotional = maxSellMV / (sellBond.price / 100);
                const sellConstraints = getTradeConstraints(sellBond);
                
                if (sellNotional < sellConstraints.minTradeSize) continue;
                sellNotional = Math.floor(sellNotional / sellConstraints.tradeIncrement) * sellConstraints.tradeIncrement;
                if (sellNotional < sellConstraints.minTradeSize) continue;
    
                const sellTrade = createTradeObject('SELL', sellBond, sellNotional, pairIdCounter);
    
                const tempBonds = applyTradesToPortfolio(currentBonds, [sellTrade], bondMasterData);
                const tempPortfolio = calculatePortfolioMetrics(tempBonds);
    
                const newDurGap = tempPortfolio.modifiedDuration - benchmark.modifiedDuration;
                const newTE = calculateTrackingError(tempPortfolio, benchmark);
                
                // Scoring for sells is about minimizing harm. Higher score is better.
                const durGapWorsening = getDurationBreachDistance(newDurGap, params.maxDurationShortfall, params.maxDurationSurplus) - getDurationBreachDistance(currentDurationGap, params.maxDurationShortfall, params.maxDurationSurplus);
                const teWorsening = newTE - currentTE;
                const yieldWorsening = currentPortfolio.averageYield - tempPortfolio.averageYield;
                
                // We want to minimize worsening, so we negate the values.
                const score = (-1000 * durGapWorsening) + (-10 * teWorsening) + (-5 * yieldWorsening);
                if (isNaN(score)) continue;
    
                if (bestSell === null || score > bestSell.score) {
                    bestSell = { trade: sellTrade, score };
                }
            }
            
            if (bestSell) {
                 rationaleSteps.push(`Action: Sell ${formatCurrency(bestSell.trade.notional)} of ${bestSell.trade.name}.`);
                proposedTrades.push(bestSell.trade);
                cashRaised += bestSell.trade.marketValue;
    
                const newBonds = applyTradesToPortfolio(currentBonds, [bestSell.trade], bondMasterData);
                currentPortfolio = calculatePortfolioMetrics(newBonds);
                currentBonds = currentPortfolio.bonds;
    
                pairIdCounter++;
            } else {
                rationaleSteps.push("Halt Condition: No further sell trades found that meet criteria.");
                break;
            }
            iterations++;
        }
    }

    // --- 3. FINALIZATION ---
    if (proposedTrades.length === 0) {
        return emptyResult("The optimizer determined that the portfolio is already optimal given the specified constraints, or no suitable trades could be found in the bond universe to improve it.");
    }
    
    const finalPortfolio = calculatePortfolioMetrics(currentBonds);
    const afterMetrics = calculateImpactMetrics(finalPortfolio, benchmark);
    
    const finalTradedValue = proposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
    const estimatedFeeCost = (mode === 'switch' ? finalTradedValue / 2 : finalTradedValue) * (transactionCost / 10000);
    const estimatedSpreadCost = proposedTrades.reduce((sum, trade) => sum + trade.spreadCost, 0);
    const estimatedCost = estimatedFeeCost + estimatedSpreadCost;

    const summaryRationale = `The optimizer executed ${iterations} iteration(s) to improve the portfolio. \n${wasInitiallyInBreach ? `The primary goal was to fix the duration breach of ${formatNumber(beforeMetrics.durationGap)} years.` : `The primary goal was to reduce the tracking error of ${formatNumber(beforeMetrics.trackingError)} bps.`}\n${rationaleSteps[rationaleSteps.length -1]}`;
    
    const aggregateFeeBps = proposedTrades.length * transactionCost;

    return {
        proposedTrades,
        impactAnalysis: { before: beforeMetrics, after: afterMetrics },
        estimatedCost,
        estimatedFeeCost,
        estimatedSpreadCost,
        estimatedCostBpsOfNav: initialPortfolio.totalMarketValue > 0 ? (estimatedCost / initialPortfolio.totalMarketValue) * 10000 : 0,
        aggregateFeeBps,
        rationale: summaryRationale,
    };
  } catch (e: any) {
    console.error("Critical error in optimizer service:", e);
    // Re-throw a user-friendly error that the UI component can display.
    throw new Error(`The optimization engine failed. This is often caused by invalid data (e.g., text in a numeric column) in the bond master CSV. Original error: ${e.message}`);
  }
};