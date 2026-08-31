import './globals.css';
import PwaRegistry from '@/components/PwaRegistry';
import { Viewport } from 'next';

export const viewport: Viewport = {
  themeColor: '#007aff',
};

export const metadata = {
  title: 'Na\'Jiki Tech - Attendance Portal',
  description: 'An elegant multi-tenant attendance management system powered by Na\'Jiki Tech.',
  manifest: '/manifest.json',
  icons: {
    icon: '/najiki_tech_logo.svg',
    apple: '/najiki_tech_logo.svg',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Na\'Jiki Tech',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased font-sans">
        <PwaRegistry />
        {children}
      </body>
    </html>
  );
}


