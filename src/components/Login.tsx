import React, { useState } from 'react';
import { Card } from '@/components/shared/Card';
import { NevastarLogo } from '@/components/shared/NevastarLogo';

interface LoginProps {
    onLoginSuccess: () => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    
    const correctPassword = "NevastarPM25!";

    const handleLogin = (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        setTimeout(() => {
            if (password === correctPassword) {
                onLoginSuccess();
            } else {
                setError('Incorrect password. Please try again.');
                setIsLoading(false);
            }
        }, 500);
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-slate-950">
            <Card className="w-full max-w-sm">
                <form onSubmit={handleLogin}>
                    <div className="flex flex-col items-center mb-6">
                        <NevastarLogo className="w-16 h-16 text-orange-400" />
                        <h1 className="text-xl font-bold text-center text-slate-100 mt-4">
                            Nevastar - Fixed Income Portfolio Optimiser
                        </h1>
                    </div>
                    <div className="space-y-4">
                        <div>
                            <label htmlFor="password" className="sr-only">Password</label>
                            <input
                                type="password"
                                id="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Password"
                                className="w-full bg-slate-800 border border-slate-700 rounded-md p-3 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none text-center"
                                disabled={isLoading}
                            />
                        </div>
                        <button
                            type="submit"
                            className="w-full bg-orange-600 text-white font-bold py-3 px-4 rounded-md hover:bg-orange-700 disabled:bg-slate-700 disabled:cursor-not-allowed transition-colors"
                            disabled={isLoading}
                        >
                            {isLoading ? 'Verifying...' : 'Enter'}
                        </button>
                    </div>
                     {error && <p className="text-red-400 text-sm text-center mt-4">{error}</p>}
                </form>
            </Card>
        </div>
    );
};
