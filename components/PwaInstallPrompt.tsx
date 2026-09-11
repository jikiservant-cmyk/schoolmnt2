'use client';

import React, { useState, useEffect } from 'react';
import { Download, X, Smartphone, Check } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export default function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [installedSuccessfully, setInstalledSuccessfully] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const standaloneMode = 
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    
    if (standaloneMode) return;

    const hasDismissed = Boolean(sessionStorage.getItem('smartskoolz_pwa_prompt_dismissed'));
    if (hasDismissed) {
      return;
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setIsInstallable(true);
    };

    const handleAppInstalled = () => {
      setIsInstallable(false);
      setInstalledSuccessfully(true);
      setTimeout(() => {
        setInstalledSuccessfully(false);
      }, 4000);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const choiceResult = await deferredPrompt.userChoice;

    if (choiceResult.outcome === 'accepted') {
      setIsInstallable(false);
      setInstalledSuccessfully(true);
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem('smartskoolz_pwa_prompt_dismissed', 'true');
  };

  if (dismissed || !isInstallable) return null;

  return (
    <>
      {/* Toast Install Prompt Banner */}
      {isInstallable && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm w-full animate-bounce-short">
          <div className="bg-[#171719] text-white p-3.5 rounded-[14px] shadow-2xl border border-white/10 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-[10px] bg-[#007aff] text-white grid place-items-center shrink-0 shadow-sm">
                <Smartphone className="w-5 h-5" />
              </div>
              <div>
                <div className="text-xs font-semibold text-white">Install SmartSkoolz App</div>
                <div className="text-[10.5px] text-white/70">Launch directly from your home screen</div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleInstallClick}
                className="px-3 py-1.5 bg-[#007aff] hover:bg-[#0062cc] text-white text-xs font-semibold rounded-[8px] flex items-center gap-1 transition shadow-xs cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Install</span>
              </button>
              <button
                type="button"
                onClick={handleDismiss}
                className="w-7 h-7 rounded-[7px] text-white/60 hover:text-white hover:bg-white/10 grid place-items-center transition cursor-pointer"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {installedSuccessfully && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm w-full animate-fade-in">
          <div className="bg-[#171719] text-white p-3.5 rounded-[14px] shadow-2xl border border-[#30b357]/30 flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#30b357] text-white grid place-items-center shrink-0">
              <Check className="w-4 h-4" />
            </div>
            <div className="text-xs font-medium">SmartSkoolz PWA installed successfully!</div>
          </div>
        </div>
      )}
    </>
  );
}
