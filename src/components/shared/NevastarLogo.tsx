import React from 'react';

interface LogoProps {
  className?: string;
}

export const NevastarLogo: React.FC<LogoProps> = ({ className }) => (
  <svg 
    className={className}
    viewBox="0 0 200 200" 
    xmlns="http://www.w3.org/2000/svg"
    aria-label="Nevastar Logo"
  >
    <polygon 
        points="100,0 115.3,63.1 156.6,43.4 136.9,84.7 200,100 136.9,115.3 156.6,156.6 115.3,136.9 100,200 84.7,136.9 43.4,156.6 63.1,115.3 0,100 63.1,84.7 43.4,43.4 84.7,63.1"
        fill="currentColor"
        strokeLinejoin="miter"
    />
  </svg>
);