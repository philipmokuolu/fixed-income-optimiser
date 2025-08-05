import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, BondStaticData, AppSettings, ProposedTrade } from '@/types';
import { Card } from '@/components/shared/Card';
import * as optimizerService from '@/services/optimizerService';
import { formatNumber, formatCurrency } from '@/utils/formatting';
import { calculatePortfolioMetrics } from '@/services/portfolioService';

interface OptimiserProps {
  portfolio: Portfolio;
  benchmark: Benchmark;
  bondMasterData: Record<string, BondStaticData>;
  appSettings: AppSettings;
}

const CREDIT_RATINGS = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'B-', 'CCC+', 'CCC', 'CCC-', 'CC', 'C', 'D'];

const ResultsDisplay: React.FC<{ result: OptimizationResult, onTradeToggle: (pairId: number) => void, activeTrades: Set<number> }> = ({ result, onTradeToggle, activeTrades }) => {
    const ImpactRow: React.FC<{label: string, before: number, after: number, unit: string, formatOpts?: Intl.NumberFormatOptions}> = ({label, before, after, unit, formatOpts={minimumFractionDigits: 2, maximumFractionDigits: 2}}) => {
        const isImproved = (label.includes('Error') && after < before) || (!label.includes('Error') && after > before);
        const color = after === before ? 'text-slate-300' : isImproved ? 'text-green-400' : 'text-red-400';
        return (
             <div className="flex justify-between items-center text-base py-2">
                <span className="text-slate-400">{label}</span>
                <div className="flex items-center space-x-2 font-mono">
                    <span className="text-slate-300">{formatNumber(before, formatOpts)}{unit}</span>
                    <span className="text-slate-500">→</span>
                    <span className={color}>{formatNumber(after, formatOpts)}{unit}</span>
                </div>
            </div>
        )
    };

    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-lg font-semibold text-slate-200 mb-2">Impact Analysis (Before → After)</h3>
                <div className="space-y-1">
                    <ImpactRow label="Modified Duration" before={result.impactAnalysis.before.modifiedDuration} after={result.impactAnalysis.after.modifiedDuration} unit=" yrs" />
                    <ImpactRow label="Duration Gap" before={result.impactAnalysis.before.durationGap} after={result.impactAnalysis.after.durationGap} unit=" yrs" />
                    <ImpactRow label="Tracking Error" before={result.impactAnalysis.before.trackingError} after={result.impactAnalysis.after.trackingError} unit=" bps" />
                    <ImpactRow label="Portfolio Yield" before={result.impactAnalysis.before.yield} after={result.impactAnalysis.after.yield} unit=" %" />
                </div>
            </div>

            <div>
                <h3 className="text-lg font-semibold text-slate-200 mb-2">Proposed Trades</h3>
                {result.proposedTrades.length > 0 ? (
                     <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-slate-800">
                             <thead className="bg-slate-900/50">
                                <tr>
                                    <th className="px-2 py-2 text-left text-xs font-medium text-slate-400 uppercase">Use</th>
                                    <th className="px-2 py-2 text-left text-xs font-medium text-slate-400 uppercase">Action</th>
                                    <th className="px-2 py-2 text-left text-xs font-medium text-slate-400 uppercase">ISIN</th>
                                    <th className="px-2 py-2 text-left text-xs font-medium text-slate-400 uppercase">Name</th>
                                    <th className="px-2 py-2 text-center text-xs font-medium text-slate-400 uppercase">Rating</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">M.Val</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Notional</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Price</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Dur</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">YTM</th>
                                </tr>
                             </thead>
                             <tbody className="divide-y divide-slate-800">
                                {result.proposedTrades.map(trade => (
                                    <tr key={trade.isin + trade.action + trade.pairId} className={`transition-opacity ${activeTrades.has(trade.pairId) ? 'opacity-100' : 'opacity-50'} hover:bg-slate-800/50`}>
                                        <td className="px-2 py-2"><input type="checkbox" checked={activeTrades.has(trade.pairId)} onChange={() => onTradeToggle(trade.pairId)} className="form-checkbox h-4 w-4 bg-slate-700 border-slate-600 text-orange-500 rounded focus:ring-orange-500" /></td>
                                        <td className={`px-2 py-2 text-sm font-semibold ${trade.action === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{trade.action}</td>
                                        <td className="px-2 py-2 text-sm font-mono text-orange-400">{trade.isin}</td>
                                        <td className="px-2 py-2 text-sm max-w-xs truncate">{trade.name}</td>
                                        <td className="px-2 py-2 text-sm text-center font-mono">{trade.creditRating}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatCurrency(trade.marketValue, 0, 0)}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatNumber(trade.notional, {maximumFractionDigits: 0})}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatNumber(trade.price, {minimumFractionDigits: 2})}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatNumber(trade.modifiedDuration, {minimumFractionDigits: 2})}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatNumber(trade.yieldToMaturity, {minimumFractionDigits: 2})}%</td>
                                    </tr>
                                ))}
                             </tbody>
                        </table>
                     </div>
                ) : <p className="text-sm text-slate-400">{result.rationale || 'No trades recommended.'}</p>}
            </div>

            {result.rationale && (
                 <div>
                    <h3 className="text-lg font-semibold text-slate-200 mb-2">Rationale</h3>
                    <p className="text-base text-slate-400 bg-slate-800/50 p-4 rounded-md">{result.rationale}</p>
                 </div>
            )}

            <div>
                <h3 className="text-lg font-semibold text-slate-200 mb-2">Cost-Benefit Summary</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
                    <div className="bg-slate-800/50 p-3 rounded-md">
                        <h4 className="text-xs font-medium text-slate-400 uppercase">Total Cost ($)</h4>
                        <p className="text-xl font-mono font-bold text-amber-400 mt-1">{formatCurrency(result.estimatedCost, 2, 2)}</p>
                    </div>
                    <div className="bg-slate-800/50 p-3 rounded-md">
                        <h4 className="text-xs font-medium text-slate-400 uppercase">Cost (bps of NAV)</h4>
                        <p className="text-xl font-mono font-bold text-amber-400 mt-1">{formatNumber(result.estimatedCostBpsOfNav, {minimumFractionDigits: 2})}</p>
                    </div>
                     <div className="bg-slate-800/50 p-3 rounded-md">
                        <h4 className="text-xs font-medium text-slate-400 uppercase">Aggregate Trade Cost (bps)</h4>
                        <p className="text-xl font-mono font-bold text-amber-400 mt-1">{formatNumber(result.estimatedCostBpsPerTradeSum, {maximumFractionDigits: 0})}</p>
                    </div>
                </div>
            </div>

        </div>
    )
}

export const Optimiser: React.FC<OptimiserProps> = ({ portfolio, benchmark, bondMasterData, appSettings }) => {
    const [maxTurnover, setMaxTurnover] = useState(() => sessionStorage.getItem('optimiser_maxTurnover') || '10');
    const [transactionCost, setTransactionCost] = useState(() => sessionStorage.getItem('optimiser_transactionCost') || '20');
    const [mode, setMode] = useState<'switch' | 'buy-only'>('switch');
    const [excludedBonds, setExcludedBonds] = useState<string[]>([]);
    const [eligibilitySearch, setEligibilitySearch] = useState('');
    
    // New constraints state
    const [investmentHorizonLimit, setInvestmentHorizonLimit] = useState(() => sessionStorage.getItem('optimiser_horizonLimit') || '10');
    const [minimumPurchaseRating, setMinimumPurchaseRating] = useState(() => sessionStorage.getItem('optimiser_minRating') || 'BB-');

    const [result, setResult] = useState<OptimizationResult | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    
    const [activeTrades, setActiveTrades] = useState<Set<number>>(new Set());
    
    useEffect(() => {
        sessionStorage.setItem('optimiser_maxTurnover', maxTurnover);
    }, [maxTurnover]);

    useEffect(() => {
        sessionStorage.setItem('optimiser_transactionCost', transactionCost);
    }, [transactionCost]);

    useEffect(() => {
        sessionStorage.setItem('optimiser_horizonLimit', investmentHorizonLimit);
    }, [investmentHorizonLimit]);
    
    useEffect(() => {
        sessionStorage.setItem('optimiser_minRating', minimumPurchaseRating);
    }, [minimumPurchaseRating]);


    const handleRunOptimiser = useCallback(() => {
        setIsLoading(true);
        setResult(null);

        setTimeout(() => {
            const params: OptimizationParams = {
                ...appSettings,
                maxTurnover: Number(maxTurnover),
                transactionCost: Number(transactionCost),
                excludedBonds,
                mode,
                investmentHorizonLimit: Number(investmentHorizonLimit),
                minimumPurchaseRating: minimumPurchaseRating,
            };
            const optoResult = optimizerService.runOptimizer(portfolio, benchmark, params, bondMasterData);
            setResult(optoResult);
            // Initially, all proposed trades are active
            setActiveTrades(new Set(optoResult.proposedTrades.map(t => t.pairId)));
            setIsLoading(false);
        }, 500); // simulate async work
    }, [maxTurnover, transactionCost, excludedBonds, mode, investmentHorizonLimit, minimumPurchaseRating, portfolio, benchmark, bondMasterData, appSettings]);
    
    const handleTradeToggle = (pairId: number) => {
        setActiveTrades(prev => {
            const newSet = new Set(prev);
            if (newSet.has(pairId)) {
                newSet.delete(pairId);
            } else {
                newSet.add(pairId);
            }
            return newSet;
        })
    }
    
    const displayedResult = useMemo(() => {
        if (!result) return null;
        
        const activeProposedTrades = result.proposedTrades.filter(t => activeTrades.has(t.pairId));
        
        const beforeMetrics = optimizerService.calculateImpactMetrics(portfolio, benchmark);

        if (activeProposedTrades.length === 0) {
            return {
                ...result,
                impactAnalysis: { before: beforeMetrics, after: beforeMetrics },
                estimatedCost: 0,
                estimatedCostBpsOfNav: 0,
                estimatedCostBpsPerTradeSum: 0,
                // keep original rationale but show only active trades
                proposedTrades: result.proposedTrades, // show all trades
            }
        }
        
        const afterPortfolioBonds = optimizerService.applyTradesToPortfolio(portfolio.bonds, activeProposedTrades, bondMasterData);
        const afterPortfolio = calculatePortfolioMetrics(afterPortfolioBonds);
        const afterMetrics = optimizerService.calculateImpactMetrics(afterPortfolio, benchmark);

        const totalTradedValue = activeProposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
        const estimatedCost = totalTradedValue * (Number(transactionCost) / 10000);
        
        return {
            ...result,
            impactAnalysis: { before: beforeMetrics, after: afterMetrics },
            estimatedCost,
            estimatedCostBpsOfNav: portfolio.totalMarketValue > 0 ? (estimatedCost / portfolio.totalMarketValue) * 10000 : 0,
            estimatedCostBpsPerTradeSum: Number(transactionCost) * activeProposedTrades.length,
            proposedTrades: result.proposedTrades,
        }
    }, [result, activeTrades, portfolio, benchmark, bondMasterData, transactionCost]);

    const filteredEligibilityBonds = useMemo(() => {
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
                                <label htmlFor="maxTurnover" className="block text-sm font-medium text-slate-300">
                                    {mode === 'buy-only' ? 'New Cash to Invest (%)' : 'Max Turnover (%)'}
                                </label>
                                <input type="number" id="maxTurnover" value={maxTurnover} onChange={e => setMaxTurnover(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                            </div>
                            <div>
                                <label htmlFor="transactionCost" className="block text-sm font-medium text-slate-300">Transaction Cost per Trade (bps)</label>
                                <input type="number" id="transactionCost" value={transactionCost} onChange={e => setTransactionCost(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                            </div>
                             <div>
                                <label htmlFor="horizonLimit" className="block text-sm font-medium text-slate-300">Investment Horizon Limit (Yrs)</label>
                                <input type="number" id="horizonLimit" value={investmentHorizonLimit} onChange={e => setInvestmentHorizonLimit(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                                <p className="text-xs text-slate-500 mt-1">Limits the maximum maturity of bonds the optimiser can buy.</p>
                            </div>
                             <div>
                                <label htmlFor="minRating" className="block text-sm font-medium text-slate-300">Minimum Purchase Rating</label>
                                <select id="minRating" value={minimumPurchaseRating} onChange={e => setMinimumPurchaseRating(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none">
                                    {CREDIT_RATINGS.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                                <p className="text-xs text-slate-500 mt-1">Sets the minimum credit quality for any proposed buys.</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-300">Optimisation Mode</label>
                                <div className="mt-1 grid grid-cols-2 gap-2 p-1 bg-slate-800 rounded-lg">
                                    <button 
                                        onClick={() => setMode('switch')} 
                                        className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${mode === 'switch' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}
                                    >
                                        Switch Trades
                                    </button>
                                    <button 
                                        onClick={() => setMode('buy-only')} 
                                        className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${mode === 'buy-only' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}
                                    >
                                        Buy Only
                                    </button>
                                </div>
                                <p className="text-xs text-slate-500 mt-1">
                                     {mode === 'switch'
                                        ? "Cash-neutral trades to first fix the duration gap, then minimise tracking error."
                                        : "Uses '% of NAV' as new cash to invest, first fixing duration, then tracking error."}
                                </p>
                            </div>
                        </div>
                    </Card>

                    <Card>
                         <h3 className="text-lg font-semibold text-slate-200 mb-2">Bond Eligibility</h3>
                         <p className="text-sm text-slate-400 mb-4">Untick bonds to exclude them from being sold in the optimisation.</p>
                          <input
                            type="text"
                            placeholder="Search by ISIN or name..."
                            value={eligibilitySearch}
                            onChange={(e) => setEligibilitySearch(e.target.value)}
                            className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 mb-3 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"
                          />
                         <div className="max-h-60 overflow-y-auto space-y-2 pr-2">
                             {filteredEligibilityBonds.map(bond => (
                                <label key={bond.isin} className="flex items-center space-x-3 p-2 rounded-md hover:bg-slate-800/50">
                                    <input type="checkbox" 
                                        checked={!excludedBonds.includes(bond.isin)}
                                        onChange={() => setExcludedBonds(prev => prev.includes(bond.isin) ? prev.filter(i => i !== bond.isin) : [...prev, bond.isin])}
                                        className="form-checkbox h-4 w-4 bg-slate-700 border-slate-600 text-orange-500 rounded focus:ring-orange-500"
                                    />
                                    <span className="text-sm text-slate-300 truncate">{bond.name}</span>
                                </label>
                             ))}
                         </div>
                    </Card>
                </div>
                <div className="xl:col-span-2">
                     <Card>
                        <h3 className="text-lg font-semibold text-slate-200 mb-2">Execution</h3>
                        <p className="text-sm text-slate-400 mb-4">Click "Run Optimiser" to generate a set of trades to minimise tracking error based on your constraints.</p>
                        <button onClick={handleRunOptimiser} disabled={isLoading} className="w-full bg-orange-600 text-white font-bold py-3 px-4 rounded-md hover:bg-orange-700 transition-colors disabled:bg-slate-700 disabled:cursor-not-allowed">
                            {isLoading ? 'Optimising...' : 'Run Optimiser'}
                        </button>
                    </Card>
                     <AnimatePresence>
                        {displayedResult && (
                            <motion.div
                              layout
                              initial={{ opacity: 0, y: 20 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -20 }}
                              transition={{ duration: 0.4 }}
                              className="mt-6"
                            >
                                <Card>
                                   <ResultsDisplay result={displayedResult} onTradeToggle={handleTradeToggle} activeTrades={activeTrades}/>
                                </Card>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
};
