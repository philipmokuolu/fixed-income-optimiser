import { PortfolioHolding, BondStaticData, BenchmarkHolding, ValidationResult, ValidationIssue, FileType } from '@/types';

type CsvData = PortfolioHolding[] | (BondStaticData & { isin: string })[] | BenchmarkHolding[];

const validateHoldings = (data: PortfolioHolding[]): ValidationResult => {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    data.forEach((row, index) => {
        if (!row.isin) {
            errors.push({ type: 'error', message: `Row ${index + 2}: Missing required 'isin'. This row cannot be processed.` });
        }
        if (typeof row.notional !== 'number') {
            errors.push({ type: 'error', message: `Row ${index + 2} (ISIN: ${row.isin || 'N/A'}): 'notional' is not a valid number.` });
        }
    });

    const zeroNotionalCount = data.filter(r => r.notional === 0).length;
    if (zeroNotionalCount > 0) {
        warnings.push({ type: 'warning', message: `${zeroNotionalCount} holding(s) have a notional of 0.` });
    }

    const duplicateIsins = data
        .map(r => r.isin)
        .filter((isin, index, self) => isin && self.indexOf(isin) !== index);
    
    if (duplicateIsins.length > 0) {
        warnings.push({ type: 'warning', message: `Found duplicate entries for the following ISINs: ${[...new Set(duplicateIsins)].join(', ')}.` });
    }

    return { errors, warnings, isValid: errors.length === 0 };
};

const validateBondMaster = (data: (BondStaticData & { isin: string })[]): ValidationResult => {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    data.forEach((row, index) => {
        if (!row.isin) {
            errors.push({ type: 'error', message: `Row ${index + 2}: Missing required 'isin'. This row cannot be processed.` });
        }
        if (typeof row.price !== 'number' || typeof row.modifiedDuration !== 'number') {
            errors.push({ type: 'error', message: `Row ${index + 2} (ISIN: ${row.isin || 'N/A'}): 'price' or 'modifiedDuration' is not a valid number.` });
        }
    });

    const summary = {
        zeroPrice: 0,
        negativeYield: 0,
        highYield: 0,
        missingRating: 0,
    };

    data.forEach(row => {
        if (row.price === 0) summary.zeroPrice++;
        if (row.yieldToMaturity < 0) summary.negativeYield++;
        if (row.yieldToMaturity > 50) summary.highYield++;
        if (!row.creditRating || row.creditRating === 'N/A') summary.missingRating++;
    });

    if (summary.zeroPrice > 0) warnings.push({ type: 'warning', message: `${summary.zeroPrice} bond(s) have a price of 0.` });
    if (summary.negativeYield > 0) warnings.push({ type: 'warning', message: `${summary.negativeYield} bond(s) have a negative yield.` });
    if (summary.highYield > 0) warnings.push({ type: 'warning', message: `${summary.highYield} bond(s) have a yield greater than 50%.` });
    if (summary.missingRating > 0) warnings.push({ type: 'warning', message: `${summary.missingRating} bond(s) are missing a 'creditRating'. They will be categorised as 'N/A'.` });
    
    return { errors, warnings, isValid: errors.length === 0 };
};

const validateBenchmarkHoldings = (data: BenchmarkHolding[]): ValidationResult => {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];
    
    data.forEach((row, index) => {
        if (!row.isin) {
            errors.push({ type: 'error', message: `Row ${index + 2}: Missing required 'isin'.` });
        }
        if (typeof row.weight !== 'number') {
            errors.push({ type: 'error', message: `Row ${index + 2} (ISIN: ${row.isin || 'N/A'}): 'weight' is not a valid number.` });
        }
    });
    
    const totalWeight = data.reduce((sum, row) => sum + (typeof row.weight === 'number' ? row.weight : 0), 0);
    if (Math.abs(totalWeight - 1) > 0.01 && Math.abs(totalWeight - 100) > 0.01) {
        warnings.push({ type: 'warning', message: `The sum of weights is ${totalWeight.toFixed(2)}. It's recommended that weights sum to 1 (or 100).` });
    }

    return { errors, warnings, isValid: errors.length === 0 };
};


export const validateData = (data: CsvData, fileType: FileType): ValidationResult => {
    switch (fileType) {
        case 'holdings':
            return validateHoldings(data as PortfolioHolding[]);
        case 'bondMaster':
            return validateBondMaster(data as (BondStaticData & { isin: string })[]);
        case 'benchmarkHoldings':
            return validateBenchmarkHoldings(data as BenchmarkHolding[]);
        default:
            return { errors: [{ type: 'error', message: 'Unknown file type for validation.' }], warnings: [], isValid: false };
    }
};
