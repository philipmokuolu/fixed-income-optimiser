import { BenchmarkHolding } from '@/types';

// This is a new placeholder data file.
// Represents the constituent holdings of the benchmark for KRD calculation.
// Weights should ideally sum to 1.
export const benchmarkHoldings: BenchmarkHolding[] = [
  { isin: 'US037833BY05', weight: 0.20 },
  { isin: 'US912828H451', weight: 0.25 },
  { isin: 'US594918BT09', weight: 0.25 },
  { isin: 'US88579YBK93', weight: 0.30 },
];
