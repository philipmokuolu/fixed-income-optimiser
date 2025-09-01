export enum Currency {
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
}

export const KRD_TENORS = ['1y', '2y', '3y', '5y', '7y', '10y'] as const;
export type KrdTenor = (typeof KRD_TENORS)[number];
export type KrdKey = `krd_${KrdTenor}`;

// Interface for objects containing flattened KRD fields
export interface KRDFields {
  krd_1y: number;
  krd_2y: number;
  krd_3y: number;
  krd_5y: number;
  krd_7y: number;
  krd_10y: number;
}

// Represents the user's input for portfolio holdings: ISIN and notional amount
export interface PortfolioHolding {
    isin: string;
    notional: number;
}

// Represents the user's input for benchmark holdings: ISIN and weight
export interface BenchmarkHolding {
    isin: string;
    weight: number;
}

// Represents the master data for a bond, excluding position-specific details.
export interface BondStaticData extends Omit<Bond, 'isin' | 'notional' | 'marketValue' | 'marketValueUSD' | 'portfolioWeight' | 'durationContribution'> {
  bidAskSpread: number;
  minTradeSize?: number;
  tradeIncrement?: number;
}

// Data structure for a single bond holding in the portfolio
export interface Bond extends KRDFields {
  isin: string;
  name: string;
  currency: Currency;
  maturityDate: string;
  coupon: number;
  price: number; // Price per 100
  notional: number;
  marketValue: number; // Calculated field in LOCAL currency: notional * price / 100
  marketValueUSD: number; // Calculated field in BASE currency (USD)
  portfolioWeight: number; // Calculated field based on marketValueUSD
  durationContribution: number; // Calculated field
  yieldToMaturity: number;
  modifiedDuration: number;
  creditRating: string;
  liquidityScore: number;
  bidAskSpread: number;
  minTradeSize?: number;
  tradeIncrement?: number;
}

// Aggregate data for the entire portfolio
export interface Portfolio extends KRDFields {
  bonds: Bond[];
  totalMarketValue: number; // This will now be in the base currency (USD)
  modifiedDuration: number;
  averageYield: number;
}

// Represents the user's manual input for top-level benchmark data
export interface BenchmarkAggregate {
  name: string;
  ticker: string;
  modifiedDuration: number;
}

// Final combined data structure for the benchmark
export interface Benchmark extends BenchmarkAggregate, KRDFields {}

export interface OptimizationParams {
  maxDurationShortfall: number;
  maxDurationSurplus: number;
  maxTurnover: number;
  transactionCost: number;
  excludedBonds: string[]; // by isin
  mode: 'switch' | 'buy-only' | 'sell-only';
  investmentHorizonLimit: number;
  minimumPurchaseRating: string;
  minimumYield?: number;
  cashToRaise?: number;
  newCashToInvest?: number;
  // New strategic targeting params
  isTargetingMode: boolean;
  targetDurationGap?: number;
}

export interface ProposedTrade {
  action: 'BUY' | 'SELL';
  isin: string;
  name: string;
  notional: number;
  marketValue: number;
  price: number;
  modifiedDuration: number;
  yieldToMaturity: number;
  pairId: number; // To link buy/sell pairs
  spreadCost: number;
  creditRating: string;
}

export interface ImpactMetrics {
    modifiedDuration: number;
    durationGap: number;
    trackingError: number;
    yield: number;
    portfolio: Portfolio; // The full portfolio object for this state
}

export interface OptimizationResult {
  proposedTrades: ProposedTrade[];
  impactAnalysis: {
    before: ImpactMetrics;
    after: ImpactMetrics;
  };
  estimatedCost: number; // Dollar value
  estimatedFeeCost: number;
  estimatedSpreadCost: number;
  estimatedCostBpsOfNav: number; // Cost as bps of total portfolio value
  aggregateFeeBps: number; // Sum of per-trade bps costs (e.g., 2 trades * 20 bps = 40)
  rationale?: string;
}

// New type for application-wide user settings
export interface AppSettings {
    maxDurationShortfall: number;
    maxDurationSurplus: number;
}

// Type for hypothetical trades in sandbox
export interface HypotheticalTrade {
    id: number; // Unique ID for stable rendering and deletion
    isin: string;
    name: string;
    action: 'BUY' | 'SELL';
    notional: number;
}

// Type for FX rates against a base currency (USD)
export type FxRates = Record<string, number>;