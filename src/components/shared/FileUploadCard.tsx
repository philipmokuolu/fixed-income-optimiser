import React, { useState, useCallback, useEffect } from 'react';
import { Card } from './Card';
import * as dataService from '@/services/dataService';
import { ValidationModal } from './ValidationModal';
import { FileType, ValidationResult } from '@/types';
import { parseCsvToJson } from '@/services/csvParserService';
import { validateData } from '@/services/validationService';

interface FileUploadCardProps {
    title: string;
    description: string;
    expectedColumns: string[];
    onFileUpload: (file: File) => Promise<void>;
    storageKey: string;
    fileType: FileType;
}

type Status = 'idle' | 'processing' | 'success' | 'error';

const UploadIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
    </svg>
);

export const FileUploadCard: React.FC<FileUploadCardProps> = ({ title, description, expectedColumns, onFileUpload, storageKey, fileType }) => {
    const [status, setStatus] = useState<Status>('idle');
    const [message, setMessage] = useState('Drag & drop your CSV file here, or click to select.');
    const [isDragOver, setIsDragOver] = useState(false);
    const [metadata, setMetadata] = useState<dataService.FileMetadata | null>(null);

    // State for validation modal
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
    const [stagedFile, setStagedFile] = useState<File | null>(null);


    useEffect(() => {
        setMetadata(dataService.loadFileMetadata(storageKey));
    }, [storageKey]);

    const handleFile = useCallback(async (file: File | null) => {
        if (!file) return;

        setStatus('processing');
        setMessage(`Validating "${file.name}"...`);
        setStagedFile(file);

        try {
            // Step 1: Parse the CSV (this can throw errors for malformed files)
            const jsonData = await parseCsvToJson(file, expectedColumns);
            
            // Step 2: Validate the parsed JSON data
            const result = validateData(jsonData, fileType);
            setValidationResult(result);
            
            if (result.errors.length > 0 || result.warnings.length > 0) {
                // If there are any issues, open the modal for user review
                setIsModalOpen(true);
                // The status will be updated based on modal interaction
            } else {
                // No issues found, proceed directly with the upload
                await onFileUpload(file);
                const newMetadata = { fileName: file.name, uploadDate: new Date().toISOString() };
                dataService.saveFileMetadata(storageKey, newMetadata);
                setMetadata(newMetadata);
                setStatus('success');
                setMessage(`Successfully loaded "${file.name}". App has been updated.`);
            }

        } catch (err: any) {
            setStatus('error');
            setMessage(err.message || 'An unknown error occurred during parsing.');
            setStagedFile(null);
            setValidationResult(null);
        }
    }, [onFileUpload, storageKey, fileType, expectedColumns]);
    
    const handleConfirmUpload = useCallback(async () => {
        if (stagedFile && validationResult && validationResult.isValid) {
            setIsModalOpen(false);
            setMessage(`Processing "${stagedFile.name}"...`);
            try {
                await onFileUpload(stagedFile);
                const newMetadata = { fileName: stagedFile.name, uploadDate: new Date().toISOString() };
                dataService.saveFileMetadata(storageKey, newMetadata);
                setMetadata(newMetadata);
                setStatus('success');
                setMessage(`Successfully loaded "${stagedFile.name}". App has been updated.`);
            } catch (uploadErr: any) {
                setStatus('error');
                setMessage(uploadErr.message || 'An error occurred during final processing.');
            } finally {
                setStagedFile(null);
                setValidationResult(null);
            }
        }
    }, [stagedFile, validationResult, onFileUpload, storageKey]);

    const handleCloseModal = () => {
        setIsModalOpen(false);
        setStatus('idle');
        setMessage('Drag & drop your CSV file here, or click to select.');
        setStagedFile(null);
        setValidationResult(null);
    };


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
        <>
            <ValidationModal
                isOpen={isModalOpen}
                result={validationResult}
                fileName={stagedFile?.name || ''}
                onClose={handleCloseModal}
                onConfirm={handleConfirmUpload}
            />
            <Card className="flex flex-col">
                <h3 className="text-lg font-semibold text-slate-200">{title}</h3>
                <p className="text-sm text-slate-400 mt-1">{description}</p>
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
                {metadata && (
                    <div className="mt-2 text-xs text-slate-500 text-center border-t border-slate-800 pt-2">
                        Last file loaded: <span className="font-semibold text-slate-400">{metadata.fileName}</span> on {new Date(metadata.uploadDate).toLocaleDateString()}
                    </div>
                )}
            </Card>
        </>
    );
};
