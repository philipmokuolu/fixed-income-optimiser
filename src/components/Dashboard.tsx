import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Portfolio, Benchmark, KrdKey, AppSettings } from '@/types';
import { Card } from '@/components/shared/Card';
import { KpiCard } from '@/components/shared/KpiCard';
import { KRD_TENORS } from '@/constants';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import { calculateTrackingError } from '@/services/portfolioService';
import { formatNumber, formatCurrency, formatCurrencyM } from '@/utils/formatting';

interface DashboardProps {
  portfolio: Portfolio;
  benchmark: Benchmark;
  settings: AppSettings;
}

const ChartTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-slate-800 p-2 border border-slate-700 rounded-md shadow-lg">
        <p className="label text-slate-200">{`${label}`}</p>
        {payload.map((pld: any, index: number) => (
          <p key={index} style={{ color: pld.color }} className="text-sm">
            {`${pld.name}: ${typeof pld.value === 'number' ? pld.value.toFixed(2) : pld.value }`}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

const containerVariants = {
  hidden: { opacity: 1 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1
    }
  }
};

const itemVariants = {
  hidden: { y: 20, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: {
      duration: 0.4,
      ease: "easeOut"
    }
  }
};


export const Dashboard: React.FC<DashboardProps> = ({ portfolio, benchmark, settings }) => {
  const durationGap = useMemo(() => portfolio.modifiedDuration - benchmark.modifiedDuration, [portfolio, benchmark]);
  
  const trackingError = useMemo(() => calculateTrackingError(portfolio, benchmark), [portfolio, benchmark]);

  const krdGapData = useMemo(() => {
    return KRD_TENORS.map(tenor => {
      const krdKey: KrdKey = `krd_${tenor}`;
      return {
        tenor,
        'Active KRD': portfolio[krdKey] - benchmark[krdKey]
      }
    });
  }, [portfolio, benchmark]);

  const durationDriftData = useMemo(() => {
    const data = [];
    const initialDuration = portfolio.modifiedDuration;
    // Calibrated based on user feedback: initial 3.46 -> 2.74 in 12 months.
    // This implies a monthly decay rate that we can calculate.
    const endDuration = initialDuration * (2.74 / 3.46); 
    const ratio = endDuration / initialDuration;

    // (1 - decayRate)^12 = ratio  =>  1 - decayRate = ratio^(1/12)
    const monthlyDecayFactor = Math.pow(ratio, 1/12);
    
    for (let i = 0; i <= 12; i++) {
        // Apply exponential decay
        const futureModifiedDuration = initialDuration * Math.pow(monthlyDecayFactor, i);
        data.push({
            month: i,
            'Portfolio Mod. Duration': futureModifiedDuration,
            'Benchmark Mod. Duration': benchmark.modifiedDuration
        });
    }
    return data;
  }, [portfolio, benchmark]);


  const currencyData = useMemo(() => {
    const currencyValues = portfolio.bonds.reduce((acc, bond) => {
      if (!acc[bond.currency]) {
        acc[bond.currency] = 0;
      }
      acc[bond.currency] += bond.marketValue;
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(currencyValues).map(([name, value]) => ({ name, value }));
  }, [portfolio]);

  const COLORS = ['#f97316', '#6366f1', '#14b8a6'];

  const krdComparisonData = useMemo(() => {
    return KRD_TENORS.map(t => {
      const krdKey = `krd_${t}` as KrdKey;
      return {
        tenor: t,
        Portfolio: portfolio[krdKey],
        Benchmark: benchmark[krdKey]
      }
    })
  }, [portfolio, benchmark]);

  const { isDurationGapBreached, breachMessage } = useMemo(() => {
    const { maxDurationShortfall, maxDurationSurplus } = settings;
    const isBreached = durationGap < -maxDurationShortfall || durationGap > maxDurationSurplus;
    let message = 'Within limits';
    if (isBreached) {
        message = durationGap < 0 ? `Breached (< -${maxDurationShortfall}y)` : `Breached (> +${maxDurationSurplus}y)`;
    }
    return { isDurationGapBreached: isBreached, breachMessage: message };
  }, [durationGap, settings]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">Main Dashboard</h1>
      
      <motion.div 
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <KpiCard
          variants={itemVariants}
          title="Portfolio Duration"
          value={`${formatNumber(portfolio.modifiedDuration, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} yrs`}
          change={`Benchmark: ${benchmark.modifiedDuration.toFixed(2)} yrs`}
          changeColor="text-slate-400"
        />
        <KpiCard
          variants={itemVariants}
          title="Duration Gap"
          value={`${formatNumber(durationGap, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} yrs`}
          changeColor={isDurationGapBreached ? 'text-red-400' : 'text-green-400'}
          change={breachMessage}
        />
        <KpiCard
          variants={itemVariants}
          title="Projected Tracking Error"
          value={`${formatNumber(trackingError, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} bps`}
        />
        <KpiCard
          variants={itemVariants}
          title="Total Market Value"
          value={formatCurrency(portfolio.totalMarketValue, 0, 0)}
        />
      </motion.div>

      <motion.div 
        className="grid grid-cols-1 lg:grid-cols-2 gap-6"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <Card variants={itemVariants}>
          <h3 className="text-lg font-semibold text-slate-200 mb-4">Duration Drift Forecaster (12 Months)</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={durationDriftData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="month" tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }} />
              <YAxis 
                tick={{ fill: '#94a3b8' }} 
                tickLine={{ stroke: '#94a3b8' }} 
                domain={['dataMin', 'dataMax']} 
                tickFormatter={(tick) => formatNumber(tick, { minimumFractionDigits: 2, maximumFractionDigits: 2})}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ color: '#94a3b8' }} />
              <Line type="monotone" dataKey="Portfolio Mod. Duration" stroke="#f97316" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Benchmark Mod. Duration" stroke="#f43f5e" strokeWidth={2} strokeDasharray="5 5" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card variants={itemVariants}>
          <h3 className="text-lg font-semibold text-slate-200 mb-4">Key Rate Duration (KRD) Gap Summary</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={krdGapData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="tenor" tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }}/>
              <YAxis tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }}/>
              <Tooltip content={<ChartTooltip />} cursor={{fill: '#334155'}}/>
              <Bar dataKey="Active KRD" fill="#f97316" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card variants={itemVariants} className="lg:col-span-2">
           <h3 className="text-lg font-semibold text-slate-200 mb-4">Portfolio Analysis</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                    <h4 className="text-md font-semibold text-slate-300 mb-4 text-center">Currency Exposure</h4>
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={currencyData}
                          cx="50%"
                          cy="50%"
                          labelLine={false}
                          outerRadius={100}
                          fill="#8884d8"
                          dataKey="value"
                          nameKey="name"
                          label={({ name, percent }) => `${name} ${formatNumber(percent * 100, {maximumFractionDigits: 0})}%`}
                        >
                          {currencyData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: number) => formatCurrency(value, 0, 0)} />
                        <Legend wrapperStyle={{ color: '#94a3b8' }} />
                      </PieChart>
                    </ResponsiveContainer>
                </div>
                 <div>
                    <h4 className="text-md font-semibold text-slate-300 mb-4 text-center">Portfolio vs Benchmark KRDs</h4>
                     <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={krdComparisonData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                          <XAxis dataKey="tenor" tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }}/>
                          <YAxis tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }}/>
                          <Tooltip content={<ChartTooltip />} cursor={{fill: '#334155'}}/>
                          <Legend wrapperStyle={{ color: '#94a3b8' }} />
                          <Bar dataKey="Portfolio" fill="#f97316" />
                          <Bar dataKey="Benchmark" fill="#f43f5e" />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </Card>
      </motion.div>
    </div>
  );
};