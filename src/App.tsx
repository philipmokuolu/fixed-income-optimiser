import React, { useState, useMemo, useEffect, useCallback } from 'react';
import * as dataService from '@/services/dataService';
import { buildPortfolio, calculatePortfolioMetrics, buildBenchmark } from '@/services/portfolioService';
import { Dashboard } from '@/components/Dashboard';
import { PortfolioDetail } from '@/components/PortfolioDetail';
import { Optimiser } from '@/components/Optimizer';
import { Sandbox } from '@/components/Sandbox';
import { DataHub } from '@/components/DataHub';
import { Login } from '@/components/Login';
import { Portfolio, Benchmark, BondStaticData, AppSettings } from '@/types';

type View = 'dashboard' | 'detail' | 'optimiser' | 'sandbox' | 'datahub';

const NavIcon: React.FC<{ path: string }> = ({ path }) => (
  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={path}></path>
  </svg>
);

const NAV_ITEMS: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <NavIcon path="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /> },
  { id: 'detail', label: 'Holdings', icon: <NavIcon path="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /> },
  { id: 'optimiser', label: 'Optimiser', icon: <NavIcon path="M12 6V4m0 16v-2m0-8v-2m-6 4h2m10 0h2m-7-7l1.414-1.414M5.636 5.636L7.05 7.05m12.728 0l-1.414-1.414M5.636 18.364l1.414-1.414m11.314 0l-1.414-1.414" /> },
  { id: 'sandbox', label: 'Sandbox', icon: <NavIcon path="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.5L15.232 5.232z" /> },
  { id: 'datahub', label: 'Data Hub', icon: <NavIcon path="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /> },
];

const SESSION_KEY = 'FIPO_AUTH_TOKEN';

const App: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(!!sessionStorage.getItem(SESSION_KEY));
  const [activeView, setActiveView] = useState<View>('dashboard');
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [bondMasterData, setBondMasterData] = useState<Record<string, BondStaticData> | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  const loadAppData = useCallback(() => {
    setIsLoading(true);
    // Use a small timeout to allow UI to show loading state
    setTimeout(() => {
        // Load all raw data from sources
        const holdings = dataService.loadPortfolioHoldings();
        const masterData = dataService.loadBondMasterData();
        const benchmarkHoldings = dataService.loadBenchmarkHoldings();
        const benchmarkAggregate = dataService.loadBenchmarkAggregate();
        const settings = dataService.loadAppSettings();
        
        // Build portfolio
        const bonds = buildPortfolio(holdings, masterData);
        setPortfolio(calculatePortfolioMetrics(bonds));
        
        // Build benchmark by combining aggregate data and calculated KRDs
        const benchmarkKRDs = buildBenchmark(benchmarkHoldings, masterData);
        const finalBenchmark: Benchmark = {
            ...benchmarkAggregate,
            ...benchmarkKRDs
        };
        setBenchmark(finalBenchmark);

        setBondMasterData(masterData);
        setAppSettings(settings);
        setIsLoading(false);
    }, 100);
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
        loadAppData();
    }
  }, [isAuthenticated, loadAppData]);

  const handleLoginSuccess = () => {
    sessionStorage.setItem(SESSION_KEY, 'true');
    setIsAuthenticated(true);
  };

  if (!isAuthenticated) {
      return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  const renderView = () => {
    if (isLoading || !portfolio || !benchmark || !bondMasterData || !appSettings) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <div className="flex items-center justify-center space-x-2">
                    <div className="w-6 h-6 rounded-full animate-pulse bg-orange-400"></div>
                    <div className="w-6 h-6 rounded-full animate-pulse bg-orange-400" style={{ animationDelay: '0.2s' }}></div>
                    <div className="w-6 h-6 rounded-full animate-pulse bg-orange-400" style={{ animationDelay: '0.4s' }}></div>
                    <span className="text-slate-200 text-xl ml-4">Loading Data...</span>
                </div>
            </div>
        );
    }

    switch (activeView) {
      case 'dashboard':
        return <Dashboard portfolio={portfolio} benchmark={benchmark} settings={appSettings} />;
      case 'detail':
        return <PortfolioDetail portfolio={portfolio} />;
      case 'optimiser':
        return <Optimiser portfolio={portfolio} benchmark={benchmark} bondMasterData={bondMasterData} appSettings={appSettings}/>;
      case 'sandbox':
        return <Sandbox portfolio={portfolio} benchmark={benchmark} bondMasterData={bondMasterData} />;
      case 'datahub':
        return <DataHub onDataUploaded={loadAppData} />;
      default:
        return <Dashboard portfolio={portfolio} benchmark={benchmark} settings={appSettings} />;
    }
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200">
      {/* Sidebar Navigation */}
      <nav className="w-20 lg:w-64 bg-slate-900 p-2 lg:p-4 flex flex-col justify-between shadow-2xl">
        <div>
          <div className="flex items-center space-x-2 p-2 lg:mb-4">
             <div className="w-10 h-10 bg-orange-600 rounded-lg flex items-center justify-center">
                 <NavIcon path="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
             </div>
             <h1 className="text-xl font-bold text-white hidden lg:block">Fixed Income Portfolio Optimiser</h1>
          </div>
          <ul className="space-y-2">
            {NAV_ITEMS.map(item => (
              <li key={item.id}>
                <button
                  onClick={() => setActiveView(item.id)}
                  className={`w-full flex items-center space-x-3 p-3 rounded-lg transition-colors ${
                    activeView === item.id 
                    ? 'bg-orange-500/20 text-orange-400' 
                    : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                  }`}
                >
                  {item.icon}
                  <span className="font-semibold hidden lg:block">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="p-2 hidden lg:block">
            <p className="text-xs text-slate-500">
                Data as of {new Date().toLocaleDateString()}. For illustrative purposes only.
            </p>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto bg-slate-950">
        {renderView()}
      </main>
    </div>
  );
};

export default App;