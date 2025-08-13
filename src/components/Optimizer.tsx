import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, BondStaticData, AppSettings, ProposedTrade, Portfolio as PortfolioType, KRD_TENORS, KrdKey, Bond } from '@/types';
import { Card } from '@/components/shared/Card';
import * as optimizerService from '@/services/optimizerService';
import { formatNumber, formatCurrency, formatCurrencyM } from '@/utils/formatting';
import { calculatePortfolioMetrics, applyTradesToPortfolio } from '@/services/portfolioService';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, Sector } from 'recharts';


const CREDIT_RATINGS = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'B-', 'CCC+', 'CCC', 'CCC-', 'CC', 'C', 'D'];
const RATING_ORDER = CREDIT_RATINGS.reduce((acc, rating, index) => ({ ...acc, [rating]: index }), {} as Record<string, number>);

const ChartTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-slate-800 p-2 border border-slate-700 rounded-md shadow-lg">
          <p className="label text-slate-200">{`${label}`}</p>
          {payload.map((pld: any, index: number) => (
            <p key={index} style={{ color: pld.color }} className="text-sm">
              {`${pld.name}: ${typeof pld.value === 'number' ? pld.value.toFixed(2) : pld.value }`}
            </p>
          ))}
        </div>
      );
    }
    return null;
};

// Helper to aggregate portfolio bond values by credit rating
const calculateCreditRatingSplit = (bonds: Bond[]): Record<string, number> => {
    return bonds.reduce((acc, bond) => {
      const rating = bond.creditRating;
      if (!acc[rating]) {
        acc[rating] = 0;
      }
      acc[rating] += bond.marketValue;
      return acc;
    }, {} as Record<string, number>);
  };

const ResultsDisplay: React.FC<{
    result: OptimizationResult;
    onTradeToggle: (pairId: number) => void;
    activeTrades: Set<number>;
    initialPortfolio: PortfolioType;
    afterPortfolio: PortfolioType;
    benchmark: Benchmark;
    activeFeeCost: number;
    activeSpreadCost: number;
}> = ({ result, onTradeToggle, activeTrades, initialPortfolio, afterPortfolio, benchmark, activeFeeCost, activeSpreadCost }) => {

    const postTradeKrdData = useMemo(() => {
        return KRD_TENORS.map(tenor => {
            const krdKey: KrdKey = `krd_${tenor}`;
            return {
                tenor,
                'Active KRD': afterPortfolio[krdKey] - benchmark[krdKey]
            }
        });
    }, [afterPortfolio, benchmark]);

    const postTradeCurrencyData = useMemo(() => {
        const currencyValues = afterPortfolio.bonds.reduce((acc, bond) => {
          if (!acc[bond.currency]) {
            acc[bond.currency] = 0;
          }
          acc[bond.currency] += bond.marketValue;
          return acc;
        }, {} as Record<string, number>);
        return Object.entries(currencyValues).map(([name, value]) => ({ name, value }));
    }, [afterPortfolio]);

    const ratingData = useMemo(() => {
        if (!result) return null;
        
        const preTradeRatings = calculateCreditRatingSplit(initialPortfolio.bonds);
        const postTradeRatings = calculateCreditRatingSplit(afterPortfolio.bonds);
    
        const allRatings = new Set([...Object.keys(preTradeRatings), ...Object.keys(postTradeRatings)]);
        const sortedRatings = Array.from(allRatings).sort((a,b) => (RATING_ORDER[a] || 99) - (RATING_ORDER[b] || 99));
    
        return sortedRatings.map(rating => {
            const pre = preTradeRatings[rating] || 0;
            const post = postTradeRatings[rating] || 0;
            return {
                rating,
                preValue: pre,
                postValue: post,
                change: post - pre,
            }
        });
    }, [result, initialPortfolio, afterPortfolio]);

    const ImpactRow: React.FC<{label: string, before: number, after: number, unit: string, formatOpts?: Intl.NumberFormatOptions}> = ({label, before, after, unit, formatOpts={minimumFractionDigits: 2, maximumFractionDigits: 2}}) => {
        const isImproved = (label.includes('Error') && after < before) || (label.includes('Duration Gap') && Math.abs(after) < Math.abs(before)) || (!label.includes('Error') && !label.includes('Gap') && after > before);
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
    
    const CURRENCY_COLORS = ['#f97316', '#6366f1', '#14b8a6', '#f43f5e', '#3b82f6'];


    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-lg font-semibold text-slate-200 mb-2">Impact Analysis (Before → After)</h3>
                <div className="space-y-1">
                    <ImpactRow label="Modified Duration" before={result.impactAnalysis.before.modifiedDuration} after={afterPortfolio.modifiedDuration} unit=" yrs" />
                    <ImpactRow label="Duration Gap" before={result.impactAnalysis.before.durationGap} after={afterPortfolio.modifiedDuration - benchmark.modifiedDuration} unit=" yrs" />
                    <ImpactRow label="Tracking Error" before={result.impactAnalysis.before.trackingError} after={optimizerService.calculateTrackingError(afterPortfolio, benchmark)} unit=" bps" />
                    <ImpactRow label="Portfolio Yield" before={result.impactAnalysis.before.yield} after={afterPortfolio.averageYield} unit=" %" />
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
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">M.Val</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Spread Cost ($)</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Price</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Dur</th>
                                </tr>
                             </thead>
                             <tbody className="divide-y divide-slate-800">
                                {result.proposedTrades.map(trade => (
                                    <tr key={trade.isin + trade.action + trade.pairId} className={`transition-opacity ${activeTrades.has(trade.pairId) ? 'opacity-100' : 'opacity-50'} hover:bg-slate-800/50`}>
                                        <td className="px-2 py-2"><input type="checkbox" checked={activeTrades.has(trade.pairId)} onChange={() => onTradeToggle(trade.pairId)} className="form-checkbox h-4 w-4 bg-slate-700 border-slate-600 text-orange-500 rounded focus:ring-orange-500" /></td>
                                        <td className={`px-2 py-2 text-sm font-semibold ${trade.action === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{trade.action}</td>
                                        <td className="px-2 py-2 text-sm font-mono text-orange-400">{trade.isin}</td>
                                        <td className="px-2 py-2 text-sm max-w-xs truncate">{trade.name}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatCurrency(trade.marketValue, 0, 0)}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatCurrency(trade.spreadCost, 2, 2)}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatNumber(trade.price, {minimumFractionDigits: 2})}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatNumber(trade.modifiedDuration, {minimumFractionDigits: 2})}</td>
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-center">
                    <div className="bg-slate-800/50 p-3 rounded-md">
                        <h4 className="text-xs font-medium text-slate-400 uppercase">Total Cost ($)</h4>
                        <p className="text-xl font-mono font-bold text-amber-400 mt-1">{formatCurrency(activeFeeCost + activeSpreadCost, 2, 2)}</p>
                        <p className="text-xs text-slate-500 mt-1">(Fee: {formatCurrency(activeFeeCost, 2, 2)}, Spread: {formatCurrency(activeSpreadCost, 2, 2)})</p>
                    </div>
                    <div className="bg-slate-800/50 p-3 rounded-md">
                        <h4 className="text-xs font-medium text-slate-400 uppercase">Cost (bps of NAV)</h4>
                        <p className="text-xl font-mono font-bold text-amber-400 mt-1">{formatNumber(((activeFeeCost + activeSpreadCost) / initialPortfolio.totalMarketValue) * 10000, {minimumFractionDigits: 2})}</p>
                    </div>
                </div>
            </div>

            <div className="border-t-2 border-slate-800 pt-6 mt-6">
                <h3 className="text-xl font-semibold text-slate-100 mb-4">Post-Trade Analysis</h3>
                 <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    <Card>
                        <h4 className="text-md font-semibold text-slate-300 mb-4 text-center">Post-Trade KRD Gap</h4>
                        <ResponsiveContainer width="100%" height={300}>
                            <BarChart data={postTradeKrdData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                            <XAxis dataKey="tenor" tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }}/>
                            <YAxis tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }}/>
                            <Tooltip content={<ChartTooltip />} cursor={{fill: '#334155'}}/>
                            <Bar dataKey="Active KRD" fill="#f97316" />
                            </BarChart>
                        </ResponsiveContainer>
                    </Card>
                    <Card>
                        <h4 className="text-md font-semibold text-slate-300 mb-4 text-center">Post-Trade Currency Exposure</h4>
                        <ResponsiveContainer width="100%" height={300}>
                            <PieChart>
                                <Pie data={postTradeCurrencyData} cx="50%" cy="50%" labelLine={false} outerRadius={100} fill="#8884d8" dataKey="value" nameKey="name" label={({ name, percent }) => `${name} ${formatNumber(percent * 100, {maximumFractionDigits: 0})}%`}>
                                    {postTradeCurrencyData.map((entry, index) => <Cell key={`cell-${index}`} fill={CURRENCY_COLORS[index % CURRENCY_COLORS.length]} />)}
                                </Pie>
                                <Tooltip formatter={(value: number) => formatCurrency(value, 0, 0)} />
                                <Legend wrapperStyle={{ color: '#94a3b8' }} />
                            </PieChart>
                        </ResponsiveContainer>
                    </Card>
                     <Card className="xl:col-span-2">
                        <h4 className="text-md font-semibold text-slate-300 mb-4 text-center">Credit Rating Distribution Change</h4>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-slate-800">
                                <thead className="bg-slate-900/50">
                                    <tr>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-slate-400 uppercase">Rating</th>
                                        <th className="px-3 py-2 text-right text-xs font-medium text-slate-400 uppercase">Pre-Trade ($)</th>
                                        <th className="px-3 py-2 text-right text-xs font-medium text-slate-400 uppercase">Post-Trade ($)</th>
                                        <th className="px-3 py-2 text-right text-xs font-medium text-slate-400 uppercase">Change ($)</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800">
                                    {ratingData?.map(({ rating, preValue, postValue, change }) => (
                                        <tr key={rating} className="hover:bg-slate-800/50">
                                            <td className="px-3 py-2 text-sm font-semibold">{rating}</td>
                                            <td className="px-3 py-2 text-right text-sm font-mono">{formatCurrency(preValue, 0)}</td>
                                            <td className="px-3 py-2 text-right text-sm font-mono">{formatCurrency(postValue, 0)}</td>
                                            <td className={`px-3 py-2 text-right text-sm font-mono ${change === 0 ? 'text-slate-400' : change > 0 ? 'text-green-400' : 'text-red-400'}`}>{change > 0 ? '+' : ''}{formatCurrency(change, 0)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                     </Card>
                 </div>
            </div>
        </div>
    )
}

interface OptimiserProps {
    portfolio: Portfolio;
    benchmark: Benchmark;
    bondMasterData: Record<string, BondStaticData>;
    appSettings: AppSettings;
}

export const Optimiser: React.FC<OptimiserProps> = ({ portfolio, benchmark, bondMasterData, appSettings }) => {
    const [maxTurnover, setMaxTurnover] = useState(() => sessionStorage.getItem('optimiser_maxTurnover') || '10');
    const [cashToRaise, setCashToRaise] = useState(() => sessionStorage.getItem('optimiser_cashToRaise') || '5000000');
    const [transactionCost, setTransactionCost] = useState(() => sessionStorage.getItem('optimiser_transactionCost') || '20');
    const [mode, setMode] = useState<'switch' | 'buy-only' | 'sell-only'>('switch');
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
        sessionStorage.setItem('optimiser_cashToRaise', cashToRaise);
    }, [cashToRaise]);

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
                cashToRaise: mode === 'sell-only' ? Number(cashToRaise) : undefined,
            };
            const optoResult = optimizerService.runOptimizer(portfolio, benchmark, params, bondMasterData);
            setResult(optoResult);
            setActiveTrades(new Set(optoResult.proposedTrades.map(t => t.pairId)));
            setIsLoading(false);
        }, 500); // simulate async work
    }, [maxTurnover, cashToRaise, transactionCost, excludedBonds, mode, investmentHorizonLimit, minimumPurchaseRating, portfolio, benchmark, bondMasterData, appSettings]);
    
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
        
        if (activeProposedTrades.length === 0) {
            return {
                result,
                afterPortfolio: result.impactAnalysis.before.portfolio,
                activeFeeCost: 0,
                activeSpreadCost: 0
            }
        }
        
        const afterPortfolioBonds = applyTradesToPortfolio(portfolio.bonds, activeProposedTrades, bondMasterData);
        const afterPortfolio = calculatePortfolioMetrics(afterPortfolioBonds);
        
        const activeTradedValue = activeProposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
        const activeFeeCost = activeTradedValue * (Number(transactionCost) / 10000);
        const activeSpreadCost = activeProposedTrades.reduce((sum, trade) => sum + trade.spreadCost, 0);
        
        return {
            result,
            afterPortfolio,
            activeFeeCost,
            activeSpreadCost
        }
    }, [result, activeTrades, portfolio, bondMasterData, transactionCost]);

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
                                <label htmlFor="paramInput" className="block text-sm font-medium text-slate-300">
                                    {mode === 'buy-only' ? 'New Cash to Invest (%)' : mode === 'sell-only' ? 'Cash to Raise ($)' : 'Max Turnover (%)'}
                                </label>
                                <input 
                                    type="number" 
                                    id="paramInput" 
                                    value={mode === 'sell-only' ? cashToRaise : maxTurnover} 
                                    onChange={e => mode === 'sell-only' ? setCashToRaise(e.target.value) : setMaxTurnover(e.target.value)} 
                                    className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"
                                />
                            </div>
                            <div>
                                <label htmlFor="transactionCost" className="block text-sm font-medium text-slate-300">Transaction Fee per Trade (bps)</label>
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
                                <div className="mt-1 grid grid-cols-3 gap-2 p-1 bg-slate-800 rounded-lg">
                                    <button onClick={() => setMode('switch')} className={`px-3 py-2 text-sm font-semibold rounded-md transition-colors ${mode === 'switch' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>Switch</button>
                                    <button onClick={() => setMode('buy-only')} className={`px-3 py-2 text-sm font-semibold rounded-md transition-colors ${mode === 'buy-only' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>Buy Only</button>
                                    <button onClick={() => setMode('sell-only')} className={`px-3 py-2 text-sm font-semibold rounded-md transition-colors ${mode === 'sell-only' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>Sell Only</button>
                                </div>
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
                        <p className="text-sm text-slate-400 mb-4">Click "Run Optimiser" to generate a set of trades to minimise risk based on your constraints.</p>
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
                                   <ResultsDisplay
                                        result={displayedResult.result}
                                        onTradeToggle={handleTradeToggle}
                                        activeTrades={activeTrades}
                                        initialPortfolio={portfolio}
                                        afterPortfolio={displayedResult.afterPortfolio}
                                        benchmark={benchmark}
                                        activeFeeCost={displayedResult.activeFeeCost}
                                        activeSpreadCost={displayedResult.activeSpreadCost}
                                   />
                                </Card>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
};
