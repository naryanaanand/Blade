import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  fullWidth?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  fullWidth = false,
  className = '',
  ...props 
}) => {
  const baseStyles = "px-6 py-3 rounded-xl font-bold transition-all duration-200 transform hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg";
  
  const variants = {
    primary: "bg-gradient-to-r from-orange-500 to-pink-600 text-white hover:from-orange-600 hover:to-pink-700 shadow-orange-500/30",
    secondary: "bg-slate-700 text-white hover:bg-slate-600 border border-slate-600",
    danger: "bg-red-500 text-white hover:bg-red-600 shadow-red-500/30",
  };

  return (
    <button 
      className={`${baseStyles} ${variants[variant]} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};