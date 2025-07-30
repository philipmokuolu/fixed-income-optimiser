import React, { useState, useMemo } from 'react';
import { Portfolio, Bond, KrdKey } from '@/types';
import { KRD_TENORS } from '@/constants';
import { Card } from '@/components/shared/Card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatNumber, formatCurrencyM } from '@/utils/formatting';

interface PortfolioDetailProps {
  portfolio: Portfolio;
}

type SortKey = keyof Omit<Bond, 'krd_1y' | 'krd_2y' | 'krd_3y' | 'krd_5y' | 'krd_7y' | 'krd_10y'>;
type SortDirection = 'asc' | 'desc';


const SortableHeader: React.FC<{
  label: string;
  sortKey: SortKey;
  currentSortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
  className?: string;
}> = ({ label, sortKey, currentSortKey, sortDirection, onSort, className='' }) => {
  const isActive = sortKey === currentSortKey;
  return (
    <th
      scope="col"
      className={`px-3 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider cursor-pointer hover:bg-slate-800 ${className}`}
      onClick={() => onSort(sortKey)}
    >
      <div className="flex items-center">
        <span>{label}</span>
        {isActive && (
          <span className="ml-1">{sortDirection === 'asc' ? '▲' : '▼'}</span>
        )}
      </div>
    </th>
  );
};

const ChartTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-slate-800 p-2 border border-slate-700 rounded-md shadow-lg">
        <p className="label text-slate-200">{`${label}`}</p>
        {payload.map((pld: any, index: number) => (
          <p key={index} style={{ color: pld.color }} className="text-sm">
            {`${pld.name}: ${formatNumber(pld.value, { minimumFractionDigits: 2, maximumFractionDigits: 2})}`}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export const PortfolioDetail: React.FC<PortfolioDetailProps> = ({ portfolio }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('marketValue');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('desc');
    }
  };

  const sortedAndFilteredBonds = useMemo(() => {
    let bonds = [...portfolio.bonds];
    if (searchTerm) {
      bonds = bonds.filter(bond =>
        bond.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        bond.isin.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    
    bonds.sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return 0;
    });
    return bonds;
  }, [portfolio.bonds, searchTerm, sortKey, sortDirection]);

  const durationContributionData = useMemo(() => {
      return portfolio.bonds.map(bond => ({
          name: bond.name,
          contribution: bond.durationContribution,
      })).sort((a,b) => b.contribution - a.contribution).slice(0,10); // Top 10 contributors
  }, [portfolio]);

  const krdExposureData = useMemo(() => {
    const weight = (b: Bond) => b.marketValue / portfolio.totalMarketValue;
    return KRD_TENORS.map(t => {
      const krdKey: KrdKey = `krd_${t}`;
      return {
        tenor: t,
        USD: portfolio.bonds.filter(b => b.currency === 'USD').reduce((sum, b) => sum + b[krdKey] * weight(b), 0),
        EUR: portfolio.bonds.filter(b => b.currency === 'EUR').reduce((sum, b) => sum + b[krdKey] * weight(b), 0),
        GBP: portfolio.bonds.filter(b => b.currency === 'GBP').reduce((sum, b) => sum + b[krdKey] * weight(b), 0),
      }
    })
  }, [portfolio]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <h1 className="text-2xl font-bold text-white">Portfolio Deep Dive</h1>
      
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <Card>
              <h3 className="text-lg font-semibold text-slate-200 mb-4">Duration Contribution by Holding</h3>
              <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={durationContributionData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis type="number" tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }}/>
                      <YAxis type="category" dataKey="name" width={150} tick={{ fill: '#94a3b8', fontSize: 12 }} tickLine={false} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: '#334155' }} />
                      <Bar dataKey="contribution" name="Duration Contribution (yrs)" fill="#6366f1" />
                  </BarChart>
              </ResponsiveContainer>
          </Card>
           <Card>
              <h3 className="text-lg font-semibold text-slate-200 mb-4">KRD Exposure by Currency</h3>
              <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={krdExposureData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="tenor" tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }}/>
                      <YAxis tick={{ fill: '#94a3b8' }} tickLine={{ stroke: '#94a3b8' }} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: '#334155' }} />
                      <Legend wrapperStyle={{ color: '#94a3b8' }} />
                      <Bar dataKey="USD" stackId="a" fill="#f97316" />
                      <Bar dataKey="EUR" stackId="a" fill="#6366f1" />
                      <Bar dataKey="GBP" stackId="a" fill="#14b8a6" />
                  </BarChart>
              </ResponsiveContainer>
          </Card>
      </div>

      <Card>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-slate-200">Portfolio Holdings</h3>
          <input
            type="text"
            placeholder="Search by name or ISIN..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-800">
            <thead className="bg-slate-900 sticky top-0">
              <tr>
                <SortableHeader label="ISIN" sortKey="isin" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader label="Bond Name" sortKey="name" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader label="Notional" sortKey="notional" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} className="text-right" />
                <SortableHeader label="M.Val" sortKey="marketValue" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} className="text-right" />
                <SortableHeader label="Ccy" sortKey="currency" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} className="text-center"/>
                <SortableHeader label="Maturity" sortKey="maturityDate" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader label="Cpn" sortKey="coupon" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} className="text-right" />
                <SortableHeader label="YTM" sortKey="yieldToMaturity" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} className="text-right" />
                <SortableHeader label="Mod.Dur" sortKey="modifiedDuration" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} className="text-right" />
                <SortableHeader label="Dur. Cont." sortKey="durationContribution" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} className="text-right" />
                <SortableHeader label="Rating" sortKey="creditRating" currentSortKey={sortKey} sortDirection={sortDirection} onSort={handleSort} className="text-center"/>
                {KRD_TENORS.map(tenor => <th key={tenor} className="px-3 py-3 text-right text-xs font-medium text-slate-300 uppercase tracking-wider">{tenor}</th>)}
              </tr>
            </thead>
            <tbody className="bg-slate-900 divide-y divide-slate-800">
              {sortedAndFilteredBonds.map(bond => (
                <tr key={bond.isin} className="hover:bg-slate-800/50">
                  <td className="px-3 py-3 text-sm font-mono text-orange-400 whitespace-nowrap">{bond.isin}</td>
                  <td className="px-3 py-3 text-sm text-slate-200 whitespace-nowrap max-w-xs truncate">{bond.name}</td>
                  <td className="px-3 py-3 text-sm text-right whitespace-nowrap font-mono">{formatNumber(bond.notional)}</td>
                  <td className="px-3 py-3 text-sm text-right whitespace-nowrap font-mono">{formatCurrencyM(bond.marketValue)}</td>
                  <td className="px-3 py-3 text-sm text-center">{bond.currency}</td>
                  <td className="px-3 py-3 text-sm whitespace-nowrap">{bond.maturityDate}</td>
                  <td className="px-3 py-3 text-sm text-right font-mono">{formatNumber(bond.coupon, {minimumFractionDigits: 2})}%</td>
                  <td className="px-3 py-3 text-sm text-right font-mono">{formatNumber(bond.yieldToMaturity, {minimumFractionDigits: 2})}%</td>
                  <td className="px-3 py-3 text-sm text-right font-mono">{formatNumber(bond.modifiedDuration, {minimumFractionDigits: 2})}</td>
                  <td className="px-3 py-3 text-sm text-right font-mono">{formatNumber(bond.durationContribution, {minimumFractionDigits: 3})}</td>
                  <td className="px-3 py-3 text-sm text-center">{bond.creditRating}</td>
                   {KRD_TENORS.map(tenor => <td key={tenor} className="px-3 py-3 text-sm text-right font-mono">{formatNumber(bond[`krd_${tenor}`], {minimumFractionDigits: 3})}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};
