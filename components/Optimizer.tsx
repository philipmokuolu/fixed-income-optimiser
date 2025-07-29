import React, { useState, useCallback } from 'react';
import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, BondStaticData } from '@/types';
import { Card } from '@/components/shared/Card';
import { runOptimizer } from '@/services/optimizerService';

interface OptimiserProps {
  portfolio: Portfolio;
  benchmark: Benchmark;
  bondMasterData: Record<string, BondStaticData>;
}

const LoadingSpinner: React.FC = () => (
  <div className="flex items-center justify-center space-x-2">
    <div className="w-4 h-4 rounded-full animate-pulse bg-orange-400"></div>
    <div className="w-4 h-4 rounded-full animate-pulse bg-orange-400" style={{ animationDelay: '0.2s' }}></div>
    <div className="w-4 h-4 rounded-full animate-pulse bg-orange-400" style={{ animationDelay: '0.4s' }}></div>
    <span className="text-slate-200">Calculating...</span>
  </div>
);

const ResultsDisplay: React.FC<{ result: OptimizationResult }> = ({ result }) => (
  <Card className="mt-6">
    <h3 className="text-xl font-bold text-white mb-4">Optimisation Results</h3>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-6">
      <div>
        <h4 className="text-lg font-semibold text-slate-200 mb-3">Impact Analysis (Before → After)</h4>
        <div className="space-y-3">
          {Object.entries({
            'Modified Duration': { b: result.impactAnalysis.before.modifiedDuration, a: result.impactAnalysis.after.modifiedDuration, u: 'yrs' },
            'Duration Gap': { b: result.impactAnalysis.before.durationGap, a: result.impactAnalysis.after.durationGap, u: 'yrs' },
            'Tracking Error': { b: result.impactAnalysis.before.trackingError, a: result.impactAnalysis.after.trackingError, u: 'bps' },
            'Portfolio Yield': { b: result.impactAnalysis.before.yield, a: result.impactAnalysis.after.yield, u: '%' },
          }).map(([key, {b, a, u}]) => (
            <div key={key}>
              <p className="text-sm text-slate-400">{key}</p>
              <div className="flex items-center space-x-4">
                <p className="text-lg font-mono text-slate-300 w-32 text-right">{b.toFixed(2)} {u}</p>
                <span className="text-orange-400 font-bold text-xl">→</span>
                <p className="text-lg font-mono text-green-400 w-32 text-right">{a.toFixed(2)} {u}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="text-lg font-semibold text-slate-200 mb-3">Proposed Trades</h4>
        <div className="max-h-60 overflow-y-auto pr-2">
          <ul className="divide-y divide-slate-800">
            {result.proposedTrades.length > 0 ? result.proposedTrades.map((trade, index) => (
              <li key={index} className="py-2.5">
                <div className="flex justify-between items-center">
                  <div>
                    <span className={`font-bold mr-3 ${trade.action === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{trade.action}</span>
                    <span className="text-slate-300">{trade.bondName}</span>
                  </div>
                  <span className="font-mono text-slate-200">${trade.amount.toLocaleString()}</span>
                </div>
              </li>
            )) : <li className="py-2.5 text-slate-500">No trades recommended. Portfolio is optimal.</li>}
          </ul>
        </div>
      </div>

      <div className="lg:col-span-2 border-t border-slate-800 pt-4">
        <h4 className="text-lg font-semibold text-slate-200 mb-3">Cost-Benefit Summary</h4>
         <div className="flex justify-around items-center bg-slate-950 p-3 rounded-md">
            <div className="text-center">
                <p className="text-sm text-slate-400">Est. Transaction Cost</p>
                <p className="text-xl font-mono text-orange-400">{result.estimatedCost?.toFixed(2) ?? 'N/A'} bps</p>
            </div>
            <div className="h-12 w-px bg-slate-700"></div>
            <div className="text-center">
                <p className="text-sm text-slate-400">Tracking Error Reduction</p>
                <p className="text-xl font-mono text-green-400">
                    {(result.impactAnalysis.before.trackingError - result.impactAnalysis.after.trackingError).toFixed(2)} bps
                </p>
            </div>
        </div>
      </div>
    </div>
  </Card>
);

export const Optimiser: React.FC<OptimiserProps> = ({ portfolio, benchmark, bondMasterData }) => {
  const [params, setParams] = useState<OptimizationParams>({
    durationGapThreshold: 0.3,
    maxTurnover: 10,
    minPositionSize: 1,
    maxPositionSize: 20,
    transactionCost: 5,
    excludedBonds: [],
  });
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleParamChange = (field: keyof OptimizationParams, value: any) => {
    setParams(prev => ({ ...prev, [field]: value }));
  };
  
  const handleCheckboxChange = (bondId: string) => {
    setParams(prev => {
        const excludedBonds = prev.excludedBonds.includes(bondId)
            ? prev.excludedBonds.filter(id => id !== bondId)
            : [...prev.excludedBonds, bondId];
        return {...prev, excludedBonds};
    });
  };

  const runOptimiserCallback = useCallback(() => {
    setIsLoading(true);
    setError(null);
    setResult(null);
    // Simulate async calculation for better UX
    setTimeout(() => {
        try {
          const res = runOptimizer(portfolio, benchmark, params, bondMasterData);
          setResult(res);
        } catch (err: any) {
          setError(err.message || 'An unknown error occurred during calculation.');
        } finally {
          setIsLoading(false);
        }
    }, 500);
  }, [portfolio, benchmark, params, bondMasterData]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">The Optimiser</h1>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-1 space-y-6">
          <Card>
            <h3 className="text-lg font-semibold text-slate-200 mb-4">Setup & Constraints</h3>
            <div className="space-y-4">
              <div>
                <label htmlFor="maxTurnover" className="block text-sm font-medium text-slate-300">Max Turnover (%)</label>
                <input type="number" id="maxTurnover" value={params.maxTurnover} onChange={e => handleParamChange('maxTurnover', Number(e.target.value))} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
              </div>
              <div>
                <label htmlFor="transactionCost" className="block text-sm font-medium text-slate-300">Transaction Cost (bps)</label>
                <input type="number" id="transactionCost" value={params.transactionCost} onChange={e => handleParamChange('transactionCost', Number(e.target.value))} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
              </div>
            </div>
          </Card>
          <Card>
            <h3 className="text-lg font-semibold text-slate-200 mb-4">Bond Eligibility</h3>
            <p className="text-sm text-slate-500 mb-3">Untick bonds to exclude them from being sold in the optimisation.</p>
            <div className="max-h-96 overflow-y-auto space-y-1 pr-2 border-t border-slate-800 pt-2">
              {portfolio.bonds.map(bond => (
                  <div key={bond.isin} className="flex items-center p-1 rounded-md hover:bg-slate-800">
                      <input
                          id={`exclude-${bond.isin}`}
                          type="checkbox"
                          checked={!params.excludedBonds.includes(bond.isin)}
                          onChange={() => handleCheckboxChange(bond.isin)}
                          className="h-4 w-4 rounded border-slate-600 bg-slate-700 text-orange-600 focus:ring-orange-500 cursor-pointer"
                      />
                      <label htmlFor={`exclude-${bond.isin}`} className="ml-3 text-sm text-slate-300 truncate cursor-pointer" title={bond.name}>
                          {bond.name}
                      </label>
                  </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="xl:col-span-2">
          <Card>
            <h3 className="text-lg font-semibold text-slate-200 mb-4">Execution</h3>
            <p className="text-sm text-slate-400 mb-4">Click "Run Optimiser" to generate a set of trades to minimise tracking error based on your constraints.</p>
            <button
              onClick={runOptimiserCallback}
              disabled={isLoading}
              className="w-full bg-orange-600 text-white font-bold py-3 px-4 rounded-md hover:bg-orange-700 disabled:bg-slate-700 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
            >
              {isLoading ? <LoadingSpinner /> : 'Run Optimiser'}
            </button>
          </Card>
          {error && <Card className="mt-6 border border-red-500/50"><p className="text-red-400 text-center">{error}</p></Card>}
          {result && <ResultsDisplay result={result} />}
        </div>
      </div>
    </div>
  );
};