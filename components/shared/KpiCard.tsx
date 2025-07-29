import React from 'react';
import { Card } from './Card';

interface KpiCardProps {
  title: string;
  value: string;
  change?: string;
  changeColor?: string;
  icon?: React.ReactNode;
  className?: string;
}

export const KpiCard: React.FC<KpiCardProps> = ({ title, value, change, changeColor, icon, className }) => {
  return (
    <Card className={`flex flex-col justify-between ${className}`}>
      <div className="flex justify-between items-start">
        <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">{title}</h3>
        {icon}
      </div>
      <div>
        <p className="text-3xl font-bold text-slate-100 mt-2">{value}</p>
        {change && (
          <p className={`text-sm mt-1 ${changeColor}`}>
            {change}
          </p>
        )}
      </div>
    </Card>
  );
};
