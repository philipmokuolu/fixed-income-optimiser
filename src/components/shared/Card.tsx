import React from 'react';
import { motion, MotionProps } from 'framer-motion';

interface CardProps extends MotionProps {
  children: React.ReactNode;
  className?: string;
}

export const Card: React.FC<CardProps> = ({ children, className = '', ...rest }) => {
  return (
    <motion.div className={`bg-slate-900 rounded-lg shadow-lg p-4 sm:p-6 ${className}`} {...rest}>
      {children}
    </motion.div>
  );
};