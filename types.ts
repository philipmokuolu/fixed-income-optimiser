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
export type BondStaticData = Omit<Bond, 'isin' | 'notional' | 'marketValue' | 'portfolioWeight' | 'durationContribution'>;

// Data structure for a single bond holding in the portfolio
export interface Bond extends KRDFields {
  isin: string;
  name: string;
  currency: Currency;
  maturityDate: string;
  coupon: number;
  price: number; // Price per 100
  notional: number;
  marketValue: number; // Calculated field: notional * price / 100
  portfolioWeight: number; // Calculated field: marketValue / totalMarketValue
  durationContribution: number; // Calculated field
  yieldToMaturity: number;
  modifiedDuration: number;
  creditRating: string;
  liquidityScore: number;
}

// Aggregate data for the entire portfolio
export interface Portfolio extends KRDFields {
  bonds: Bond[];
  totalMarketValue: number;
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
  durationGapThreshold: number;
  maxTurnover: number;
  minPositionSize: number;
  maxPositionSize: number;
  transactionCost: number;
  excludedBonds: string[]; // by isin
  mode: 'switch' | 'buy-only';
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
}

interface ImpactMetrics {
    modifiedDuration: number;
    durationGap: number;
    trackingError: number;
    yield: number;
}

export interface OptimizationResult {
  proposedTrades: ProposedTrade[];
  impactAnalysis: {
    before: ImpactMetrics;
    after: ImpactMetrics;
  };
  estimatedCost: number; // This is now a dollar value, not bps.
  rationale?: string;
}

// New type for application-wide user settings
export interface AppSettings {
    durationGapThreshold: number;
}

// Type for hypothetical trades in sandbox
export interface HypotheticalTrade {
    isin: string;
    name: string;
    action: 'BUY' | 'SELL';
    notional: number;
}
