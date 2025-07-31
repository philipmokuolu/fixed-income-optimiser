import React, { useState, useEffect, useCallback } from 'react';
import { FileUploadCard } from '@/components/shared/FileUploadCard';
import { parseCsvToJson } from '@/services/csvParserService';
import * as dataService from '@/services/dataService';
import { PortfolioHolding, BondStaticData, BenchmarkHolding, BenchmarkAggregate, KRD_TENORS, AppSettings } from '@/types';
import { Card } from '@/components/shared/Card';

interface DataHubProps {
    onDataUploaded: () => void;
}

export const DataHub: React.FC<DataHubProps> = ({ onDataUploaded }) => {
    const [benchmarkAggregate, setBenchmarkAggregate] = useState<BenchmarkAggregate | null>(null);
    const [appSettings, setAppSettings] = useState<AppSettings | null>(null);

    const [bmStatus, setBmStatus] = useState('');
    const [settingsStatus, setSettingsStatus] = useState('');


    useEffect(() => {
        setBenchmarkAggregate(dataService.loadBenchmarkAggregate());
        setAppSettings(dataService.loadAppSettings());
    }, []);

    const handleHoldingsUpload = async (file: File) => {
        const expectedHeaders = ['isin', 'notional'];
        const holdingsJson = await parseCsvToJson<PortfolioHolding>(file, expectedHeaders);
        dataService.savePortfolioHoldings(holdingsJson);
        onDataUploaded();
    };

    const handleBondMasterUpload = async (file: File) => {
        const expectedHeaders = ['isin', 'name', 'currency', 'maturityDate', 'coupon', 'price', 'yieldToMaturity', 'modifiedDuration', 'creditRating', 'liquidityScore', ...KRD_TENORS.map(t => `krd_${t}`)];
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

    const handleAggregateChange = (field: keyof BenchmarkAggregate, value: string | number) => {
        if (benchmarkAggregate) {
            setBenchmarkAggregate({ ...benchmarkAggregate, [field]: value });
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

    const handleSettingsChange = (field: keyof AppSettings, value: number) => {
        if (appSettings) {
            setAppSettings({ ...appSettings, [field]: value });
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
                />
                <FileUploadCard
                    title="2. Bond Master & Universe"
                    description="Static and market data for all bonds in your portfolio AND any off-benchmark bonds for the Optimiser."
                    expectedColumns={['isin', 'name', 'price', 'modifiedDuration', '...etc']}
                    onFileUpload={handleBondMasterUpload}
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
                                <input type="number" id="bmDuration" value={benchmarkAggregate.modifiedDuration} onChange={e => handleAggregateChange('modifiedDuration', Number(e.target.value))} className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"/>
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
                        />
                    </div>
                 </Card>
                 <Card>
                    <h3 className="text-lg font-semibold text-slate-200">Dashboard Settings</h3>
                     <p className="text-sm text-slate-400 mt-1 mb-4">Configure risk thresholds and other display settings.</p>
                     {appSettings && (
                         <div className="space-y-4">
                            <div>
                                <label htmlFor="durationGapThreshold" className="block text-sm font-medium text-slate-300">Duration Gap Threshold (yrs)</label>
                                <input 
                                    type="number" 
                                    id="durationGapThreshold" 
                                    step="0.05"
                                    value={appSettings.durationGapThreshold} 
                                    onChange={e => handleSettingsChange('durationGapThreshold', Number(e.target.value))} 
                                    className="mt-1 block w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"
                                />
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
