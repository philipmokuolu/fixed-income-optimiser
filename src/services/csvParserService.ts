

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
            
            // Create a map from the lowercase version of the file's headers to their original column index.
            const headerIndexMap: Record<string, number> = {};
            fileHeaders.forEach((h, index) => {
                headerIndexMap[h.toLowerCase()] = index;
            });

            // Perform a case-insensitive check for missing headers.
            const missingHeaders = expectedHeaders.filter(h => headerIndexMap[h.toLowerCase()] === undefined);
            if (missingHeaders.length > 0) {
                return reject(new Error(`CSV is missing required headers: ${missingHeaders.join(', ')}`));
            }

            const jsonResult: T[] = [];
            const errorStrings = new Set(['#N/A', '#VALUE!', '#REF!', '#DIV/0!', '#NUM!', '#NAME?', '#NULL!']);

            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',');
                const obj: any = {};
                
                // Iterate over the headers the app expects to build the object.
                for (const expectedKey of expectedHeaders) {
                    // Find the column index using the lowercase version of the expected key.
                    const index = headerIndexMap[expectedKey.toLowerCase()];

                    // Only process if the expected header exists in the file (it should, due to the check above).
                    if (index !== undefined) { 
                        const value = values[index]?.trim() || '';
                        const isNumericError = errorStrings.has(value.toUpperCase());

                        if (isNumericError) {
                            // It's a recognized error string like #N/A. Default to 0 to prevent calculation errors.
                             obj[expectedKey] = 0;
                        } else if (!isNaN(Number(value)) && value !== '') {
                            // It's a valid number.
                             obj[expectedKey] = Number(value);
                        } else {
                            // It's a regular string. Use the application's expected casing for the final object key.
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
getComputedStyle