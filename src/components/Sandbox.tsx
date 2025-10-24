import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Portfolio, Benchmark, Bond, HypotheticalTrade, KrdTenor, KRD_TENORS, AppSettings, BondStaticData } from '@/types';
import { Card } from '@/components/shared/Card';
import { CustomSelect } from '@/components/shared/CustomSelect';
import { Dashboard } from '@/components/Dashboard';
import { calculateScenarioPnl, RateScenario, calculatePortfolioMetrics } from '@/services/portfolioService';
import * as dataService from '@/services/dataService';
import { formatNumber, formatCurrency } from '@/utils/formatting';

interface SandboxProps {
  portfolio: Portfolio;
  benchmark: Benchmark;
  bondMasterData: Record<string, BondStaticData>;
}

interface ScenarioResult {
    portfolioPnl: number;
    benchmarkPnl: number;
    activePnl: number;
    portfolioPnlPercent: number;
    benchmarkPnlPercent: number;
}

const LoadingSpinner: React.FC = () => (
    <div className="flex items-center space-x-2">
      <div className="w-3 h-3 rounded-full animate-pulse bg-orange-400"></div>
      <div className="w-3 h-3 rounded-full animate-pulse bg-orange-400" style={{ animationDelay: '0.2s' }}></div>
      <div className="w-3 h-3 rounded-full animate-pulse bg-orange-400" style={{ animationDelay: '0.4s' }}></div>
      <span className="text-slate-300 text-sm">Analysing...</span>
    </div>
  );
  
const RemoveIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
);

const PnlDisplay:React.FC<{result: ScenarioResult}> = ({result}) => {
    const PnlRow: React.FC<{label: string, value: number, percent: number}> = ({label, value, percent}) => {
        const isPositive = value >= 0;
        return (
             <div className="flex justify-between items-center text-sm py-1.5">
                <span className="text-slate-300">{label}</span>
                <span className={`font-mono ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                    {`${isPositive ? '+' : ''}${formatCurrency(value, 0, 0)}`}
                    <span className="text-xs text-slate-500 ml-2">({formatNumber(percent, {minimumFractionDigits: 2, maximumFractionDigits: 2})}%)</span>
                </span>
            </div>
        )
    }
    return (
        <div className="mt-4 border-t border-slate-800 pt-4 space-y-2">
            <h4 className="text-md font-semibold text-slate-200 mb-2">P&L Impact Analysis</h4>
            <PnlRow label="Portfolio P&L" value={result.portfolioPnl} percent={result.portfolioPnlPercent} />
            <PnlRow label="Benchmark P&L" value={result.benchmarkPnl} percent={result.benchmarkPnlPercent} />
            <div className="border-t border-slate-700 my-1"></div>
            <PnlRow label="Active P&L" value={result.activePnl} percent={result.portfolioPnlPercent - result.benchmarkPnlPercent} />
        </div>
    )
}

export const Sandbox: React.FC<SandboxProps> = ({ portfolio, benchmark, bondMasterData }) => {
  const [hypotheticalTrades, setHypotheticalTrades] = useState<HypotheticalTrade[]>([]);
  
  const [tradeNotionalStr, setTradeNotionalStr] = useState('1000000');
  const [displayTradeNotional, setDisplayTradeNotional] = useState('');
  const [selectedExistingBond, setSelectedExistingBond] = useState<string>(portfolio.bonds[0]?.isin || '');
  
  const [newBondIsin, setNewBondIsin] = useState('');
  const [newBondTradeNotionalStr, setNewBondTradeNotionalStr] = useState('1000000');
  const [displayNewBondTradeNotional, setDisplayNewBondTradeNotional] = useState('');
  
  const [scenarioType, setScenarioType] = useState<'parallel' | 'steepener' | 'flattener' | 'custom'>('parallel');
  const [scenarioParams, setScenarioParams] = useState({
    parallel: '100',
    steepenerShort: '-50',
    steepenerLong: '50',
    flattenerShort: '50',
    flattenerLong: '-50',
    custom: KRD_TENORS.reduce((acc, t) => ({ ...acc, [t]: '0' }), {} as Record<KrdTenor, string>)
  });

  const [scenarioResult, setScenarioResult] = useState<ScenarioResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  
  const appSettings = useMemo(() => dataService.loadAppSettings(), []);
  
  useEffect(() => {
      setHypotheticalTrades(dataService.loadSandboxTrades());
  }, []);

  const formatForDisplay = (value: string) => {
    const num = parseInt(value.replace(/,/g, ''), 10);
    return isNaN(num) ? '' : num.toLocaleString();
  };

  useEffect(() => {
    setDisplayTradeNotional(formatForDisplay(tradeNotionalStr));
  }, [tradeNotionalStr]);

  useEffect(() => {
    setDisplayNewBondTradeNotional(formatForDisplay(newBondTradeNotionalStr));
  }, [newBondTradeNotionalStr]);

  const handleTradeNotionalChange = (value: string) => {
    const numericValue = value.replace(/,/g, '');
    if (/^\d*$/.test(numericValue)) {
        setTradeNotionalStr(numericValue);
        setDisplayTradeNotional(formatForDisplay(numericValue));
    }
  };

  const handleNewBondTradeNotionalChange = (value: string) => {
      const numericValue = value.replace(/,/g, '');
      if (/^\d*$/.test(numericValue)) {
          setNewBondTradeNotionalStr(numericValue);
          setDisplayNewBondTradeNotional(formatForDisplay(numericValue));
      }
  };
  
  const updateTrades = (trades: HypotheticalTrade[]) => {
      setHypotheticalTrades(trades);
      dataService.saveSandboxTrades(trades);
  };

  const simulatedPortfolio = useMemo(() => {
    if (hypotheticalTrades.length === 0) return portfolio;

    const newBondsMap = new Map<string, {notional: number, staticData: BondStaticData}>();
    portfolio.bonds.forEach(bond => {
        const {isin, notional, ...rest} = bond;
        const staticData: BondStaticData = {
            name: rest.name, currency: rest.currency, maturityDate: rest.maturityDate, coupon: rest.coupon,
            price: rest.price, yieldToMaturity: rest.yieldToMaturity, modifiedDuration: rest.modifiedDuration,
            creditRating: rest.creditRating, liquidityScore: rest.liquidityScore, bidAskSpread: rest.bidAskSpread, krd_1y: rest.krd_1y, krd_2y: rest.krd_2y,
            krd_3y: rest.krd_3y, krd_5y: rest.krd_5y, krd_7y: rest.krd_7y, krd_10y: rest.krd_10y
        };
        newBondsMap.set(isin, { notional, staticData });
    });

    hypotheticalTrades.forEach(trade => {
        let existing = newBondsMap.get(trade.isin);
        
        if (!existing) {
            const masterData = bondMasterData[trade.isin];
            if (masterData) {
                existing = { notional: 0, staticData: masterData };
            }
        }
        
        if (existing) {
            const newNotional = trade.action === 'BUY'
                ? existing.notional + trade.notional
                : existing.notional - trade.notional;
            
            if (newNotional > 0) {
                newBondsMap.set(trade.isin, { ...existing, notional: newNotional });
            } else {
                newBondsMap.delete(trade.isin);
            }
        }
    });

    const bondsArray: Bond[] = Array.from(newBondsMap.entries()).map(([isin, {notional, staticData}]) => {
        const marketValue = notional * (staticData.price / 100);
        return {
            ...staticData,
            isin,
            notional,
            marketValue,
            portfolioWeight: 0,
            durationContribution: 0,
        }
    });
    return calculatePortfolioMetrics(bondsArray);
  }, [portfolio, hypotheticalTrades, bondMasterData]);

  const addTrade = (trade: Omit<HypotheticalTrade, 'name' | 'id'>) => {
    const bondData = portfolio.bonds.find(b => b.isin === trade.isin) || bondMasterData[trade.isin];
    if (bondData) {
        const newTrade = { ...trade, name: bondData.name, id: Date.now() };
        updateTrades([...hypotheticalTrades, newTrade]);
    }
  };
  
  const removeTrade = (id: number) => {
      updateTrades(hypotheticalTrades.filter(t => t.id !== id));
  };

  const resetTrades = () => {
    updateTrades([]);
    dataService.clearSandboxTrades();
  };

  const handleRunAnalysis = useCallback(() => {
    setIsAnalyzing(true);
    setAnalysisError(null);
    setScenarioResult(null);

    setTimeout(() => {
        try {
            const scenario: RateScenario = {};
            
            const tenorMap: Record<KrdTenor, number> = {'1y': 1, '2y': 2, '3y': 3, '5y': 5, '7y': 7, '10y': 10};

            if (scenarioType === 'parallel') {
                const shift = Number(scenarioParams.parallel);
                KRD_TENORS.forEach(t => scenario[t] = shift);
            } else if (scenarioType === 'steepener' || scenarioType === 'flattener') {
                const paramsKey = scenarioType === 'steepener' ? 'steepener' : 'flattener';
                const shortShift = Number(scenarioParams[`${paramsKey}Short`]);
                const longShift = Number(scenarioParams[`${paramsKey}Long`]);
                
                const minTenorNum = tenorMap['1y'];
                const maxTenorNum = tenorMap['10y'];
                
                KRD_TENORS.forEach(t => {
                    const tNum = tenorMap[t];
                    const interpolatedShift = shortShift + ( (tNum - minTenorNum) / (maxTenorNum - minTenorNum) ) * (longShift - shortShift);
                    scenario[t] = interpolatedShift;
                });
            } else { // 'custom'
                KRD_TENORS.forEach(t => scenario[t] = Number(scenarioParams.custom[t]));
            }

            const portfolioPnl = calculateScenarioPnl(simulatedPortfolio, scenario, simulatedPortfolio.totalMarketValue, scenarioType);
            const benchmarkPnl = calculateScenarioPnl(benchmark, scenario, simulatedPortfolio.totalMarketValue, scenarioType);

            setScenarioResult({
                portfolioPnl: portfolioPnl.pnl,
                benchmarkPnl: benchmarkPnl.pnl,
                activePnl: portfolioPnl.pnl - benchmarkPnl.pnl,
                portfolioPnlPercent: portfolioPnl.pnlPercent,
                benchmarkPnlPercent: benchmarkPnl.pnlPercent,
            });

        } catch(err: any) {
            setAnalysisError(err.message || "An error occurred during calculation.");
        } finally {
            setIsAnalyzing(false);
        }
    }, 500);
  }, [simulatedPortfolio, benchmark, scenarioParams, scenarioType]);

  const handleScenarioParamChange = (key: string, value: string) => {
    const newParams = {...scenarioParams};
    const keys = key.split('.');
    if (keys.length === 2) {
        (newParams as any)[keys[0]][keys[1]] = value;
    } else {
        (newParams as any)[key] = value;
    }
    setScenarioParams(newParams);
  };
  
  const currentSelectedBond = useMemo(() => {
    return portfolio.bonds.find(b => b.isin === selectedExistingBond);
  }, [selectedExistingBond, portfolio.bonds]);

  const prospectiveNewBond = useMemo(() => {
      const isin = newBondIsin.trim().toUpperCase();
      if (isin && bondMasterData[isin] && !portfolio.bonds.find(b => b.isin === isin)) {
          return bondMasterData[isin];
      }
      return null;
  }, [newBondIsin, bondMasterData, portfolio.bonds]);

  const bondOptions = useMemo(() => 
    portfolio.bonds.slice()
      .sort((a,b) => a.name.localeCompare(b.name))
      .map(b => ({ value: b.isin, label: b.name })),
  [portfolio.bonds]);

  const scenarioOptions = [
    { value: 'parallel', label: 'Parallel Shift' },
    { value: 'steepener', label: 'Steepener' },
    { value: 'flattener', label: 'Flattener' },
    { value: 'custom', label: 'Custom' },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">Scenario Sandbox</h1>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-1 space-y-6">
          <Card>
            <h3 className="text-lg font-semibold text-slate-200 mb-4">Manual Trade Simulator</h3>
            <div className="space-y-4">
                <div className="border border-slate-800 p-3 rounded-lg">
                    <h4 className="text-md font-semibold text-slate-300 mb-2">Trade Existing Holdings</h4>
                    <div>
                      <label htmlFor="bondSelect" className="block text-sm font-medium text-slate-400 mb-1">Select Bond</label>
                      <CustomSelect
                        options={bondOptions}
                        value={selectedExistingBond}
                        onChange={setSelectedExistingBond}
                        placeholder="Select a bond..."
                      />
                      {currentSelectedBond && (
                        <p className="text-xs text-slate-500 mt-1">Currently held: <span className="font-mono text-slate-400">{formatNumber(currentSelectedBond.notional)}</span></p>
                      )}
                   </div>
                   <div className="mt-2">
                      <label htmlFor="tradeAmount" className="block text-sm font-medium text-slate-400">Trade Amount (Notional)</label>
                      <input type="text" id="tradeAmount" value={displayTradeNotional} onChange={e => handleTradeNotionalChange(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                   </div>
                   <div className="mt-3 flex space-x-2">
                        <button onClick={() => addTrade({ action: 'BUY', isin: selectedExistingBond, notional: Number(tradeNotionalStr)})} className="flex-1 bg-green-600 text-white font-bold py-2 px-4 rounded-md hover:bg-green-700 transition-colors text-sm">Buy</button>
                        <button onClick={() => addTrade({ action: 'SELL', isin: selectedExistingBond, notional: Number(tradeNotionalStr)})} className="flex-1 bg-red-600 text-white font-bold py-2 px-4 rounded-md hover:bg-red-700 transition-colors text-sm">Sell</button>
                   </div>
                </div>

                <div className="border border-slate-800 p-3 rounded-lg">
                    <h4 className="text-md font-semibold text-slate-300 mb-2">Buy New Security</h4>
                    <div>
                      <label htmlFor="newIsin" className="block text-sm font-medium text-slate-400">Security ISIN</label>
                      <input type="text" id="newIsin" placeholder="Enter ISIN..." value={newBondIsin} onChange={e => setNewBondIsin(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                    </div>
                    {prospectiveNewBond && (
                        <div className="mt-2 text-xs bg-slate-800 p-2 rounded-md">
                           <p className="text-green-400">Found: <span className="text-slate-300 font-semibold">{prospectiveNewBond.name}</span></p>
                        </div>
                    )}
                    <div className="mt-2">
                      <label htmlFor="newTradeAmount" className="block text-sm font-medium text-slate-400">Trade Amount (Notional)</label>
                      <input type="text" id="newTradeAmount" value={displayNewBondTradeNotional} onChange={e => handleNewBondTradeNotionalChange(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                   </div>
                   <div className="mt-3 flex space-x-2">
                        <button onClick={() => addTrade({ action: 'BUY', isin: newBondIsin.trim().toUpperCase(), notional: Number(newBondTradeNotionalStr)})} disabled={!prospectiveNewBond} className="flex-1 bg-green-600 text-white font-bold py-2 px-4 rounded-md hover:bg-green-700 transition-colors text-sm disabled:bg-slate-700 disabled:cursor-not-allowed">Buy New</button>
                   </div>
                </div>
               
               <div className="border-t border-slate-800 pt-4">
                    <div className="flex justify-between items-center mb-2">
                        <h4 className="text-md font-semibold text-slate-300">Hypothetical Trades</h4>
                         {hypotheticalTrades.length > 0 && 
                            <button onClick={resetTrades} className="text-xs text-slate-400 hover:text-red-400 hover:underline">
                                Clear All
                            </button>
                         }
                    </div>
                    {hypotheticalTrades.length > 0 ? (
                        <div className="max-h-32 overflow-y-auto space-y-1 pr-2">
                        {hypotheticalTrades.map((t) => (
                            <div key={t.id} className="text-sm flex justify-between items-center bg-slate-800/50 p-1.5 rounded-md">
                                <div className="flex-1 flex">
                                    <span className={`w-10 font-semibold ${t.action === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{t.action}</span>
                                    <span className="truncate mx-2" title={t.name}>{t.name}</span>
                                </div>
                                <span className="w-24 text-right font-mono mr-2">{formatNumber(t.notional)}</span>
                                <button onClick={() => removeTrade(t.id)} className="text-slate-500 hover:text-red-400">
                                    <RemoveIcon />
                                </button>
                            </div>
                        ))}
                        </div>
                    ) : <p className="text-sm text-slate-500">No trades added.</p>}
               </div>
            </div>
          </Card>
          <Card>
             <h3 className="text-lg font-semibold text-slate-200 mb-4">Interest Rate Scenario Modeller</h3>
             <div className="space-y-4">
                <div>
                   <label htmlFor="scenarioType" className="block text-sm font-medium text-slate-300 mb-1">Scenario Type</label>
                   <CustomSelect
                     options={scenarioOptions}
                     value={scenarioType}
                     onChange={(v) => setScenarioType(v as any)}
                   />
                </div>
                 <div className="border-t border-slate-800 pt-4">
                    {scenarioType === 'parallel' && (
                        <div>
                            <label htmlFor="parallel-shift" className="block text-xs font-medium text-slate-400">Shift (bps)</label>
                            <input type="number" id="parallel-shift" value={scenarioParams.parallel} onChange={e => handleScenarioParamChange('parallel', e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-1.5 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                        </div>
                    )}
                    {(scenarioType === 'steepener' || scenarioType === 'flattener') && (
                        <div className="grid grid-cols-2 gap-2">
                             <div>
                                <label htmlFor={`${scenarioType}-short`} className="block text-xs font-medium text-slate-400">1Y Shift (bps)</label>
                                <input type="number" id={`${scenarioType}-short`} value={scenarioType === 'steepener' ? scenarioParams.steepenerShort : scenarioParams.flattenerShort} onChange={e => handleScenarioParamChange(`${scenarioType}Short`, e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-1.5 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                            </div>
                             <div>
                                <label htmlFor={`${scenarioType}-long`} className="block text-xs font-medium text-slate-400">10Y Shift (bps)</label>
                                <input type="number" id={`${scenarioType}-long`} value={scenarioType === 'steepener' ? scenarioParams.steepenerLong : scenarioParams.flattenerLong} onChange={e => handleScenarioParamChange(`${scenarioType}Long`, e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-1.5 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                            </div>
                        </div>
                    )}
                    {scenarioType === 'custom' && (
                        <div className="grid grid-cols-3 gap-2">
                            {KRD_TENORS.map(t => (
                                <div key={t}>
                                    <label htmlFor={`custom-${t}`} className="block text-xs font-medium text-slate-400">{t} Shift (bps)</label>
                                    <input type="number" id={`custom-${t}`} value={scenarioParams.custom[t]} onChange={e => handleScenarioParamChange(`custom.${t}`, e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-1.5 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                                </div>
                            ))}
                        </div>
                    )}
                 </div>
                <button onClick={handleRunAnalysis} disabled={isAnalyzing} className="w-full bg-orange-600 text-white font-bold py-2 px-4 rounded-md hover:bg-orange-700 disabled:bg-slate-700 transition-colors flex justify-center items-center">
                    {isAnalyzing ? <LoadingSpinner/> : "Analyse P&L Impact"}
                </button>
                {analysisError && <p className="text-sm text-red-400 mt-2">{analysisError}</p>}
                {scenarioResult && <PnlDisplay result={scenarioResult} />}
             </div>
          </Card>
        </div>
        <div className="xl:col-span-2">
          <h2 className="text-xl font-bold text-white mb-2">Simulated Portfolio Dashboard</h2>
          <div className="sticky top-0 bg-slate-950 z-10 py-2">
              <p className="text-sm text-amber-300 bg-amber-900/40 border border-amber-500/40 p-2 rounded-md">
                {hypotheticalTrades.length > 0 ? "Displaying simulated portfolio based on your trades." : "Displaying current live portfolio."}
              </p>
          </div>
          <div className="mt-4 -translate-y-6">
             <Dashboard portfolio={simulatedPortfolio} benchmark={benchmark} settings={appSettings} />
          </div>
        </div>
      </div>
    </div>
  );
};
