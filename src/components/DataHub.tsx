import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { FileUploadCard } from '@/components/shared/FileUploadCard';
import { parseCsvToJson } from '@/services/csvParserService';
import * as dataService from '@/services/dataService';
import { PortfolioHolding, BondStaticData, BenchmarkHolding, BenchmarkAggregate, KRD_TENORS, AppSettings, FxRates } from '@/types';
import { Card } from '@/components/shared/Card';

interface DataHubProps {
    onDataUploaded: () => void;
}

export const DataHub: React.FC<DataHubProps> = ({ onDataUploaded }) => {
    const [benchmarkAggregate, setBenchmarkAggregate] = useState<BenchmarkAggregate | null>(null);
    const [bmDurationStr, setBmDurationStr] = useState('');
    const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
    const [fxRates, setFxRates] = useState<FxRates | null>(null);

    const [bmStatus, setBmStatus] = useState('');
    const [settingsStatus, setSettingsStatus] = useState('');
    const [fxStatus, setFxStatus] = useState('');

    useEffect(() => {
        const loadedBenchmark = dataService.loadBenchmarkAggregate();
        const loadedSettings = dataService.loadAppSettings();
        const loadedFxRates = dataService.loadFxRates();

        setBenchmarkAggregate(loadedBenchmark);
        setBmDurationStr(String(loadedBenchmark.modifiedDuration));
        setAppSettings(loadedSettings);
        setFxRates(loadedFxRates);
    }, []);

    const detectedCurrencies = useMemo(() => {
        const holdings = dataService.loadPortfolioHoldings();
        const masterData = dataService.loadBondMasterData();
        const currencies = new Set<string>();
        holdings.forEach(h => {
            const bond = masterData[h.isin];
            if (bond && bond.currency !== 'USD') {
                currencies.add(bond.currency);
            }
        });
        return Array.from(currencies);
    }, [onDataUploaded]); // Re-run when data changes

    const handleHoldingsUpload = async (file: File) => {
        const expectedHeaders = ['isin', 'notional'];
        const holdingsJson = await parseCsvToJson<PortfolioHolding>(file, expectedHeaders);
        dataService.savePortfolioHoldings(holdingsJson);
        onDataUploaded();
    };

    const handleBondMasterUpload = async (file: File) => {
        const expectedHeaders = ['isin', 'name', 'currency', 'maturityDate', 'coupon', 'price', 'yieldToMaturity', 'modifiedDuration', 'creditRating', 'liquidityScore', 'bidAskSpread', ...KRD_TENORS.map(t => `krd_${t}`), 'minTradeSize', 'tradeIncrement'];
        const bondMasterJson = await parseCsvToJson<(BondStaticData & { isin: string })>(file, expectedHeaders);
        
        const bondMasterRecord = bondMasterJson.reduce((acc, bond) => {
            const { isin, ...staticData } = bond;
            if (isin) {
                acc[isin] = staticData as BondStaticData;
            }
            return acc;
        }, {} as Record<string, BondStaticData>);

        dataService.saveBondMasterData(bondMasterRecord);
        onDataUploaded();
    };

    const handleBenchmarkHoldingsUpload = async (file: File) => {
        const expectedHeaders = ['isin', 'weight'];
        const benchmarkHoldingsJson = await parseCsvToJson<BenchmarkHolding>(file, expectedHeaders);
        dataService.saveBenchmarkHoldings(benchmarkHoldingsJson);
        onDataUploaded();
    };

    const handleAggregateChange = (field: keyof Omit<BenchmarkAggregate, 'modifiedDuration'>, value: string) => {
        if (benchmarkAggregate) {
            setBenchmarkAggregate({ ...benchmarkAggregate, [field]: value });
        }
    };
    
    const handleBmDurationChange = (value: string) => {
        if (/^\d*\.?\d*$/.test(value)) {
            setBmDurationStr(value);
            const numValue = parseFloat(value);
            if (!isNaN(numValue) && benchmarkAggregate) {
                setBenchmarkAggregate({...benchmarkAggregate, modifiedDuration: numValue});
            }
        }
    };

    const handleSaveAggregate = useCallback(() => {
        if (benchmarkAggregate) {
            dataService.saveBenchmarkAggregate(benchmarkAggregate);
            setBmStatus('Benchmark details saved!');
            onDataUploaded();
            setTimeout(() => setBmStatus(''), 3000);
        }
    }, [benchmarkAggregate, onDataUploaded]);

    const handleSettingsChange = (field: keyof AppSettings, value: string) => {
        if (appSettings) {
             const numValue = Math.abs(Number(value));
            setAppSettings({ ...appSettings, [field]: isNaN(numValue) ? 0 : numValue });
        }
    }
    
    const handleSaveSettings = useCallback(() => {
        if (appSettings) {
            dataService.saveAppSettings(appSettings);
            setSettingsStatus('Settings saved successfully!');
            onDataUploaded();
            setTimeout(() => setSettingsStatus(''), 3000);
        }
    }, [appSettings, onDataUploaded]);
    
    const handleFxRateChange = (currency: string, value: string) => {
        if (fxRates) {
            const numValue = Number(value);
            setFxRates({ ...fxRates, [currency]: isNaN(numValue) ? 0 : numValue });
        }
    };

    const handleSaveFxRates = useCallback(() => {
        if (fxRates) {
            dataService.saveFxRates(fxRates);
            setFxStatus('FX rates saved!');
            onDataUploaded();
            setTimeout(() => setFxStatus(''), 3000);
        }
    }, [fxRates, onDataUploaded]);


    return (
        <div className="p-4 sm:p-6 lg:p-8 space-y-6">
            <h1 className="text-2xl font-bold text-white">Data Hub</h1>
            <p className="text-slate-400 max-w-3xl">
                Upload your data and configure settings below. All changes are saved in your browser's local storage for future sessions. 
                If no data is provided, the application will use the default sample data.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 items-start">
                <FileUploadCard
                    title="1. Portfolio Holdings"
                    description="Your current portfolio positions."
                    expectedColumns={['isin', 'notional']}
                    onFileUpload={handleHoldingsUpload}
                    storageKey={dataService.LS_KEYS.HOLDINGS_META}
                />
                <FileUploadCard
                    title="2. Bond Master & Universe"
                    description="Static and market data for all bonds in your portfolio AND any off-benchmark bonds for the Optimiser."
                    expectedColumns={['isin', 'name', 'price', 'modifiedDuration', 'bidAskSpread', 'minTradeSize', 'tradeIncrement', '...etc']}
                    onFileUpload={handleBondMasterUpload}
                    storageKey={dataService.LS_KEYS.BOND_MASTER_META}
                />
                 <Card>
                    <h3 className="text-lg font-semibold text-slate-200">3. Benchmark Configuration</h3>
                    <p className="text-sm text-slate-400 mt-1 mb-4">Enter aggregate data and upload constituent holdings for KRD calculations.</p>
                    
                    {benchmarkAggregate && (
                        <div className='space-y-4'>
                             <div>
                                <label htmlFor="bmName" className="block text-sm font-medium text-slate-300">Benchmark Name</label>
                                <input type="text" id="bmName" value={benchmarkAggregate.name} onChange={e => handleAggregateChange('name', e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                            </div>
                             <div>
                                <label htmlFor="bmTicker" className="block text-sm font-medium text-slate-300">Benchmark Ticker</label>
                                <input type="text" id="bmTicker" value={benchmarkAggregate.ticker} onChange={e => handleAggregateChange('ticker', e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                            </div>
                             <div>
                                <label htmlFor="bmDuration" className="block text-sm font-medium text-slate-300">Modified Duration</label>
                                <input type="text" pattern="[0-9]*\.?[0-9]*" id="bmDuration" value={bmDurationStr} onChange={e => handleBmDurationChange(e.target.value)} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
                            </div>
                            <button onClick={handleSaveAggregate} className="w-full bg-orange-600 text-white font-bold py-2 px-4 rounded-md hover:bg-orange-700 transition-colors text-sm">
                                Save Benchmark Details
                            </button>
                            {bmStatus && <p className="text-green-400 text-xs text-center mt-2">{bmStatus}</p>}
                        </div>
                    )}
                    
                    <div className="mt-6 border-t border-slate-800 pt-4">
                        <FileUploadCard
                            title="Upload Benchmark Holdings"
                            description="For KRD calculations."
                            expectedColumns={['isin', 'weight']}
                            onFileUpload={handleBenchmarkHoldingsUpload}
                            storageKey={dataService.LS_KEYS.BENCHMARK_HOLDINGS_META}
                        />
                    </div>
                 </Card>
                 <Card>
                    <h3 className="text-lg font-semibold text-slate-200">4. FX Rates</h3>
                     <p className="text-sm text-slate-400 mt-1 mb-4">Enter exchange rates for all non-USD currencies in your portfolio. (e.g., for EUR, enter the EUR/USD rate)</p>
                     {fxRates && (
                         <div className="space-y-4">
                            {detectedCurrencies.length > 0 ? detectedCurrencies.map(currency => (
                                <div key={currency}>
                                    <label htmlFor={`fx-${currency}`} className="block text-sm font-medium text-slate-300">{currency} / USD</label>
                                    <input 
                                        type="number"
                                        id={`fx-${currency}`}
                                        step="0.0001"
                                        value={fxRates[currency] || ''}
                                        onChange={e => handleFxRateChange(currency, e.target.value)}
                                        className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"
                                    />
                                </div>
                            )) : <p className="text-sm text-slate-500">No non-USD currencies detected in portfolio.</p>}
                            
                            {detectedCurrencies.length > 0 && 
                                <button onClick={handleSaveFxRates} className="w-full bg-orange-600 text-white font-bold py-2 px-4 rounded-md hover:bg-orange-700 transition-colors text-sm">
                                    Save FX Rates
                                </button>
                            }
                            {fxStatus && <p className="text-green-400 text-xs text-center mt-2">{fxStatus}</p>}
                         </div>
                     )}
                 </Card>
                 <Card>
                    <h3 className="text-lg font-semibold text-slate-200">5. Dashboard Settings</h3>
                     <p className="text-sm text-slate-400 mt-1 mb-4">Configure risk thresholds and other display settings.</p>
                     {appSettings && (
                         <div className="space-y-4">
                            <div>
                                <label htmlFor="maxDurationShortfall" className="block text-sm font-medium text-slate-300">Max. Duration Shortfall (yrs)</label>
                                <input 
                                    type="number" 
                                    id="maxDurationShortfall" 
                                    step="0.05"
                                    value={appSettings.maxDurationShortfall} 
                                    onChange={e => handleSettingsChange('maxDurationShortfall', e.target.value)} 
                                    className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"
                                />
                                <p className="text-xs text-slate-500 mt-1">Maximum allowed duration gap below benchmark (e.g., 0.1 for a gap of -0.1).</p>
                            </div>
                            <div>
                                <label htmlFor="maxDurationSurplus" className="block text-sm font-medium text-slate-300">Max. Duration Surplus (yrs)</label>
                                <input 
                                    type="number" 
                                    id="maxDurationSurplus" 
                                    step="0.05"
                                    value={appSettings.maxDurationSurplus} 
                                    onChange={e => handleSettingsChange('maxDurationSurplus', e.target.value)} 
                                    className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"
                                />
                                 <p className="text-xs text-slate-500 mt-1">Maximum allowed duration gap above benchmark (e.g., 0.1 for a gap of +0.1).</p>
                            </div>
                            <button onClick={handleSaveSettings} className="w-full bg-orange-600 text-white font-bold py-2 px-4 rounded-md hover:bg-orange-700 transition-colors text-sm">
                                Save Settings
                            </button>
                            {settingsStatus && <p className="text-green-400 text-xs text-center mt-2">{settingsStatus}</p>}
                         </div>
                     )}
                 </Card>
            </div>
        </div>
    );
};