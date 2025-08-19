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
            
            // A bug in some CSV exports includes a BOM character at the start of the file.
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
            const errorStrings = new Set(['#N/A', '#VALUE!', '#REF!', '#DIV/0!', '#NUM!', '#NAME?', '#NULL!']);

            for (let i = 1; i < lines.length; i++) {
                // Use a robust CSV line parser that handles quoted fields
                const values = parseCsvLine(lines[i]);
                const obj: any = {};
                
                for (const expectedKey of expectedHeaders) {
                    const index = headerIndexMap[expectedKey.toLowerCase()];

                    if (index !== undefined && index < values.length) { 
                        let value = values[index]?.trim() || '';

                        const isErrorString = errorStrings.has(value.toUpperCase());
                        const isMaturityDateColumn = expectedKey.toLowerCase() === 'maturitydate';
                        
                        // Clean value for numeric conversion by removing commas
                        const cleanedForNumber = value.replace(/,/g, '');

                        if (isErrorString) {
                            obj[expectedKey] = isMaturityDateColumn ? "N/A" : 0;
                        } else if (!isMaturityDateColumn && cleanedForNumber.trim() !== '' && !isNaN(Number(cleanedForNumber))) {
                            obj[expectedKey] = Number(cleanedForNumber);
                        } else {
                            obj[expectedKey] = value;
                        }
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