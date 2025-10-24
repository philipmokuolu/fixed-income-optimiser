import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ValidationResult } from '@/types';

interface ValidationModalProps {
    isOpen: boolean;
    result: ValidationResult | null;
    fileName: string;
    onClose: () => void;
    onConfirm: () => void;
}

const backdropVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1 },
};

// FIX: Add `as const` to ensure TypeScript infers literal types for framer-motion properties like `ease`.
// This prevents type errors where a string literal (e.g., 'easeOut') is inferred as the general `string` type,
// which is not assignable to the more specific `Easing` type expected by framer-motion.
const modalVariants = {
    hidden: { opacity: 0, scale: 0.95, y: 20 },
    visible: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
    exit: { opacity: 0, scale: 0.95, y: 20, transition: { duration: 0.2, ease: 'easeIn' } },
} as const;

const Icon: React.FC<{ type: 'error' | 'warning' }> = ({ type }) => {
    if (type === 'error') {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
        );
    }
    return (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
    );
};

export const ValidationModal: React.FC<ValidationModalProps> = ({ isOpen, result, fileName, onClose, onConfirm }) => {
    if (!result) return null;

    const hasErrors = result.errors.length > 0;
    const hasWarnings = result.warnings.length > 0;

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    variants={backdropVariants}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
                    onClick={onClose}
                >
                    <motion.div
                        variants={modalVariants}
                        className="bg-slate-900 border border-slate-700 rounded-lg shadow-xl w-full max-w-lg overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-6">
                            <h2 className="text-xl font-bold text-slate-100">Validation Results</h2>
                            <p className="text-sm text-slate-400 mt-1">File: <span className="font-semibold">{fileName}</span></p>
                        </div>

                        <div className="px-6 pb-6 max-h-[60vh] overflow-y-auto space-y-4">
                            {hasErrors && (
                                <div>
                                    <h3 className="text-lg font-semibold text-red-400 flex items-center gap-2"><Icon type="error" /> Errors ({result.errors.length})</h3>
                                    <p className="text-sm text-slate-400 mb-2">Upload is blocked. Please fix these issues in your CSV file and try again.</p>
                                    <ul className="space-y-1 text-sm list-disc list-inside bg-slate-800/50 p-3 rounded-md">
                                        {result.errors.map((e, i) => <li key={`err-${i}`} className="text-red-300">{e.message}</li>)}
                                    </ul>
                                </div>
                            )}

                            {hasWarnings && (
                                <div>
                                    <h3 className="text-lg font-semibold text-amber-400 flex items-center gap-2"><Icon type="warning" /> Warnings ({result.warnings.length})</h3>
                                    <p className="text-sm text-slate-400 mb-2">You can proceed with the upload, but please review these potential issues.</p>
                                    <ul className="space-y-1 text-sm list-disc list-inside bg-slate-800/50 p-3 rounded-md">
                                        {result.warnings.map((w, i) => <li key={`warn-${i}`} className="text-amber-300">{w.message}</li>)}
                                    </ul>
                                </div>
                            )}
                        </div>
                        
                        <div className="bg-slate-800/50 px-6 py-4 flex justify-end items-center space-x-3">
                            <button onClick={onClose} className="px-4 py-2 rounded-md text-sm font-semibold text-slate-300 bg-slate-700 hover:bg-slate-600 transition-colors">
                                Cancel
                            </button>
                            <button
                                onClick={onConfirm}
                                disabled={hasErrors}
                                className="px-4 py-2 rounded-md text-sm font-semibold text-white bg-orange-600 hover:bg-orange-700 transition-colors disabled:bg-slate-600 disabled:cursor-not-allowed"
                            >
                                {hasErrors ? 'Cannot Proceed' : 'Proceed with Upload'}
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
