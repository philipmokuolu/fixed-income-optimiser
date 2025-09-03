/**
 * Parses a single line of a CSV file, correctly handling quoted fields that may contain commas.
 * @param line - The string for a single CSV row.
 * @returns An array of strings, representing the fields in the row.
 */
const parseCsvLine = (line: string): string[] => {
    const fields: string[] = [];
    let currentField = '';
    let inQuotedField = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            // If we are already inside a quoted field
            if (inQuotedField) {
                // Check if this is an escaped quote ("")
                if (i + 1 < line.length && line[i + 1] === '"') {
                    currentField += '"';
                    i++; // Skip the next quote
                } else {
                    // This is the closing quote
                    inQuotedField = false;
                }
            } else {
                // This is the opening quote of a new field
                inQuotedField = true;
            }
        } else if (char === ',' && !inQuotedField) {
            fields.push(currentField);
            currentField = '';
        } else {
            currentField += char;
        }
    }
    fields.push(currentField);
    return fields;
};


export const parseCsvToJson = <T>(
    file: File,
    expectedHeaders: string[]
): Promise<T[]> => {
    return new Promise((resolve, reject) => {
        if (!file) {
            return reject(new Error("No file provided."));
        }
        if (file.type !== 'text/csv' && !file.name.endsWith('.csv')) {
            return reject(new Error("Invalid file type. Please upload a CSV file."));
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            const text = event.target?.result as string;
            if (!text) {
                return reject(new Error("File is empty."));
            }

            const lines = text.split(/\r\n|\n/).filter(line => line.trim() !== '');
            if (lines.length < 2) {
                return reject(new Error("CSV must contain a header row and at least one data row."));
            }
            
            const cleanHeaderLine = lines[0].replace(/^\uFEFF/, '');
            const fileHeaders = cleanHeaderLine.split(',').map(h => h.trim());
            
            const headerIndexMap: Record<string, number> = {};
            fileHeaders.forEach((h, index) => {
                headerIndexMap[h.toLowerCase()] = index;
            });

            const missingHeaders = expectedHeaders.filter(h => headerIndexMap[h.toLowerCase()] === undefined);
            if (missingHeaders.length > 0) {
                return reject(new Error(`CSV is missing required headers: ${missingHeaders.join(', ')}`));
            }

            const jsonResult: T[] = [];
            
            for (let i = 1; i < lines.length; i++) {
                const values = parseCsvLine(lines[i]);
                const obj: any = {};
                
                for (const expectedKey of expectedHeaders) {
                    const index = headerIndexMap[expectedKey.toLowerCase()];
                    // FIX: Moved isNumericColumn declaration to be accessible in the else block.
                    const isNumericColumn = !['isin', 'name', 'currency', 'maturitydate', 'creditrating'].includes(expectedKey.toLowerCase());

                    if (index !== undefined && index < values.length) { 
                        const value = (values[index] || '');
                        
                        if (isNumericColumn) {
                            // For numeric columns, attempt to parse. If it fails for any reason, default to 0.
                            // This robustly handles all error strings, text, hyphens, invisible characters, etc.
                            // 1. Replace non-breaking spaces (a common invisible issue) with regular spaces.
                            // 2. Trim standard whitespace from the ends.
                            // 3. Remove thousands-separator commas.
                            const cleanedValue = value.replace(/\u00A0/g, ' ').trim().replace(/,/g, '');
                            const num = parseFloat(cleanedValue);
                            obj[expectedKey] = isNaN(num) ? 0 : num;
                        } else {
                            // For string columns, just trim whitespace.
                            obj[expectedKey] = value.trim();
                        }
                    } else {
                        // If a column is missing for a row, assign a safe default
                        obj[expectedKey] = isNumericColumn ? 0 : '';
                    }
                }
                jsonResult.push(obj as T);
            }
            resolve(jsonResult);
        };

        reader.onerror = () => {
            reject(new Error("Failed to read the file."));
        };

        reader.readAsText(file);
    });
};