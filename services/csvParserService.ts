
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
            
            const jsonResult: T[] = [];

            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',');
                const obj: any = {};
                for(let j = 0; j < header.length; j++) {
                    const key = header[j];
                    const value = values[j]?.trim() || '';

                    // Attempt to convert to number if it looks like one
                    if (!isNaN(Number(value)) && value !== '') {
                        obj[key] = Number(value);
                    } else {
                        obj[key] = value;
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
