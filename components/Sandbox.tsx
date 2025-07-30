import React, { useState, useMemo, useCallback } from 'react';
import { Portfolio, Benchmark, Bond, HypotheticalTrade, KrdTenor, KRD_TENORS, AppSettings, BondStaticData } from '@/types';
import { Card } from '@/components/shared/Card';
import { Dashboard } from '@/components/Dashboard';
import { calculateScenarioPnl, RateScenario, calculatePortfolioMetrics } from '@/services/portfolioService';
import * as dataService from '@/services/dataService';

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

const PnlDisplay:React.FC<{result: ScenarioResult}> = ({result}) => {
    const PnlRow: React.FC<{label: string, value: number, percent: number}> = ({label, value, percent}) => {
        const isPositive = value >= 0;
        return (
             <div className="flex justify-between items-center text-sm py-1.5">
                <span className="text-slate-300">{label}</span>
                <span className={`font-mono ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                    {`${isPositive ? '+' : ''}$${value.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}`}
                    <span className="text-xs text-slate-500 ml-2">({percent.toFixed(2)}%)</span>
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
  
  // Trade state for existing holdings
  const [tradeNotional, setTradeNotional] = useState('1000000');
  const [selectedExistingBond, setSelectedExistingBond] = useState<string>(portfolio.bonds[0]?.isin || '');
  
  // Trade state for new holdings
  const [newBondIsin, setNewBondIsin] = useState('');
  const [newBondTradeNotional, setNewBondTradeNotional] = useState('1000000');
  
  const [scenarioType, setScenarioType] = useState<'parallel' | 'steepener' | 'flattener' | 'custom'>('parallel');
  const [scenarioParams, setScenarioParams] = useState({
    parallel: '50',
    steepenerShort: '10',
    steepenerLong: '50',
    flattenerShort: '50',
    flattenerLong: '10',
    custom: KRD_TENORS.reduce((acc, t) => ({ ...acc, [t]: '0' }), {} as Record<KrdTenor, string>)
  });

  const [scenarioResult, setScenarioResult] = useState<ScenarioResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  
  const appSettings = useMemo(() => dataService.loadAppSettings(), []);

  const simulatedPortfolio = useMemo(() => {
    if (hypotheticalTrades.length === 0) return portfolio;

    const newBondsMap = new Map<string, {notional: number, staticData: BondStaticData}>();
    portfolio.bonds.forEach(bond => {
        const {isin, notional, ...rest} = bond;
        // This is tricky; we need to strip calculated fields to get back to the static data
        const staticData: BondStaticData = {
            name: rest.name, currency: rest.currency, maturityDate: rest.maturityDate, coupon: rest.coupon,
            price: rest.price, yieldToMaturity: rest.yieldToMaturity, modifiedDuration: rest.modifiedDuration,
            creditRating: rest.creditRating, liquidityScore: rest.liquidityScore, krd_1y: rest.krd_1y, krd_2y: rest.krd_2y,
            krd_3y: rest.krd_3y, krd_5y: rest.krd_5y, krd_7y: rest.krd_7y, krd_10y: rest.krd_10y
        };
        newBondsMap.set(isin, { notional, staticData });
    });

    hypotheticalTrades.forEach(trade => {
        let existing = newBondsMap.get(trade.isin);
        
        if (!existing) { // Bond is from the master universe, not portfolio
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
            portfolioWeight: 0, // will be recalculated
            durationContribution: 0, // will be recalculated
        }
    });
    return calculatePortfolioMetrics(bondsArray);
  }, [portfolio, hypotheticalTrades, bondMasterData]);

  const addTrade = (trade: Omit<HypotheticalTrade, 'name'>) => {
    const bondData = portfolio.bonds.find(b => b.isin === trade.isin) || bondMasterData[trade.isin];
    if (bondData) {
        setHypotheticalTrades(prev => [...prev, { ...trade, name: bondData.name }]);
    }
  };

  const resetTrades = () => setHypotheticalTrades([]);

  const handleRunAnalysis = useCallback(() => {
    setIsAnalyzing(true);
    setAnalysisError(null);
    setScenarioResult(null);

    setTimeout(() => {
        try {
            const scenario: RateScenario = {};
            switch (scenarioType) {
                case 'parallel':
                    KRD_TENORS.forEach(t => scenario[t] = Number(scenarioParams.parallel));
                    break;
                case 'steepener':
                case 'flattener':
                    const shortRate = Number(scenarioType === 'steepener' ? scenarioParams.steepenerShort : scenarioParams.flattenerShort);
                    const longRate = Number(scenarioType === 'steepener' ? scenarioParams.steepenerLong : scenarioParams.flattenerLong);
                    const rateMap: {[key: string]: number} = {'1y': shortRate, '2y': shortRate, '10y': longRate};
                    const tenorsToInterpolate: KrdTenor[] = ['3y', '5y', '7y'];
                    tenorsToInterpolate.forEach(t => {
                        const tenorNum = parseInt(t.replace('y', ''));
                        const slope = (longRate - shortRate) / (10 - 2);
                        rateMap[t] = shortRate + slope * (tenorNum - 2);
                    });
                    KRD_TENORS.forEach(t => scenario[t] = rateMap[t]);
                    break;
                case 'custom':
                    KRD_TENORS.forEach(t => scenario[t] = Number(scenarioParams.custom[t]));
                    break;
            }

            const portfolioPnl = calculateScenarioPnl(simulatedPortfolio, scenario, simulatedPortfolio.totalMarketValue);
            const benchmarkPnl = calculateScenarioPnl(benchmark, scenario, simulatedPortfolio.totalMarketValue);

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
  }, [simulatedPortfolio, benchmark, scenarioType, scenarioParams]);

  const handleScenarioParamChange = (key: string, value: string) => {
    setScenarioParams(p => {
        const newParams = {...p};
        const keys = key.split('.');
        if (keys.length === 2) {
            (newParams as any)[keys[0]][keys[1]] = value;
        } else {
            (newParams as any)[key] = value;
        }
        return newParams;
    });
  };
  
  const prospectiveNewBond = useMemo(() => {
      const isin = newBondIsin.trim().toUpperCase();
      if (isin && bondMasterData[isin] && !portfolio.bonds.find(b => b.isin === isin)) {
          return bondMasterData[isin];
      }
      return null;
  }, [newBondIsin, bondMasterData, portfolio.bonds]);


  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">Scenario Sandbox</h1>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-1 space-y-6">
          <Card>
            <h3 className="text-lg font-semibold text-slate-200 mb-4">Manual Trade Simulator</h3>
            <div className="space-y-4">
                {/* Trade Existing Holdings */}
                <div className="border border-slate-800 p-3 rounded-lg">
                    <h4 className="text-md font-semibold text-slate-300 mb-2">Trade Existing Holdings</h4>
                    <div>
                      <label htmlFor="bondSelect" className="block text-sm font-medium text-slate-400">Select Bond</label>
                      <select id="bondSelect" value={selectedExistingBond} onChange={e => setSelectedExistingBond(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none">
                        {portfolio.bonds.map(b => <option key={b.isin} value={b.isin}>{b.name}</option>)}
                      </select>
                   </div>
                   <div className="mt-2">
                      <label htmlFor="tradeAmount" className="block text-sm font-medium text-slate-400">Trade Amount (Notional)</label>
                      <input type="number" step="100000" id="tradeAmount" value={tradeNotional} onChange={e => setTradeNotional(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                   </div>
                   <div className="mt-3 flex space-x-2">
                        <button onClick={() => addTrade({ action: 'BUY', isin: selectedExistingBond, notional: Number(tradeNotional)})} className="flex-1 bg-green-600 text-white font-bold py-2 px-4 rounded-md hover:bg-green-700 transition-colors text-sm">Buy</button>
                        <button onClick={() => addTrade({ action: 'SELL', isin: selectedExistingBond, notional: Number(tradeNotional)})} className="flex-1 bg-red-600 text-white font-bold py-2 px-4 rounded-md hover:bg-red-700 transition-colors text-sm">Sell</button>
                   </div>
                </div>

                {/* Buy New Security */}
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
                      <input type="number" step="100000" id="newTradeAmount" value={newBondTradeNotional} onChange={e => setNewBondTradeNotional(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                   </div>
                   <div className="mt-3 flex space-x-2">
                        <button onClick={() => addTrade({ action: 'BUY', isin: newBondIsin.trim().toUpperCase(), notional: Number(newBondTradeNotional)})} disabled={!prospectiveNewBond} className="flex-1 bg-green-600 text-white font-bold py-2 px-4 rounded-md hover:bg-green-700 transition-colors text-sm disabled:bg-slate-700 disabled:cursor-not-allowed">Buy New</button>
                   </div>
                </div>
               
               <div className="border-t border-slate-800 pt-4">
                    <h4 className="text-md font-semibold text-slate-300 mb-2">Hypothetical Trades</h4>
                    {hypotheticalTrades.length > 0 ? (
                        <div className="max-h-32 overflow-y-auto space-y-1 pr-2">
                        {hypotheticalTrades.map((t, i) => (
                            <div key={i} className="text-sm flex justify-between">
                                <span className={`${t.action === 'BUY' ? 'text-green-400' : 'text-red-400'} font-semibold`}>{t.action}</span>
                                <span className="truncate mx-2" title={t.name}>{t.name}</span>
                                <span className="font-mono">{t.notional.toLocaleString()}</span>
                            </div>
                        ))}
                        </div>
                    ) : <p className="text-sm text-slate-500">No trades added.</p>}
                    {hypotheticalTrades.length > 0 && <button onClick={resetTrades} className="mt-2 w-full bg-slate-600 text-white font-bold py-2 px-4 rounded-md hover:bg-slate-700 transition-colors text-sm">Reset Trades</button>}
               </div>
            </div>
          </Card>
          <Card>
             <h3 className="text-lg font-semibold text-slate-200 mb-4">Interest Rate Scenario Modeller</h3>
             <div className="space-y-4">
                <div>
                   <label htmlFor="scenarioType" className="block text-sm font-medium text-slate-300">Scenario Type</label>
                   <select id="scenarioType" value={scenarioType} onChange={e => setScenarioType(e.target.value as any)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none">
                       <option value="parallel">Parallel Shift</option>
                       <option value="steepener">Steepener</option>
                       <option value="flattener">Flattener</option>
                       <option value="custom">Custom</option>
                   </select>
                </div>
                <div className="border-t border-slate-800 pt-4">
                    {scenarioType === 'parallel' ? (
                        <div>
                            <label htmlFor="parallel" className="block text-sm font-medium text-slate-300">Parallel Shift (bps)</label>
                            <input type="number" id="parallel" value={scenarioParams.parallel} onChange={e => handleScenarioParamChange('parallel', e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                        </div>
                     ) : scenarioType === 'steepener' || scenarioType === 'flattener' ? (
                        <div className='flex space-x-2'>
                            <div>
                                <label htmlFor={`${scenarioType}Short`} className="block text-sm font-medium text-slate-300">2y Shift (bps)</label>
                                <input type="number" id={`${scenarioType}Short`} value={scenarioParams[`${scenarioType}Short`]} onChange={e => handleScenarioParamChange(`${scenarioType}Short`, e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                            </div>
                             <div>
                                <label htmlFor={`${scenarioType}Long`} className="block text-sm font-medium text-slate-300">10y Shift (bps)</label>
                                <input type="number" id={`${scenarioType}Long`} value={scenarioParams[`${scenarioType}Long`]} onChange={e => handleScenarioParamChange(`${scenarioType}Long`, e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                            </div>
                        </div>
                     ) : (
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
             <Dashboard portfolio={simulatedPortfolio} benchmark={benchmark} durationGapThreshold={appSettings.durationGapThreshold} />
          </div>
        </div>
      </div>
    </div>
  );
};
