import React from 'react';
import Image from 'next/image';

interface NajikiLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  showText?: boolean;
  subtitle?: string;
  variant?: 'light' | 'dark' | 'auto';
}

export default function NajikiLogo({
  size = 'md',
  className = '',
  showText = false,
  subtitle,
  variant = 'auto',
}: NajikiLogoProps) {
  const sizeMap = {
    sm: { img: 'w-7 h-7', text: 'text-xs', sub: 'text-[9px]' },
    md: { img: 'w-9 h-9', text: 'text-sm', sub: 'text-[10px]' },
    lg: { img: 'w-12 h-12', text: 'text-lg', sub: 'text-xs' },
    xl: { img: 'w-16 h-16', text: 'text-2xl', sub: 'text-sm' },
  };

  const currentSize = sizeMap[size] || sizeMap.md;

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <div 
        className={`relative ${currentSize.img} rounded-xl overflow-hidden shadow-xs shrink-0 bg-[#050508] border border-[#1e1e24] flex items-center justify-center p-0.5`}
      >
        <Image
          src="/najiki_tech_logo.svg"
          alt="Na'Jiki Tech Logo"
          width={64}
          height={45}
          className="w-full h-full object-contain"
          referrerPolicy="no-referrer"
        />
      </div>

      {showText && (
        <div className="flex flex-col">
          <span 
            className={`font-semibold tracking-tight leading-tight ${currentSize.text} ${
              variant === 'light' ? 'text-white' : variant === 'dark' ? 'text-[#171719]' : 'text-current'
            }`}
          >
            Na&apos;Jiki Tech
          </span>
          {subtitle && (
            <span 
              className={`font-mono uppercase tracking-widest ${currentSize.sub} ${
                variant === 'light' ? 'text-white/60' : variant === 'dark' ? 'text-[#929297]' : 'text-neutral-500'
              }`}
            >
              {subtitle}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
