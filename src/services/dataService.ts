import { PortfolioHolding, BondStaticData, BenchmarkAggregate, BenchmarkHolding, AppSettings, HypotheticalTrade, FxRates } from "@/types";

// Import static data as fallbacks
import { portfolioHoldings as staticHoldings } from "@/data/portfolioHoldings";
import { bondMasterData as staticBondMaster } from "@/data/bondMasterData";
import { benchmarkAggregateData as staticBenchmarkAggregate } from "@/data/benchmarkData";
import { benchmarkHoldings as staticBenchmarkHoldings } from "@/data/benchmarkHoldings";

const LS_KEYS = {
    HOLDINGS: 'FIPO_PORTFOLIO_HOLDINGS',
    BOND_MASTER: 'FIPO_BOND_MASTER_DATA',
    BENCHMARK_AGGREGATE: 'FIPO_BENCHMARK_AGGREGATE',
    BENCHMARK_HOLDINGS: 'FIPO_BENCHMARK_HOLDINGS',
    APP_SETTINGS: 'FIPO_APP_SETTINGS',
    SANDBOX_TRADES: 'FIPO_SANDBOX_TRADES',
    FX_RATES: 'FIPO_FX_RATES',
};

// --- SAVE FUNCTIONS ---

export const savePortfolioHoldings = (holdings: PortfolioHolding[]): void => {
    try {
        localStorage.setItem(LS_KEYS.HOLDINGS, JSON.stringify(holdings));
    } catch (e) {
        console.error("Error saving portfolio holdings to localStorage", e);
    }
};

export const saveBondMasterData = (data: Record<string, BondStaticData>): void => {
    try {
        localStorage.setItem(LS_KEYS.BOND_MASTER, JSON.stringify(data));
    } catch (e) {
        console.error("Error saving bond master data to localStorage", e);
    }
};

export const saveBenchmarkAggregate = (data: BenchmarkAggregate): void => {
     try {
        localStorage.setItem(LS_KEYS.BENCHMARK_AGGREGATE, JSON.stringify(data));
    } catch (e) {
        console.error("Error saving benchmark aggregate to localStorage", e);
    }
};

export const saveBenchmarkHoldings = (data: BenchmarkHolding[]): void => {
     try {
        localStorage.setItem(LS_KEYS.BENCHMARK_HOLDINGS, JSON.stringify(data));
    } catch (e) {
        console.error("Error saving benchmark holdings to localStorage", e);
    }
};

export const saveAppSettings = (settings: AppSettings): void => {
    try {
        localStorage.setItem(LS_KEYS.APP_SETTINGS, JSON.stringify(settings));
    } catch (e) {
        console.error("Error saving app settings to localStorage", e);
    }
};

export const saveSandboxTrades = (trades: HypotheticalTrade[]): void => {
    try {
        localStorage.setItem(LS_KEYS.SANDBOX_TRADES, JSON.stringify(trades));
    } catch (e) {
        console.error("Error saving sandbox trades to localStorage", e);
    }
}

export const saveFxRates = (rates: FxRates): void => {
    try {
        localStorage.setItem(LS_KEYS.FX_RATES, JSON.stringify(rates));
    } catch (e) {
        console.error("Error saving FX rates to localStorage", e);
    }
};

// --- LOAD FUNCTIONS ---

export const loadPortfolioHoldings = (): PortfolioHolding[] => {
    try {
        const storedData = localStorage.getItem(LS_KEYS.HOLDINGS);
        return storedData ? JSON.parse(storedData) : staticHoldings;
    } catch (e) {
        console.error("Error loading portfolio holdings from localStorage, using static data.", e);
        return staticHoldings;
    }
};

export const loadBondMasterData = (): Record<string, BondStaticData> => {
     try {
        const storedData = localStorage.getItem(LS_KEYS.BOND_MASTER);
        return storedData ? JSON.parse(storedData) : staticBondMaster;
    } catch (e) {
        console.error("Error loading bond master data from localStorage, using static data.", e);
        return staticBondMaster;
    }
};

export const loadBenchmarkAggregate = (): BenchmarkAggregate => {
     try {
        const storedData = localStorage.getItem(LS_KEYS.BENCHMARK_AGGREGATE);
        return storedData ? JSON.parse(storedData) : staticBenchmarkAggregate;
    } catch (e) {
        console.error("Error loading benchmark aggregate from localStorage, using static data.", e);
        return staticBenchmarkAggregate;
    }
};

export const loadBenchmarkHoldings = (): BenchmarkHolding[] => {
     try {
        const storedData = localStorage.getItem(LS_KEYS.BENCHMARK_HOLDINGS);
        return storedData ? JSON.parse(storedData) : staticBenchmarkHoldings;
    } catch (e) {
        console.error("Error loading benchmark holdings from localStorage, using static data.", e);
        return staticBenchmarkHoldings;
    }
};

export const loadAppSettings = (): AppSettings => {
    try {
        const storedData = localStorage.getItem(LS_KEYS.APP_SETTINGS);
        if (storedData) {
            const settings = JSON.parse(storedData);
            // Handle migration from old setting to new asymmetrical settings
            if (settings.durationGapThreshold !== undefined) {
                return {
                    maxDurationShortfall: Math.abs(settings.durationGapThreshold),
                    maxDurationSurplus: Math.abs(settings.durationGapThreshold),
                }
            }
            return settings;
        }
    } catch (e) {
        console.error("Error loading app settings from localStorage, using defaults.", e);
    }
    // Default settings if nothing is stored
    return {
        maxDurationShortfall: 0.1,
        maxDurationSurplus: 0.1,
    };
};

export const loadSandboxTrades = (): HypotheticalTrade[] => {
    try {
        const storedData = localStorage.getItem(LS_KEYS.SANDBOX_TRADES);
        return storedData ? JSON.parse(storedData) : [];
    } catch (e) {
        console.error("Error loading sandbox trades from localStorage, using empty list.", e);
        return [];
    }
};

export const loadFxRates = (): FxRates => {
    try {
        const storedData = localStorage.getItem(LS_KEYS.FX_RATES);
        if (storedData) {
            return JSON.parse(storedData);
        }
    } catch (e) {
        console.error("Error loading FX rates from localStorage, using defaults.", e);
    }
    // Default rates if nothing is stored
    return {
        USD: 1.0,
        EUR: 1.08,
        GBP: 1.27,
    };
};

// --- CLEAR FUNCTIONS ---
export const clearSandboxTrades = (): void => {
    try {
        localStorage.removeItem(LS_KEYS.SANDBOX_TRADES);
    } catch (e) {
        console.error("Error clearing sandbox trades from localStorage", e);
    }
};
