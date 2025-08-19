

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

            const fileHeaders = lines[0].split(',').map(h => h.trim());
            
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
                const values = lines[i].split(',');
                const obj: any = {};
                
                for (const expectedKey of expectedHeaders) {
                    const index = headerIndexMap[expectedKey.toLowerCase()];

                    if (index !== undefined) { 
                        let value = values[index]?.trim() || '';

                        // Strip surrounding quotes which might be present on some numeric values
                        if (value.startsWith('"') && value.endsWith('"')) {
                            value = value.slice(1, -1);
                        }
                        
                        const isErrorString = errorStrings.has(value.toUpperCase());
                        const isMaturityDateColumn = expectedKey.toLowerCase() === 'maturitydate';
                        
                        // Clean value for numeric conversion by removing commas
                        const cleanedForNumber = value.replace(/,/g, '');

                        if (isErrorString) {
                            // For maturity date, preserve the error string (e.g., "#N/A") as "N/A" for the parser.
                            // For all other columns, convert to 0 to maintain existing behavior for numeric fields.
                            obj[expectedKey] = isMaturityDateColumn ? "N/A" : 0;
                        } else if (!isNaN(Number(cleanedForNumber)) && cleanedForNumber.trim() !== '' && !isMaturityDateColumn) {
                            // It's a valid number in a column that is NOT maturityDate. Convert to number.
                            obj[expectedKey] = Number(cleanedForNumber);
                        } else {
                            // It's a regular string, or a value in the maturityDate column. Keep as original (but quote-stripped) string.
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
