import './globals.css';

export const metadata = {
  title: 'Na\'Jiki Tech - Attendance Portal',
  description: 'An elegant multi-tenant attendance management system powered by Na\'Jiki Tech.',
  manifest: '/manifest.json',
  icons: {
    icon: '/najiki_tech_logo.svg',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased font-sans">
        {children}
      </body>
    </html>
  );
}

