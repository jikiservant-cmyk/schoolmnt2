'use client';

import dynamic from 'next/dynamic';

const SplashScreen = dynamic(() => import('@/components/SplashScreen'), {
  ssr: false,
});

const PwaInstallPrompt = dynamic(() => import('@/components/PwaInstallPrompt'), {
  ssr: false,
});

const PwaRegistry = dynamic(() => import('@/components/PwaRegistry'), {
  ssr: false,
});

export default function PwaClientComponents() {
  return (
    <>
      <SplashScreen />
      <PwaRegistry />
      <PwaInstallPrompt />
    </>
  );
}
