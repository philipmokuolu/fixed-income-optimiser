import React, { useState, useMemo, useCallback } from 'react';
import { Portfolio, Benchmark, Bond, ProposedTrade, KrdTenor, KRD_TENORS, AppSettings } from '@/types';
import { Card } from '@/components/shared/Card';
import { Dashboard } from '@/components/Dashboard';
import { calculateScenarioPnl, RateScenario, calculatePortfolioMetrics } from '@/services/portfolioService';
import * as dataService from '@/services/dataService';

interface SandboxProps {
  portfolio: Portfolio;
  benchmark: Benchmark;
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

export const Sandbox: React.FC<SandboxProps> = ({ portfolio, benchmark }) => {
  const [hypotheticalTrades, setHypotheticalTrades] = useState<ProposedTrade[]>([]);
  const [tradeAmount, setTradeAmount] = useState(1000000);
  const [selectedBondId, setSelectedBondId] = useState<string>(portfolio.bonds[0]?.isin || '');
  
  const [scenarioType, setScenarioType] = useState<'parallel' | 'steepener' | 'flattener' | 'custom'>('parallel');
  const [scenarioParams, setScenarioParams] = useState({
    parallel: 50,
    steepenerShort: 10,
    steepenerLong: 50,
    flattenerShort: 50,
    flattenerLong: 10,
    custom: KRD_TENORS.reduce((acc, t) => ({ ...acc, [t]: 0 }), {} as Record<KrdTenor, number>)
  });

  const [scenarioResult, setScenarioResult] = useState<ScenarioResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  
  const appSettings = useMemo(() => dataService.loadAppSettings(), []);

  const simulatedPortfolio = useMemo(() => {
    if (hypotheticalTrades.length === 0) return portfolio;

    const newBondsMap = new Map<string, Bond>();
    portfolio.bonds.forEach(bond => newBondsMap.set(bond.isin, { ...bond }));

    hypotheticalTrades.forEach(trade => {
      const existingBond = newBondsMap.get(trade.bondId);
      if (existingBond) {
        const newMarketValue = trade.action === 'BUY'
          ? existingBond.marketValue + trade.amount
          : existingBond.marketValue - trade.amount;
        
        if (newMarketValue > 1000) { // Keep bond if MV > 1000
            newBondsMap.set(trade.bondId, {...existingBond, marketValue: newMarketValue });
        } else {
            newBondsMap.delete(trade.bondId); // Remove if sold completely
        }
      }
    });

    const bondsArray = Array.from(newBondsMap.values());
    return calculatePortfolioMetrics(bondsArray);
  }, [portfolio, hypotheticalTrades]);

  const addTrade = (action: 'BUY' | 'SELL') => {
    const bond = portfolio.bonds.find(b => b.isin === selectedBondId);
    if (bond) {
        setHypotheticalTrades(prev => [...prev, {
            action,
            bondId: bond.isin,
            bondName: bond.name,
            amount: tradeAmount
        }]);
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
                    KRD_TENORS.forEach(t => scenario[t] = scenarioParams.parallel);
                    break;
                case 'steepener':
                case 'flattener':
                    const shortRate = scenarioType === 'steepener' ? scenarioParams.steepenerShort : scenarioParams.flattenerShort;
                    const longRate = scenarioType === 'steepener' ? scenarioParams.steepenerLong : scenarioParams.flattenerLong;
                    // Linear interpolation between 2y and 10y
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
                    Object.assign(scenario, scenarioParams.custom);
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
    }, 500); // simulate calculation
  }, [simulatedPortfolio, benchmark, scenarioType, scenarioParams]);

  const handleScenarioParamChange = (key: string, value: string) => {
    const numValue = Number(value) || 0;
    setScenarioParams(p => {
        const newParams = {...p};
        const keys = key.split('.');
        if (keys.length === 2) { // for custom.1y
            (newParams as any)[keys[0]][keys[1]] = numValue;
        } else {
            (newParams as any)[key] = numValue;
        }
        return newParams;
    });
  };

  const renderScenarioInputs = () => {
    switch (scenarioType) {
        case 'parallel': return (
            <div>
                <label htmlFor="parallel" className="block text-sm font-medium text-slate-300">Parallel Shift (bps)</label>
                <input type="number" id="parallel" value={scenarioParams.parallel} onChange={e => handleScenarioParamChange('parallel', e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
            </div>
        );
        case 'steepener':
        case 'flattener':
            const mode = scenarioType;
            return (
                <div className='flex space-x-2'>
                    <div>
                        <label htmlFor={`${mode}Short`} className="block text-sm font-medium text-slate-300">2y Shift (bps)</label>
                        <input type="number" id={`${mode}Short`} value={scenarioParams[`${mode}Short`]} onChange={e => handleScenarioParamChange(`${mode}Short`, e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                    </div>
                     <div>
                        <label htmlFor={`${mode}Long`} className="block text-sm font-medium text-slate-300">10y Shift (bps)</label>
                        <input type="number" id={`${mode}Long`} value={scenarioParams[`${mode}Long`]} onChange={e => handleScenarioParamChange(`${mode}Long`, e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                    </div>
                </div>
            );
        case 'custom': return (
             <div className="grid grid-cols-3 gap-2">
                {KRD_TENORS.map(t => (
                    <div key={t}>
                        <label htmlFor={`custom-${t}`} className="block text-xs font-medium text-slate-400">{t} Shift (bps)</label>
                        <input type="number" id={`custom-${t}`} value={scenarioParams.custom[t]} onChange={e => handleScenarioParamChange(`custom.${t}`, e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-1.5 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                    </div>
                ))}
            </div>
        )
    }
  }


  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">Scenario Sandbox</h1>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-1 space-y-6">
          <Card>
            <h3 className="text-lg font-semibold text-slate-200 mb-4">Manual Trade Simulator</h3>
            <div className="space-y-4">
               <div>
                  <label htmlFor="bondSelect" className="block text-sm font-medium text-slate-300">Select Bond</label>
                  <select id="bondSelect" value={selectedBondId} onChange={e => setSelectedBondId(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none">
                    {portfolio.bonds.map(b => <option key={b.isin} value={b.isin}>{b.name}</option>)}
                  </select>
               </div>
               <div>
                  <label htmlFor="tradeAmount" className="block text-sm font-medium text-slate-300">Trade Amount (MV)</label>
                  <input type="number" step="100000" id="tradeAmount" value={tradeAmount} onChange={e => setTradeAmount(Number(e.target.value))} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
               </div>
               <div className="flex space-x-2">
                    <button onClick={() => addTrade('BUY')} className="flex-1 bg-green-600 text-white font-bold py-2 px-4 rounded-md hover:bg-green-700 transition-colors">Buy</button>
                    <button onClick={() => addTrade('SELL')} className="flex-1 bg-red-600 text-white font-bold py-2 px-4 rounded-md hover:bg-red-700 transition-colors">Sell</button>
               </div>
               <div className="border-t border-slate-800 pt-4">
                    <h4 className="text-md font-semibold text-slate-300 mb-2">Hypothetical Trades</h4>
                    {hypotheticalTrades.length > 0 ? (
                        <div className="max-h-32 overflow-y-auto space-y-1 pr-2">
                        {hypotheticalTrades.map((t, i) => (
                            <div key={i} className="text-sm flex justify-between">
                                <span className={t.action === 'BUY' ? 'text-green-400' : 'text-red-400'}>{t.action} {t.bondName.slice(0, 15)}...</span>
                                <span>${t.amount.toLocaleString()}</span>
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
                    {renderScenarioInputs()}
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