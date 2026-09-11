import './globals.css';
import PwaClientComponents from '@/components/PwaClientComponents';
import { Viewport, Metadata } from 'next';

export const viewport: Viewport = {
  themeColor: '#007aff',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export const metadata: Metadata = {
  title: 'SmartSkoolz Attendance Portal',
  description: 'Multi-tenant school attendance management system with Supabase Postgres and ZKTeco integration.',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/app-icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512x512.png', sizes: '512x512', type: 'image/png' }
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
    ],
    shortcut: ['/favicon.png'],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'SmartSkoolz',
  },
  applicationName: 'SmartSkoolz',
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="antialiased font-sans">
        <PwaClientComponents />
        {children}
      </body>
    </html>
  );
}
