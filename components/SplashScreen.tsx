'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Image from 'next/image';

export default function SplashScreen() {
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof window === 'undefined') return false;
    const hasSeenSplashInSession = sessionStorage.getItem('smartskoolz_splash_shown');
    const isStandalone = 
      window.matchMedia('(display-mode: standalone)').matches || 
      (window.navigator as any).standalone === true;
    
    return !hasSeenSplashInSession || isStandalone;
  });

  const [statusText, setStatusText] = useState('Initializing Terminal...');
  const [progress, setProgress] = useState(15);

  useEffect(() => {
    if (!isVisible) return;

    const t1 = setTimeout(() => {
      setStatusText('Syncing Biometrics & Terminal Cache...');
      setProgress(55);
    }, 350);

    const t2 = setTimeout(() => {
      setStatusText('Connecting Secure Gateway...');
      setProgress(90);
    }, 750);

    const t3 = setTimeout(() => {
      setStatusText('System Ready');
      setProgress(100);
    }, 1100);

    const t4 = setTimeout(() => {
      setIsVisible(false);
      sessionStorage.setItem('smartskoolz_splash_shown', 'true');
    }, 1450);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [isVisible]);

  const handleDismiss = () => {
    setIsVisible(false);
    sessionStorage.setItem('smartskoolz_splash_shown', 'true');
  };

  if (!isVisible) {
    return null;
  }

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          id="pwa-splash-screen"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 1.02, filter: 'blur(8px)' }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          onClick={handleDismiss}
          className="fixed inset-0 z-9999 flex flex-col items-center justify-between bg-[#080a0f] text-white p-8 select-none cursor-pointer overflow-hidden"
        >
          {/* Ambient Background Glow Orbs */}
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full bg-[#007aff]/15 blur-[90px] pointer-events-none" />
          <div className="absolute bottom-1/4 left-1/2 -translate-x-1/2 w-64 h-64 rounded-full bg-[#00c6ff]/10 blur-[80px] pointer-events-none" />

          {/* Top subtle badge */}
          <div className="pt-4 flex items-center gap-1.5 opacity-60">
            <span className="w-1.5 h-1.5 rounded-full bg-[#30b357] animate-pulse" />
            <span className="text-[11px] font-mono tracking-widest uppercase text-slate-400">
              PWA STANDALONE ACTIVE
            </span>
          </div>

          {/* Center Brand & Glowing Icon */}
          <div className="flex flex-col items-center text-center my-auto">
            <motion.div
              initial={{ scale: 0.85, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="relative mb-6"
            >
              {/* Pulsing Ripple Rings */}
              <div className="absolute inset-0 -m-3 rounded-[32px] border border-[#007aff]/30 animate-ping opacity-25" />
              <div className="absolute inset-0 -m-6 rounded-[40px] border border-[#00c6ff]/20 animate-pulse opacity-20" />

              {/* High-res App Logo */}
              <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-[28px] bg-gradient-to-br from-[#131b2a] via-[#0d131f] to-[#070a0f] p-0.5 shadow-[0_12px_35px_rgba(0,122,255,0.25)] border border-[#233554]/60 grid place-items-center overflow-hidden">
                <Image
                  src="/app-icon.svg"
                  alt="SmartSkoolz Logo"
                  width={112}
                  height={112}
                  className="w-full h-full object-cover"
                  priority
                  referrerPolicy="no-referrer"
                />
              </div>
            </motion.div>

            {/* Brand Titles */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.45 }}
            >
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white flex items-center justify-center gap-1.5">
                <span>SmartSkoolz</span>
                <span className="text-[#00c6ff] font-extralight text-xl">·</span>
                <span className="text-xs font-semibold uppercase tracking-widest text-[#007aff] bg-[#007aff]/15 px-2 py-0.5 rounded-full border border-[#007aff]/30">
                  Portal
                </span>
              </h1>
              <p className="text-xs text-slate-400 mt-1 font-medium tracking-wide">
                Biometric School Attendance System
              </p>
            </motion.div>
          </div>

          {/* Bottom Progress Bar & Loading State */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.45 }}
            className="w-full max-w-xs flex flex-col items-center gap-3 pb-6"
          >
            {/* Progress Track */}
            <div className="w-full h-1.5 bg-slate-800/80 rounded-full overflow-hidden p-0.5 border border-slate-700/50">
              <motion.div
                className="h-full bg-gradient-to-r from-[#007aff] via-[#00c6ff] to-[#30b357] rounded-full shadow-[0_0_12px_#007aff]"
                initial={{ width: '0%' }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.35, ease: 'easeInOut' }}
              />
            </div>

            {/* Status Text */}
            <div className="flex items-center justify-between w-full px-1 text-[11px] text-slate-400">
              <span className="font-mono">{statusText}</span>
              <span className="font-mono text-slate-500">{progress}%</span>
            </div>

            <div className="text-[10px] text-slate-500/80 pt-1">
              Tap anywhere to skip
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
