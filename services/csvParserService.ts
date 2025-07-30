

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

            const header = lines[0].split(',').map(h => h.trim());
            const missingHeaders = expectedHeaders.filter(h => !header.includes(h));
            if (missingHeaders.length > 0) {
                return reject(new Error(`CSV is missing required headers: ${missingHeaders.join(', ')}`));
            }
            
            // Map header names to their column index for efficient lookup and to ignore extra columns.
            const headerIndexMap: Record<string, number> = {};
            header.forEach((h, index) => {
                headerIndexMap[h] = index;
            });

            const jsonResult: T[] = [];
            const errorStrings = new Set(['#N/A', '#VALUE!', '#REF!', '#DIV/0!', '#NUM!', '#NAME?', '#NULL!']);

            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',');
                const obj: any = {};
                
                // Iterate only over the headers we expect, not all headers in the file.
                for (const key of expectedHeaders) {
                    const index = headerIndexMap[key];

                    // Only process if the expected header exists in the file.
                    if (index !== undefined) { 
                        const value = values[index]?.trim() || '';
                        const isNumericError = errorStrings.has(value.toUpperCase());

                        if (isNumericError) {
                            // It's a recognized error string like #N/A. Default to 0 to prevent calculation errors.
                            obj[key] = 0;
                        } else if (!isNaN(Number(value)) && value !== '') {
                            // It's a valid number.
                            obj[key] = Number(value);
                        } else {
                            // It's a regular string (like 'Apple Inc' or 'AA+').
                            obj[key] = value;
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
