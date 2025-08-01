// This utility provides consistent number formatting across the app.

/**
 * Formats a number with commas as thousands separators.
 * @param num The number to format.
 * @param options Intl.NumberFormat options, e.g., { minimumFractionDigits: 2, maximumFractionDigits: 2 }
 * @returns A formatted string.
 */
export const formatNumber = (
    num: number, 
    options?: Intl.NumberFormatOptions
): string => {
    if (typeof num !== 'number' || isNaN(num)) {
        return 'N/A';
    }
    return num.toLocaleString(undefined, options);
};

/**
 * Formats a number as a currency string (e.g., $1,000,000.00).
 * Prepends a '$' sign.
 * @param num The number to format.
 * @param minimumFractionDigits The minimum number of decimal places.
 * @param maximumFractionDigits The maximum number of decimal places.
 * @returns A formatted currency string.
 */
export const formatCurrency = (
    num: number, 
    minimumFractionDigits = 0,
    maximumFractionDigits = 0
): string => {
     if (typeof num !== 'number' || isNaN(num)) {
        return '$N/A';
    }
    return `$${formatNumber(num, { minimumFractionDigits, maximumFractionDigits })}`;
};

/**
 * Formats a number as a currency in millions (e.g., 1.234M).
 * @param num The number to format.
 * @returns A formatted string in millions.
 */
export const formatCurrencyM = (num: number): string => {
    if (typeof num !== 'number' || isNaN(num)) {
        return 'N/A';
    }
    return `${formatNumber(num / 1e6, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
};