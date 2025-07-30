import React, { useState, useCallback, useMemo } from 'react';
import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, BondStaticData, ProposedTrade } from '@/types';
import { Card } from '@/components/shared/Card';
import { runOptimizer } from '@/services/optimizerService';
import { formatNumber, formatCurrency } from '@/utils/formatting';

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
                <p className="text-lg font-mono text-slate-300 w-32 text-right">{formatNumber(b, {minimumFractionDigits: 2})} {u}</p>
                <span className="text-orange-400 font-bold text-xl">→</span>
                <p className="text-lg font-mono text-green-400 w-32 text-right">{formatNumber(a, {minimumFractionDigits: 2})} {u}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="lg:col-span-2">
        <h4 className="text-lg font-semibold text-slate-200 mb-3">Proposed Trades</h4>
        <div className="max-h-60 overflow-y-auto pr-2">
          {result.proposedTrades.length > 0 ? (
            <table className="min-w-full text-sm">
                <thead className="border-b border-slate-700">
                    <tr>
                        <th className="py-2 text-left text-slate-400 font-semibold">Action</th>
                        <th className="py-2 text-left text-slate-400 font-semibold">ISIN</th>
                        <th className="py-2 text-left text-slate-400 font-semibold">Name</th>
                        <th className="py-2 text-right text-slate-400 font-semibold">M.Val</th>
                        <th className="py-2 text-right text-slate-400 font-semibold">Notional</th>
                        <th className="py-2 text-right text-slate-400 font-semibold">Price</th>
                        <th className="py-2 text-right text-slate-400 font-semibold">Dur</th>
                        <th className="py-2 text-right text-slate-400 font-semibold">YTM</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                    {result.proposedTrades.map((trade: ProposedTrade, index) => (
                      <tr key={index}>
                          <td className={`py-2.5 font-bold ${trade.action === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{trade.action}</td>
                          <td className="py-2.5 font-mono text-orange-400">{trade.isin}</td>
                          <td className="py-2.5 text-slate-300 truncate max-w-xs">{trade.name}</td>
                          <td className="py-2.5 font-mono text-slate-200 text-right">{formatCurrency(trade.marketValue, 0, 0)}</td>
                          <td className="py-2.5 font-mono text-slate-200 text-right">{formatNumber(trade.notional, {maximumFractionDigits: 0})}</td>
                          <td className="py-2.5 font-mono text-slate-200 text-right">{formatNumber(trade.price, {minimumFractionDigits: 2})}</td>
                          <td className="py-2.5 font-mono text-slate-200 text-right">{formatNumber(trade.modifiedDuration, {minimumFractionDigits: 2})}</td>
                          <td className="py-2.5 font-mono text-slate-200 text-right">{formatNumber(trade.yieldToMaturity, {minimumFractionDigits: 2})}%</td>
                      </tr>
                    ))}
                </tbody>
            </table>
          ) : <p className="py-2.5 text-slate-500">No trades recommended. Portfolio is optimal.</p>}
        </div>
      </div>
      
       {result.rationale && (
          <div className="lg:col-span-2 border-t border-slate-800 pt-4">
            <h4 className="text-lg font-semibold text-slate-200 mb-2">Rationale</h4>
            <p className="text-sm text-slate-400 bg-slate-950 p-3 rounded-md">{result.rationale}</p>
          </div>
        )}

      <div className="lg:col-span-2 border-t border-slate-800 pt-4">
        <h4 className="text-lg font-semibold text-slate-200 mb-3">Cost-Benefit Summary</h4>
         <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-slate-950 p-3 rounded-md">
            <div className="text-center">
                <p className="text-sm text-slate-400">Total Cost ($)</p>
                <p className="text-xl font-mono text-orange-400">{formatCurrency(result.estimatedCost, 2, 2)}</p>
            </div>
            <div className="text-center">
                <p className="text-sm text-slate-400">Cost (bps of NAV)</p>
                <p className="text-xl font-mono text-orange-400">{formatNumber(result.estimatedCostBpsOfNav, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
            </div>
             <div className="text-center">
                <p className="text-sm text-slate-400">Aggregate Trade Cost (bps)</p>
                <p className="text-xl font-mono text-orange-400">{formatNumber(result.estimatedCostBpsPerTradeSum)}</p>
            </div>
            <div className="text-center md:col-span-3 border-t border-slate-700 pt-3 mt-2">
                <p className="text-sm text-slate-400">Projected Tracking Error Reduction</p>
                <p className="text-xl font-mono text-green-400">
                    {formatNumber(result.impactAnalysis.before.trackingError - result.impactAnalysis.after.trackingError, {minimumFractionDigits: 2})} bps
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
    mode: 'switch',
  });
  
  const [turnoverStr, setTurnoverStr] = useState(params.maxTurnover.toString());
  const [costStr, setCostStr] = useState(params.transactionCost.toString());
  
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eligibilitySearch, setEligibilitySearch] = useState('');

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
    setTimeout(() => {
        try {
          const turnoverNum = Number(turnoverStr);
          const costNum = Number(costStr);
          const finalParams = { ...params, maxTurnover: turnoverNum, transactionCost: costNum };
          const res = runOptimizer(portfolio, benchmark, finalParams, bondMasterData);
          setResult(res);
        } catch (err: any) {
          setError(err.message || 'An unknown error occurred during calculation.');
        } finally {
          setIsLoading(false);
        }
    }, 500);
  }, [portfolio, benchmark, params, bondMasterData, turnoverStr, costStr]);
  
  const filteredBonds = useMemo(() => {
      if (!eligibilitySearch) return portfolio.bonds;
      return portfolio.bonds.filter(b => 
          b.name.toLowerCase().includes(eligibilitySearch.toLowerCase()) ||
          b.isin.toLowerCase().includes(eligibilitySearch.toLowerCase())
      );
  }, [portfolio.bonds, eligibilitySearch]);


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
                <input type="number" id="maxTurnover" value={turnoverStr} onChange={e => setTurnoverStr(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
              </div>
              <div>
                <label htmlFor="transactionCost" className="block text-sm font-medium text-slate-300">Transaction Cost per Trade (bps)</label>
                <input type="number" id="transactionCost" value={costStr} onChange={e => setCostStr(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
              </div>
              <div>
                <span className="block text-sm font-medium text-slate-300">Optimisation Mode</span>
                 <div className="mt-2 grid grid-cols-2 gap-2 rounded-md bg-slate-800 p-1">
                    <button onClick={() => handleParamChange('mode', 'switch')} className={`px-3 py-1.5 text-sm font-semibold rounded ${params.mode === 'switch' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>Switch Trades</button>
                    <button onClick={() => handleParamChange('mode', 'buy-only')} className={`px-3 py-1.5 text-sm font-semibold rounded ${params.mode === 'buy-only' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>Buy Only</button>
                </div>
                <p className="text-xs text-slate-500 mt-1">{params.mode === 'switch' ? 'Assumes cash-neutral trades (sell to buy).' : 'Assumes fund inflow (only buy trades).'}</p>
              </div>
            </div>
          </Card>
          <Card>
            <h3 className="text-lg font-semibold text-slate-200 mb-2">Bond Eligibility</h3>
            <p className="text-sm text-slate-500 mb-3">Untick bonds to exclude them from being sold in the optimisation.</p>
            <input 
                type="text" 
                placeholder="Search by ISIN or name..."
                value={eligibilitySearch}
                onChange={e => setEligibilitySearch(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none mb-3"
            />
            <div className="max-h-80 overflow-y-auto space-y-1 pr-2 border-t border-slate-800 pt-2">
              {filteredBonds.map(bond => (
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
