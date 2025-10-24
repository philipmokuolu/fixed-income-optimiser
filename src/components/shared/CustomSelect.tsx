import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Option {
  value: string;
  label: string;
}

interface CustomSelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const ChevronIcon: React.FC<{ open: boolean }> = ({ open }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className={`h-5 w-5 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
  </svg>
);

export const CustomSelect: React.FC<CustomSelectProps> = ({ options, value, onChange, placeholder = 'Select...', className }) => {
  const [isOpen, setIsOpen] = useState(false);
  const selectRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find(opt => opt.value === value);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (selectRef.current && !selectRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div className={`relative ${className}`} ref={selectRef}>
      <button
        type="button"
        className="relative w-full cursor-default rounded-md bg-slate-800 border border-slate-700 py-2 pl-3 pr-10 text-left shadow-sm focus:outline-none focus:ring-2 focus:ring-orange-500 text-sm"
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="block truncate text-slate-200">{selectedOption?.label || placeholder}</span>
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
          <ChevronIcon open={isOpen} />
        </span>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.ul
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-slate-800 border border-slate-700 py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm"
            role="listbox"
          >
            {options.map((option) => (
              <li
                key={option.value}
                className={`relative cursor-default select-none py-2 pl-3 pr-9 text-slate-300 hover:bg-orange-600/50 hover:text-white ${
                  value === option.value ? 'bg-orange-600 text-white' : ''
                }`}
                onClick={() => handleSelect(option.value)}
                role="option"
                aria-selected={value === option.value}
              >
                <span className={`block truncate ${value === option.value ? 'font-semibold' : 'font-normal'}`}>
                  {option.label}
                </span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
};
