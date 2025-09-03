import React, { useState, useCallback } from 'react';
import { Card } from './Card';

interface FileUploadCardProps {
    title: string;
    description: string;
    expectedColumns: string[];
    onFileUpload: (file: File) => Promise<void>;
    lastUpdated?: string;
}

type Status = 'idle' | 'processing' | 'success' | 'error';

const UploadIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
    </svg>
);

export const FileUploadCard: React.FC<FileUploadCardProps> = ({ title, description, expectedColumns, onFileUpload, lastUpdated }) => {
    const [status, setStatus] = useState<Status>('idle');
    const [message, setMessage] = useState('Drag & drop your CSV file here, or click to select.');
    const [isDragOver, setIsDragOver] = useState(false);

    const handleFile = useCallback(async (file: File | null) => {
        if (!file) return;

        setStatus('processing');
        setMessage(`Processing "${file.name}"...`);
        try {
            await onFileUpload(file);
            setStatus('success');
            setMessage(`Successfully loaded "${file.name}". App has been updated.`);
        } catch (err: any) {
            setStatus('error');
            setMessage(err.message || 'An unknown error occurred.');
        }
    }, [onFileUpload]);

    const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragOver(false);
        const file = event.dataTransfer.files?.[0];
        handleFile(file);
    }, [handleFile]);

    const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
    };
    
    const handleDragEnter = () => setIsDragOver(true);
    const handleDragLeave = () => setIsDragOver(false);
    
    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        handleFile(file);
        event.target.value = ''; // Reset input
    };
    
    const getBorderColor = () => {
        if (isDragOver) return 'border-orange-500';
        switch (status) {
            case 'success': return 'border-green-500/80';
            case 'error': return 'border-red-500/80';
            default: return 'border-slate-700';
        }
    }

    return (
        <Card className="flex flex-col">
            <div className="flex justify-between items-start">
                <h3 className="text-lg font-semibold text-slate-200">{title}</h3>
                {lastUpdated && <span className="text-xs text-slate-500 whitespace-nowrap">Last updated:</span>}
            </div>
             <div className="flex justify-between items-start">
                <p className="text-sm text-slate-400 mt-1">{description}</p>
                 {lastUpdated && <span className="text-xs text-slate-400 text-right">{lastUpdated}</span>}
            </div>
            <div className="text-xs text-slate-500 bg-slate-950 p-2 rounded-md mt-3">
                <span className="font-semibold">Expected Columns:</span> {expectedColumns.join(', ')}
            </div>

            <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                className={`mt-4 p-6 border-2 border-dashed rounded-lg text-center cursor-pointer transition-all ${getBorderColor()}`}
                onClick={() => document.getElementById(`fileInput-${title}`)?.click()}
            >
                <input
                    type="file"
                    id={`fileInput-${title}`}
                    className="hidden"
                    accept=".csv"
                    onChange={handleInputChange}
                    disabled={status === 'processing'}
                />
                <div className="flex flex-col items-center justify-center">
                    <UploadIcon />
                    <p className={`mt-2 text-sm ${
                        status === 'error' ? 'text-red-400' : 
                        status === 'success' ? 'text-green-400' : 'text-slate-400'
                    }`}>
                        {message}
                    </p>
                </div>
            </div>
        </Card>
    );
};
