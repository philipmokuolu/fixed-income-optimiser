import { PortfolioHolding, BondStaticData, BenchmarkAggregate, BenchmarkHolding, AppSettings, HypotheticalTrade, FxRates } from "@/types";

// Import static data as fallbacks
import { portfolioHoldings as staticHoldings } from "@/data/portfolioHoldings";
import { bondMasterData as staticBondMaster } from "@/data/bondMasterData";
import { benchmarkAggregateData as staticBenchmarkAggregate } from "@/data/benchmarkData";
import { benchmarkHoldings as staticBenchmarkHoldings } from "@/data/benchmarkHoldings";

const LS_KEYS = {
    HOLDINGS: 'FIPO_PORTFOLIO_HOLDINGS',
    HOLDINGS_TS: 'FIPO_PORTFOLIO_HOLDINGS_TS',
    BOND_MASTER: 'FIPO_BOND_MASTER_DATA',
    BOND_MASTER_TS: 'FIPO_BOND_MASTER_DATA_TS',
    BENCHMARK_AGGREGATE: 'FIPO_BENCHMARK_AGGREGATE',
    BENCHMARK_HOLDINGS: 'FIPO_BENCHMARK_HOLDINGS',
    BENCHMARK_HOLDINGS_TS: 'FIPO_BENCHMARK_HOLDINGS_TS',
    APP_SETTINGS: 'FIPO_APP_SETTINGS',
    SANDBOX_TRADES: 'FIPO_SANDBOX_TRADES',
    FX_RATES: 'FIPO_FX_RATES',
};

// --- SAVE FUNCTIONS ---

const saveData = (key: string, data: any) => {
    try {
        localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
        console.error(`Error saving ${key} to localStorage`, e);
    }
}

const saveTimestamp = (key: string) => {
    try {
        localStorage.setItem(key, new Date().toISOString());
    } catch (e) {
        console.error(`Error saving timestamp for ${key} to localStorage`, e);
    }
}


export const savePortfolioHoldings = (holdings: PortfolioHolding[]): void => {
    saveData(LS_KEYS.HOLDINGS, holdings);
    saveTimestamp(LS_KEYS.HOLDINGS_TS);
};

export const saveBondMasterData = (data: Record<string, BondStaticData>): void => {
    saveData(LS_KEYS.BOND_MASTER, data);
    saveTimestamp(LS_KEYS.BOND_MASTER_TS);
};

export const saveBenchmarkAggregate = (data: BenchmarkAggregate): void => {
     saveData(LS_KEYS.BENCHMARK_AGGREGATE, data);
};

export const saveBenchmarkHoldings = (data: BenchmarkHolding[]): void => {
     saveData(LS_KEYS.BENCHMARK_HOLDINGS, data);
     saveTimestamp(LS_KEYS.BENCHMARK_HOLDINGS_TS);
};

export const saveAppSettings = (settings: AppSettings): void => {
    saveData(LS_KEYS.APP_SETTINGS, settings);
};

export const saveSandboxTrades = (trades: HypotheticalTrade[]): void => {
    saveData(LS_KEYS.SANDBOX_TRADES, trades);
}

export const saveFxRates = (rates: FxRates): void => {
    saveData(LS_KEYS.FX_RATES, rates);
};

// --- LOAD FUNCTIONS ---

const loadData = <T>(key: string, fallback: T): T => {
    try {
        const storedData = localStorage.getItem(key);
        return storedData ? JSON.parse(storedData) : fallback;
    } catch (e) {
        console.error(`Error loading ${key} from localStorage, using fallback.`, e);
        return fallback;
    }
}

export const loadTimestamp = (key: string): string | null => {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}

export const loadPortfolioHoldings = (): PortfolioHolding[] => loadData(LS_KEYS.HOLDINGS, staticHoldings);
export const loadBondMasterData = (): Record<string, BondStaticData> => loadData(LS_KEYS.BOND_MASTER, staticBondMaster);
export const loadBenchmarkAggregate = (): BenchmarkAggregate => loadData(LS_KEYS.BENCHMARK_AGGREGATE, staticBenchmarkAggregate);
export const loadBenchmarkHoldings = (): BenchmarkHolding[] => loadData(LS_KEYS.BENCHMARK_HOLDINGS, staticBenchmarkHoldings);
export const loadSandboxTrades = (): HypotheticalTrade[] => loadData(LS_KEYS.SANDBOX_TRADES, []);

export const loadAppSettings = (): AppSettings => {
    const fallback = { maxDurationShortfall: 0.1, maxDurationSurplus: 0.1 };
    const stored = loadData(LS_KEYS.APP_SETTINGS, fallback);
    
    if (stored && (stored as any).durationGapThreshold !== undefined) {
        return {
            maxDurationShortfall: Math.abs((stored as any).durationGapThreshold),
            maxDurationSurplus: Math.abs((stored as any).durationGapThreshold),
        }
    }
    return stored || fallback;
};

export const loadFxRates = (): FxRates => {
    const fallback = { USD: 1.0, EUR: 1.08, GBP: 1.27 };
    return loadData(LS_KEYS.FX_RATES, fallback);
};

// --- CLEAR FUNCTIONS ---
export const clearSandboxTrades = (): void => {
    try {
        localStorage.removeItem(LS_KEYS.SANDBOX_TRADES);
    } catch (e) {
        console.error("Error clearing sandbox trades from localStorage", e);
    }
};

export const clearAllData = (): void => {
    try {
        Object.values(LS_KEYS).forEach(key => {
            localStorage.removeItem(key);
        });
        sessionStorage.clear(); // Also clear session storage for things like excluded bonds
        console.log("All application data cleared from local and session storage.");
    } catch (e) {
        console.error("Error clearing all data from storage", e);
    }
};
