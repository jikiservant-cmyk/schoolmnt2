'use client';

import { useEffect } from 'react';

export default function PwaRegistry() {
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('/sw.js', { scope: '/' })
          .then((registration) => {
            // Check for updates
            registration.onupdatefound = () => {
              const installingWorker = registration.installing;
              if (installingWorker == null) return;
              installingWorker.onstatechange = () => {
                if (installingWorker.state === 'installed') {
                  if (navigator.serviceWorker.controller) {
                    console.log('New PWA content available; please refresh.');
                  } else {
                    console.log('PWA Content is cached for offline use.');
                  }
                }
              };
            };
          })
          .catch((error) => {
            console.warn('PWA Service Worker registration skipped or failed:', error);
          });
      });
    }
  }, []);

  return null;
}
