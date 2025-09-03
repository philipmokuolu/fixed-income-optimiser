import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Portfolio, Benchmark, OptimizationParams, OptimizationResult, BondStaticData, AppSettings, ProposedTrade, Portfolio as PortfolioType, KRD_TENORS, KrdKey, Bond, FxRates } from '@/types';
import { Card } from '@/components/shared/Card';
import * as optimizerService from '@/services/optimizerService';
import { formatNumber, formatCurrency, formatCurrencyM } from '@/utils/formatting';
import { calculatePortfolioMetrics, applyTradesToPortfolio, calculateTrackingError } from '@/services/portfolioService';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, Sector } from 'recharts';


const ALL_RATINGS_ORDERED = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'B-', 'CCC+', 'CCC', 'CCC-', 'CC', 'C', 'D', 'N/A'];
const RATING_ORDER_MAP = ALL_RATINGS_ORDERED.reduce((acc, rating, index) => ({ ...acc, [rating]: index }), {} as Record<string, number>);
const CONSOLIDATED_RATING_ORDER = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'CC', 'C', 'D', 'N/A'].reduce((acc, rating, index) => ({ ...acc, [rating]: index }), {} as Record<string, number>);

const getConsolidatedRating = (rating: string): string => {
    if (!rating || rating === 'N/A') return 'N/A';
    const match = rating.match(/^(AAA|AA|A|BBB|BB|B|CCC|CC|C|D)/);
    return match ? match[0] : 'N/A';
};

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

// --- START: HIERARCHICAL RATING LOGIC ---
interface GranularRatingData {
    rating: string;
    prePercent: number;
    postPercent: number;
    changePercent: number;
}
interface ConsolidatedRatingData extends GranularRatingData {
    children: GranularRatingData[];
    hasChildren: boolean;
}
const calculateHierarchicalRatingSplit = (
    preBonds: Bond[],
    postBonds: Bond[],
    preTotal: number,
    postTotal: number
): ConsolidatedRatingData[] => {
    const preGranular = preBonds.reduce((acc, bond) => {
      const rating = bond.creditRating || 'N/A';
      acc[rating] = (acc[rating] || 0) + bond.marketValue;
      return acc;
    }, {} as Record<string, number>);

    const postGranular = postBonds.reduce((acc, bond) => {
        const rating = bond.creditRating || 'N/A';
        acc[rating] = (acc[rating] || 0) + bond.marketValue;
        return acc;
    }, {} as Record<string, number>);

    const allGranularRatings = new Set([...Object.keys(preGranular), ...Object.keys(postGranular)]);
    
    const granularData: Record<string, GranularRatingData> = {};
    allGranularRatings.forEach(rating => {
        const preValue = preGranular[rating] || 0;
        const postValue = postGranular[rating] || 0;
        const prePercent = preTotal > 0 ? (preValue / preTotal) * 100 : 0;
        const postPercent = postTotal > 0 ? (postValue / postTotal) * 100 : 0;
        granularData[rating] = { rating, prePercent, postPercent, changePercent: postPercent - prePercent };
    });

    const consolidatedMap = new Map<string, ConsolidatedRatingData>();

    Object.values(granularData).sort((a,b) => (RATING_ORDER_MAP[a.rating] ?? 99) - (RATING_ORDER_MAP[b.rating] ?? 99)).forEach(gData => {
        const consolidatedKey = getConsolidatedRating(gData.rating);
        if (!consolidatedMap.has(consolidatedKey)) {
            consolidatedMap.set(consolidatedKey, {
                rating: consolidatedKey, prePercent: 0, postPercent: 0, changePercent: 0, children: [], hasChildren: false,
            });
        }
        const parent = consolidatedMap.get(consolidatedKey)!;
        parent.children.push(gData);
        parent.prePercent += gData.prePercent;
        parent.postPercent += gData.postPercent;
    });

    const finalData = Array.from(consolidatedMap.values());
    finalData.forEach(parent => {
        parent.changePercent = parent.postPercent - parent.prePercent;
        parent.hasChildren = parent.children.length > 1 || (parent.children.length === 1 && parent.children[0].rating !== parent.rating);
    });

    return finalData.sort((a,b) => (CONSOLIDATED_RATING_ORDER[a.rating] ?? 99) - (CONSOLIDATED_RATING_ORDER[b.rating] ?? 99));
};

const ChevronIcon: React.FC<{ expanded: boolean, visible: boolean }> = ({ expanded, visible }) => {
    if (!visible) return <span className="inline-block w-4 h-4"></span>;
    return (
      <svg className={`w-4 h-4 text-slate-500 transition-transform duration-200 ${expanded ? 'rotate-90' : 'rotate-0'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path>
      </svg>
    );
};
// --- END: HIERARCHICAL RATING LOGIC ---

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

const ResultsDisplay: React.FC<{
    result: OptimizationResult;
    onTradeToggle: (pairId: number) => void;
    activeTrades: Set<number>;
    initialPortfolio: PortfolioType;
    afterPortfolio: PortfolioType;
    benchmark: Benchmark;
    activeFeeCost: number;
    activeSpreadCost: number;
    activeAggregateFeeBps: number;
}> = ({ result, onTradeToggle, activeTrades, initialPortfolio, afterPortfolio, benchmark, activeFeeCost, activeSpreadCost, activeAggregateFeeBps }) => {
    
    const [expandedRatings, setExpandedRatings] = useState<Set<string>>(new Set());

    const handleToggleExpand = (rating: string) => {
        setExpandedRatings(prev => {
            const newSet = new Set(prev);
            if (newSet.has(rating)) newSet.delete(rating);
            else newSet.add(rating);
            return newSet;
        });
    };

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
        if (!result) return [];
        return calculateHierarchicalRatingSplit(
            initialPortfolio.bonds,
            afterPortfolio.bonds,
            initialPortfolio.totalMarketValue,
            afterPortfolio.totalMarketValue
        );
    }, [result, initialPortfolio, afterPortfolio]);
    
    const CURRENCY_COLORS = ['#f97316', '#6366f1', '#14b8a6', '#f43f5e', '#3b82f6'];


    return (
        <div className="space-y-6">
            <div className="border-b-2 border-slate-800 pb-6">
                <h3 className="text-lg font-semibold text-slate-200 mb-2">Impact Analysis (Before → After)</h3>
                <div className="space-y-1">
                    <ImpactRow label="Modified Duration" before={result.impactAnalysis.before.modifiedDuration} after={afterPortfolio.modifiedDuration} unit=" yrs" />
                    <ImpactRow label="Duration Gap" before={result.impactAnalysis.before.durationGap} after={afterPortfolio.modifiedDuration - benchmark.modifiedDuration} unit=" yrs" />
                    <ImpactRow label="Tracking Error" before={result.impactAnalysis.before.trackingError} after={calculateTrackingError(afterPortfolio, benchmark)} unit=" bps" />
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
                                    <th className="px-2 py-2 text-center text-xs font-medium text-slate-400 uppercase">Rating</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Mod.Dur</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Notional</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Yield (%)</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">M.Val</th>
                                    <th className="px-2 py-2 text-right text-xs font-medium text-slate-400 uppercase">Spread Cost ($)</th>
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
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatNumber(trade.modifiedDuration, {minimumFractionDigits: 2})}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatCurrency(trade.notional, 0, 0)}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatNumber(trade.yieldToMaturity, {minimumFractionDigits: 2})}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatCurrency(trade.marketValue, 0, 0)}</td>
                                        <td className="px-2 py-2 text-sm text-right font-mono">{formatCurrency(trade.spreadCost, 2, 2)}</td>
                                    </tr>
                                ))}
                             </tbody>
                        </table>
                     </div>
                ) : <p className="text-base text-slate-400">{result.rationale || 'No trades recommended.'}</p>}
            </div>

            {result.rationale && (
                 <div>
                    <h3 className="text-lg font-semibold text-slate-200 mb-2">Rationale</h3>
                    <p className="text-base text-slate-400 bg-slate-800/50 p-4 rounded-md whitespace-pre-wrap">{result.rationale}</p>
                 </div>
            )}

            <div>
                <h3 className="text-lg font-semibold text-slate-200 mb-2">Cost-Benefit Summary</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
                    <div className="bg-slate-800/50 p-3 rounded-md">
                        <h4 className="text-xs font-medium text-slate-400 uppercase">Total Cost ($)</h4>
                        <p className="text-xl font-mono font-bold text-amber-400 mt-1">{formatCurrency(activeFeeCost + activeSpreadCost, 2, 2)}</p>
                        <p className="text-xs text-slate-500 mt-1">(Fee: {formatCurrency(activeFeeCost, 2, 2)}, Spread: {formatCurrency(activeSpreadCost, 2, 2)})</p>
                    </div>
                    <div className="bg-slate-800/50 p-3 rounded-md">
                        <h4 className="text-xs font-medium text-slate-400 uppercase">Cost (bps of NAV)</h4>
                        <p className="text-xl font-mono font-bold text-amber-400 mt-1">{formatNumber(((activeFeeCost + activeSpreadCost) / initialPortfolio.totalMarketValue) * 10000, {minimumFractionDigits: 2})}</p>
                    </div>
                    <div className="bg-slate-800/50 p-3 rounded-md">
                        <h4 className="text-xs font-medium text-slate-400 uppercase">Aggregate Fee (bps)</h4>
                        <p className="text-xl font-mono font-bold text-amber-400 mt-1">{formatNumber(activeAggregateFeeBps, {minimumFractionDigits:0})}</p>
                    </div>
                </div>
            </div>

            {result.proposedTrades.length > 0 && (
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
                                            <th className="px-3 py-2 text-right text-xs font-medium text-slate-400 uppercase">Pre-Trade (%)</th>
                                            <th className="px-3 py-2 text-right text-xs font-medium text-slate-400 uppercase">Post-Trade (%)</th>
                                            <th className="px-3 py-2 text-right text-xs font-medium text-slate-400 uppercase">Change (%)</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800">
                                        {ratingData?.map((consolidated) => (
                                            <React.Fragment key={consolidated.rating}>
                                                <tr 
                                                    className={`hover:bg-slate-800/50 ${consolidated.hasChildren ? 'cursor-pointer' : ''}`}
                                                    onClick={() => consolidated.hasChildren && handleToggleExpand(consolidated.rating)}
                                                >
                                                    <td className="px-3 py-2 text-sm font-semibold">
                                                        <div className="flex items-center space-x-2">
                                                            <ChevronIcon expanded={expandedRatings.has(consolidated.rating)} visible={consolidated.hasChildren} />
                                                            <span>{consolidated.rating}</span>
                                                        </div>
                                                    </td>
                                                    <td className="px-3 py-2 text-right text-sm font-mono">{formatNumber(consolidated.prePercent, {minimumFractionDigits: 1, maximumFractionDigits: 1})}%</td>
                                                    <td className="px-3 py-2 text-right text-sm font-mono">{formatNumber(consolidated.postPercent, {minimumFractionDigits: 1, maximumFractionDigits: 1})}%</td>
                                                    <td className={`px-3 py-2 text-right text-sm font-mono ${consolidated.changePercent === 0 ? 'text-slate-400' : consolidated.changePercent > 0 ? 'text-green-400' : 'text-red-400'}`}>{consolidated.changePercent > 0 ? '+' : ''}{formatNumber(consolidated.changePercent, {minimumFractionDigits: 3, maximumFractionDigits: 3})}%</td>
                                                </tr>
                                                {consolidated.hasChildren && expandedRatings.has(consolidated.rating) && (
                                                    consolidated.children.map(granular => (
                                                        <tr key={granular.rating} className="bg-slate-950 hover:bg-slate-800/50">
                                                            <td className="px-3 py-2 text-sm">
                                                                 <div className="flex items-center pl-8">
                                                                    <span className="text-slate-300">{granular.rating}</span>
                                                                </div>
                                                            </td>
                                                            <td className="px-3 py-2 text-right text-sm font-mono text-slate-400">{formatNumber(granular.prePercent, {minimumFractionDigits: 1, maximumFractionDigits: 1})}%</td>
                                                            <td className="px-3 py-2 text-right text-sm font-mono text-slate-400">{formatNumber(granular.postPercent, {minimumFractionDigits: 1, maximumFractionDigits: 1})}%</td>
                                                            <td className={`px-3 py-2 text-right text-sm font-mono ${granular.changePercent === 0 ? 'text-slate-400' : granular.changePercent > 0 ? 'text-green-400' : 'text-red-400'}`}>{granular.changePercent > 0 ? '+' : ''}{formatNumber(granular.changePercent, {minimumFractionDigits: 3, maximumFractionDigits: 3})}%</td>
                                                        </tr>
                                                    ))
                                                )}
                                            </React.Fragment>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                         </Card>
                     </div>
                </div>
            )}
        </div>
    )
}

interface OptimiserProps {
    portfolio: Portfolio;
    benchmark: Benchmark;
    bondMasterData: Record<string, BondStaticData>;
    appSettings: AppSettings;
    fxRates: FxRates;
}

const ToggleSwitch: React.FC<{ enabled: boolean; onChange: (enabled: boolean) => void; }> = ({ enabled, onChange }) => {
    return (
        <button
            type="button"
            className={`${
                enabled ? 'bg-green-600' : 'bg-slate-700'
            } relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-slate-900`}
            role="switch"
            aria-checked={enabled}
            onClick={() => onChange(!enabled)}
        >
            <span
                aria-hidden="true"
                className={`${
                    enabled ? 'translate-x-5' : 'translate-x-0'
                } pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
            />
        </button>
    );
};


export const Optimiser: React.FC<OptimiserProps> = ({ portfolio, benchmark, bondMasterData, appSettings, fxRates }) => {
    // Raw numeric string state
    const [maxTurnover, setMaxTurnover] = useState(() => sessionStorage.getItem('optimiser_maxTurnover') || '10');
    const [cashToRaise, setCashToRaise] = useState(() => sessionStorage.getItem('optimiser_cashToRaise') || '5000000');
    const [newCashToInvest, setNewCashToInvest] = useState(() => sessionStorage.getItem('optimiser_newCashToInvest') || '5000000');
    const [transactionCost, setTransactionCost] = useState(() => sessionStorage.getItem('optimiser_transactionCost') || '20');
    
    // Formatted display state
    const [displayCashToRaise, setDisplayCashToRaise] = useState('');
    const [displayNewCashToInvest, setDisplayNewCashToInvest] = useState('');

    const [mode, setMode] = useState<'switch' | 'buy-only' | 'sell-only'>('switch');
    const [excludedBonds, setExcludedBonds] = useState<string[]>(() => {
        try {
            const saved = sessionStorage.getItem('optimiser_excludedBonds');
            return saved ? JSON.parse(saved) : [];
        } catch (e) {
            return [];
        }
    });
    const [eligibilitySearch, setEligibilitySearch] = useState('');
    
    // New constraints state
    const [investmentHorizonLimit, setInvestmentHorizonLimit] = useState(() => sessionStorage.getItem('optimiser_horizonLimit') || '10');
    const [minimumPurchaseRating, setMinimumPurchaseRating] = useState(() => sessionStorage.getItem('optimiser_minRating') || 'BB-');

    // Strategic Targeting State
    const [isTargetingMode, setIsTargetingMode] = useState(() => sessionStorage.getItem('optimiser_isTargetingMode') === 'true' || false);
    const [targetDurationGap, setTargetDurationGap] = useState(() => sessionStorage.getItem('optimiser_targetDurationGap') || '0.0');


    const [result, setResult] = useState<OptimizationResult | null>(() => {
        try {
            const saved = sessionStorage.getItem('optimiser_result');
            return saved ? JSON.parse(saved) : null;
        } catch (e) { return null; }
    });
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    
    const [activeTrades, setActiveTrades] = useState<Set<number>>(() => {
        try {
            const saved = sessionStorage.getItem('optimiser_activeTrades');
            return saved ? new Set(JSON.parse(saved)) : new Set();
        } catch (e) { return new Set(); }
    });
    
    const formatForDisplay = (value: string) => {
        const num = parseInt(value.replace(/,/g, ''), 10);
        return isNaN(num) ? '' : num.toLocaleString();
    };
    
    useEffect(() => { setDisplayCashToRaise(formatForDisplay(cashToRaise)); }, [cashToRaise]);
    useEffect(() => { setDisplayNewCashToInvest(formatForDisplay(newCashToInvest)); }, [newCashToInvest]);
    
    useEffect(() => { sessionStorage.setItem('optimiser_maxTurnover', maxTurnover); }, [maxTurnover]);
    useEffect(() => { sessionStorage.setItem('optimiser_cashToRaise', cashToRaise); }, [cashToRaise]);
    useEffect(() => { sessionStorage.setItem('optimiser_newCashToInvest', newCashToInvest); }, [newCashToInvest]);
    useEffect(() => { sessionStorage.setItem('optimiser_transactionCost', transactionCost); }, [transactionCost]);
    useEffect(() => { sessionStorage.setItem('optimiser_horizonLimit', investmentHorizonLimit); }, [investmentHorizonLimit]);
    useEffect(() => { sessionStorage.setItem('optimiser_minRating', minimumPurchaseRating); }, [minimumPurchaseRating]);
    useEffect(() => { sessionStorage.setItem('optimiser_isTargetingMode', String(isTargetingMode)); }, [isTargetingMode]);
    useEffect(() => { sessionStorage.setItem('optimiser_targetDurationGap', targetDurationGap); }, [targetDurationGap]);
    useEffect(() => { sessionStorage.setItem('optimiser_excludedBonds', JSON.stringify(excludedBonds)); }, [excludedBonds]);


    useEffect(() => {
        if (result) sessionStorage.setItem('optimiser_result', JSON.stringify(result));
        else sessionStorage.removeItem('optimiser_result');
    }, [result]);
    useEffect(() => {
        sessionStorage.setItem('optimiser_activeTrades', JSON.stringify(Array.from(activeTrades)));
    }, [activeTrades]);


    const handleRunOptimiser = useCallback(() => {
        setIsLoading(true);
        setResult(null);
        setError(null);

        setTimeout(() => {
            try {
                const params: OptimizationParams = {
                    ...appSettings,
                    maxTurnover: Number(maxTurnover),
                    transactionCost: Number(transactionCost),
                    excludedBonds,
                    mode,
                    investmentHorizonLimit: Number(investmentHorizonLimit),
                    minimumPurchaseRating: minimumPurchaseRating,
                    cashToRaise: mode === 'sell-only' ? Number(cashToRaise) : undefined,
                    newCashToInvest: mode === 'buy-only' ? Number(newCashToInvest) : undefined,
                    isTargetingMode,
                    targetDurationGap: isTargetingMode ? Number(targetDurationGap) : undefined
                };

                if (isNaN(params.maxTurnover) || isNaN(params.transactionCost) || isNaN(params.investmentHorizonLimit) || (params.cashToRaise && isNaN(params.cashToRaise)) || (params.newCashToInvest && isNaN(params.newCashToInvest)) || (params.isTargetingMode && isNaN(params.targetDurationGap as number))) {
                    throw new Error("One of the input parameters is not a valid number.");
                }

                const optoResult = optimizerService.runOptimizer(portfolio, benchmark, params, bondMasterData, fxRates);
                
                if (!optoResult) {
                    throw new Error("Optimizer returned no result. This may be due to an internal calculation error.");
                }

                setResult(optoResult);
                setActiveTrades(new Set(optoResult.proposedTrades.map(t => t.pairId)));
            } catch (e: any) {
                console.error("Optimization failed:", e);
                setError(e.message || "An unexpected error occurred. Please check data files for inconsistencies or invalid numeric values.");
            } finally {
                setIsLoading(false);
            }
        }, 500); // simulate async work
    }, [maxTurnover, cashToRaise, newCashToInvest, transactionCost, excludedBonds, mode, investmentHorizonLimit, minimumPurchaseRating, isTargetingMode, targetDurationGap, portfolio, benchmark, bondMasterData, appSettings, fxRates]);
    
    const handleResetOptimiser = () => {
        setResult(null);
        setActiveTrades(new Set());
        setError(null);
        sessionStorage.removeItem('optimiser_result');
        sessionStorage.removeItem('optimiser_activeTrades');
    };
    
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
                activeSpreadCost: 0,
                activeAggregateFeeBps: 0
            }
        }
        
        const afterPortfolioBonds = applyTradesToPortfolio(portfolio.bonds, activeProposedTrades, bondMasterData, fxRates);
        const afterPortfolio = calculatePortfolioMetrics(afterPortfolioBonds);
        
        const activeTradedValue = activeProposedTrades.reduce((sum, trade) => sum + trade.marketValue, 0);
        const activeFeeCost = (mode === 'switch' ? activeTradedValue / 2 : activeTradedValue) * (Number(transactionCost) / 10000);
        const activeSpreadCost = activeProposedTrades.reduce((sum, trade) => sum + trade.spreadCost, 0);
        const activeAggregateFeeBps = activeProposedTrades.length * Number(transactionCost);
        
        return {
            result,
            afterPortfolio,
            activeFeeCost,
            activeSpreadCost,
            activeAggregateFeeBps
        }
    }, [result, activeTrades, portfolio, bondMasterData, transactionCost, mode, fxRates]);

    const filteredEligibilityBonds = useMemo(() => {
        return portfolio.bonds.filter(b => 
            b.name.toLowerCase().includes(eligibilitySearch.toLowerCase()) || 
            b.isin.toLowerCase().includes(eligibilitySearch.toLowerCase())
        );
    }, [portfolio.bonds, eligibilitySearch]);
    
    const paramLabel = mode === 'buy-only' ? 'New Cash to Invest ($)' : mode === 'sell-only' ? 'Cash to Raise ($)' : 'Max Turnover (%)';

    const handleParamChange = (value: string) => {
        const numericValue = value.replace(/,/g, '');
        if (/^\d*$/.test(numericValue)) { // only allow digits
            if (mode === 'buy-only') {
                setNewCashToInvest(numericValue);
                setDisplayNewCashToInvest(formatForDisplay(numericValue));
            } else if (mode === 'sell-only') {
                setCashToRaise(numericValue);
                setDisplayCashToRaise(formatForDisplay(numericValue));
            } else { // turnover
                setMaxTurnover(numericValue);
            }
        }
    };

    const getParamValue = () => {
        if (mode === 'buy-only') return displayNewCashToInvest;
        if (mode === 'sell-only') return displayCashToRaise;
        return maxTurnover;
    };

    const handleTargetGapChange = (value: string) => {
        // Allow negative sign and one decimal point
        if (/^-?\d*\.?\d*$/.test(value)) {
            setTargetDurationGap(value);
        }
    }

    return (
        <div className="p-4 sm:p-6 lg:p-8 space-y-6">
            <h1 className="text-2xl font-bold text-white">The Optimiser</h1>
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                <div className="xl:col-span-1 space-y-6">
                    <Card>
                        <h3 className="text-lg font-semibold text-slate-200 mb-4">Setup & Constraints</h3>
                        <div className="space-y-4">
                            <div className="flex justify-between items-center bg-slate-800/50 p-3 rounded-lg">
                                <div>
                                    <label htmlFor="targeting-toggle" className="font-semibold text-slate-100">Strategic Duration Targeting</label>
                                    <p className="text-xs text-slate-400">Target a specific duration gap instead of just reducing risk.</p>
                                </div>
                                <ToggleSwitch enabled={isTargetingMode} onChange={setIsTargetingMode} />
                            </div>

                             <div className={`transition-opacity duration-300 ${isTargetingMode ? 'opacity-100' : 'opacity-50'}`}>
                                <label htmlFor="targetDurationGap" className="block text-sm font-medium text-slate-300">
                                    Target Duration Gap (yrs)
                                </label>
                                <input 
                                    type="text"
                                    id="targetDurationGap" 
                                    value={targetDurationGap} 
                                    onChange={e => handleTargetGapChange(e.target.value)} 
                                    className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none disabled:bg-slate-800/50 disabled:cursor-not-allowed"
                                    disabled={!isTargetingMode}
                                />
                            </div>

                            <div className="border-t border-slate-800 my-4"></div>

                            <div>
                                <label className="block text-sm font-medium text-slate-300">Optimisation Mode</label>
                                <div className="mt-1 grid grid-cols-3 gap-2 p-1 bg-slate-800 rounded-lg">
                                    <button onClick={() => setMode('switch')} className={`px-3 py-2 text-sm font-semibold rounded-md transition-colors ${mode === 'switch' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>Switch</button>
                                    <button onClick={() => setMode('buy-only')} className={`px-3 py-2 text-sm font-semibold rounded-md transition-colors ${mode === 'buy-only' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>Buy Only</button>
                                    <button onClick={() => setMode('sell-only')} className={`px-3 py-2 text-sm font-semibold rounded-md transition-colors ${mode === 'sell-only' ? 'bg-orange-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>Sell Only</button>
                                </div>
                            </div>
                            
                            <div>
                                <label htmlFor="paramInput" className="block text-sm font-medium text-slate-300">
                                    {paramLabel}
                                </label>
                                <input 
                                    type={mode === 'switch' ? 'number' : 'text'}
                                    id="paramInput" 
                                    value={getParamValue()} 
                                    onChange={e => handleParamChange(e.target.value)} 
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
                                    {ALL_RATINGS_ORDERED.map(r => r !== 'N/A' && <option key={r} value={r}>{r}</option>)}
                                </select>
                                <p className="text-xs text-slate-500 mt-1">Sets the minimum credit quality for any proposed buys.</p>
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
                         <div className="flex items-center space-x-4">
                            <button onClick={handleRunOptimiser} disabled={isLoading} className="flex-1 bg-orange-600 text-white font-bold py-3 px-4 rounded-md hover:bg-orange-700 transition-colors disabled:bg-slate-700 disabled:cursor-not-allowed">
                                {isLoading ? 'Optimising...' : 'Run Optimiser'}
                            </button>
                             <button onClick={handleResetOptimiser} disabled={isLoading} className="bg-slate-700 text-slate-300 font-bold py-3 px-4 rounded-md hover:bg-slate-600 transition-colors">
                                Reset
                            </button>
                        </div>
                        {error && (
                            <div className="mt-4 p-3 bg-red-900/50 border border-red-500/50 rounded-md text-red-300 text-sm" role="alert">
                                <p className="font-bold">Optimization Error</p>
                                <p>{error}</p>
                            </div>
                        )}
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
                                        activeAggregateFeeBps={displayedResult.activeAggregateFeeBps}
                                   />
                                </Card>
                            </motion.div>
                        )}
                        {!isLoading && !displayedResult && result?.rationale && (
                             <motion.div
                              initial={{ opacity: 0, y: 20 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="mt-6"
                            >
                               <Card>
                                 <h3 className="text-lg font-semibold text-slate-200 mb-2">Impact Analysis (Before → After)</h3>
                                  <ImpactRow label="Modified Duration" before={portfolio.modifiedDuration} after={portfolio.modifiedDuration} unit=" yrs" />
                                  <ImpactRow label="Duration Gap" before={portfolio.modifiedDuration - benchmark.modifiedDuration} after={portfolio.modifiedDuration - benchmark.modifiedDuration} unit=" yrs" />
                                  <ImpactRow label="Tracking Error" before={calculateTrackingError(portfolio, benchmark)} after={calculateTrackingError(portfolio, benchmark)} unit=" bps" />
                                  <ImpactRow label="Portfolio Yield" before={portfolio.averageYield} after={portfolio.averageYield} unit=" %" />
                                 <div className="mt-6">
                                     <h3 className="text-lg font-semibold text-slate-200 mb-2">Proposed Trades</h3>
                                     <p className="text-base text-slate-400">{result.rationale}</p>
                                 </div>
                                  <div className="mt-6">
                                      <h3 className="text-lg font-semibold text-slate-200 mb-2">Rationale</h3>
                                      <p className="text-base text-slate-400 bg-slate-800/50 p-4 rounded-md whitespace-pre-wrap">{result.rationale}</p>
                                  </div>
                                  <div className="mt-6">
                                      <h3 className="text-lg font-semibold text-slate-200 mb-2">Cost-Benefit Summary</h3>
                                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
                                          <div className="bg-slate-800/50 p-3 rounded-md">
                                              <h4 className="text-xs font-medium text-slate-400 uppercase">Total Cost ($)</h4>
                                              <p className="text-xl font-mono font-bold text-slate-300 mt-1">$0.00</p>
                                               <p className="text-xs text-slate-500 mt-1">(Fee: $0.00, Spread: $0.00)</p>
                                          </div>
                                          <div className="bg-slate-800/50 p-3 rounded-md">
                                              <h4 className="text-xs font-medium text-slate-400 uppercase">Cost (bps of NAV)</h4>
                                              <p className="text-xl font-mono font-bold text-slate-300 mt-1">0.00</p>
                                          </div>
                                          <div className="bg-slate-800/50 p-3 rounded-md">
                                              <h4 className="text-xs font-medium text-slate-400 uppercase">Aggregate Fee (bps)</h4>
                                              <p className="text-xl font-mono font-bold text-slate-300 mt-1">0</p>
                                          </div>
                                      </div>
                                  </div>
                               </Card>
                             </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
};
