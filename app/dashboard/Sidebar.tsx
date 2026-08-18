'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { 
  Menu, 
  X, 
  LogOut,
  Sparkles,
  ExternalLink
} from 'lucide-react';
import NajikiLogo from '@/components/NajikiLogo';

interface SidebarProps {
  schoolName: string;
  adminName: string;
  initials: string;
}

export default function Sidebar({ schoolName, adminName, initials }: SidebarProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const pathname = usePathname();

  const navItems = [
    { href: '/dashboard', label: 'Dashboard', symbol: '⌂', matchExact: true },
    { href: '/dashboard/people?role=student', label: 'Students', symbol: '♙' },
    { href: '/dashboard/people?role=teacher', label: 'Teachers', symbol: '♧' },
    { href: '/dashboard/classes', label: 'Classes', symbol: '▣' },
    { href: '/dashboard/attendance', label: 'Attendance', symbol: '✓' },
    { href: '/dashboard/devices', label: 'Devices', symbol: '▤' },
    { href: '/mark-attendance', label: 'Kiosk Terminal', symbol: '⇲', external: true },
  ];

  const handleLinkClick = () => {
    setIsMobileOpen(false);
  };

  return (
    <>
      {/* Mobile Top Header */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-16 bg-[#f7f7f8]/95 backdrop-blur-md border-b border-[#e7e7ea] flex items-center justify-between px-4 z-40">
        <div className="flex items-center gap-2.5">
          <NajikiLogo size="md" />
          <div>
            <div className="font-semibold text-sm text-[#171719] tracking-tight">
              Na&apos;Jiki Tech
            </div>
            <div className="text-[10px] text-[#929297] truncate max-w-[150px]">
              {schoolName}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link 
            href="/mark-attendance" 
            className="flex items-center gap-1 px-2.5 py-1.5 bg-[#edf5ff] text-[#007aff] border border-[#d6e7ff] rounded-lg text-xs font-medium"
          >
            <span>Kiosk</span>
          </Link>
          <button 
            onClick={() => setIsMobileOpen(!isMobileOpen)}
            className="p-2 bg-white hover:bg-[#ececf1] border border-[#e7e7ea] rounded-lg text-[#171719] transition"
            aria-label="Toggle menu"
          >
            {isMobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {/* Mobile Backdrop Overlay */}
      {isMobileOpen && (
        <div 
          className="md:hidden fixed inset-0 bg-[#171719]/30 backdrop-blur-xs z-40 transition-opacity duration-200"
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      {/* Sidebar Aside (Fixed on Desktop, Slide-over on Mobile) */}
      <aside 
        className={`fixed inset-y-0 left-0 z-50 w-[238px] bg-[rgba(250,250,251,0.96)] md:bg-[rgba(250,250,251,0.92)] border-r border-[#e7e7ea] p-[25px_14px_18px] flex flex-col justify-between transition-transform duration-200 ease-in-out ${
          isMobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div>
          {/* Brand Header */}
          <div className="flex items-center gap-[11px] p-[4px_10px_26px]">
            <NajikiLogo size="md" />
            <div>
              <b className="text-[14px] text-[#171719] tracking-tight block">Na&apos;Jiki Tech</b>
              <small className="block text-[#929297] text-[10px] mt-[1px]">Attendance System</small>
            </div>
          </div>

          {/* Navigation Section */}
          <div className="text-[9px] uppercase tracking-[0.12em] text-[#a0a0a5] px-[12px] pb-[7px] font-semibold">
            Manage
          </div>
          
          <nav className="grid gap-[2px]">
            {navItems.map((item) => {
              const isActive = item.matchExact 
                ? pathname === item.href 
                : pathname.startsWith(item.href.split('?')[0]);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={handleLinkClick}
                  target={item.external ? '_blank' : undefined}
                  className={`h-[39px] w-full flex items-center gap-[11px] px-[11px] rounded-[9px] text-[12px] text-left transition-all duration-150 ${
                    isActive 
                      ? 'bg-[#ececf1] text-[#151515] font-medium shadow-2xs' 
                      : 'text-[#5e5e63] hover:bg-[#ececf1] hover:text-[#151515]'
                  }`}
                >
                  <span className="w-[18px] text-center text-[#777] text-[14px]">
                    {item.symbol}
                  </span>
                  <span className="flex-1">{item.label}</span>
                  {item.external && (
                    <ExternalLink className="w-3 h-3 text-[#929297]" />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Bottom */}
        <div className="mt-auto space-y-3">
          {/* Na'Jiki Pro Card */}
          <div className="border border-[#e4e4e7] bg-white rounded-[14px] p-[15px] mx-[4px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <div className="flex justify-between items-center">
              <span className="text-[16px] text-[#f5a30a]">✦</span>
              <span className="text-[9px] font-semibold tracking-wider text-[#a0a0a5]">NA&apos;JIKI+</span>
            </div>
            <b className="block text-[12px] text-[#171719] mt-[8px]">Go Premium</b>
            <p className="text-[#89898e] text-[10px] leading-[1.45] my-[6px]">
              Unlock advanced reports, parent messaging and ADMS sync.
            </p>
            <Link
              href="/dashboard/attendance"
              className="w-full h-[30px] border border-[#dedee2] hover:bg-[#f7f7f8] rounded-[8px] text-[#007aff] text-[10px] font-medium flex items-center justify-center transition"
            >
              Manage Wallet
            </Link>
          </div>

          {/* User Signout & Copyright */}
          <div className="px-[12px] pt-1 flex items-center justify-between">
            <div className="text-[9px] text-[#a3a3a7]">
              © 2026 Na&apos;Jiki Tech
            </div>
            <form action="/api/logout" method="POST">
              <button 
                type="submit" 
                className="text-[10px] text-[#e2463d] hover:underline flex items-center gap-1 font-medium"
              >
                <LogOut className="w-3 h-3" />
                <span>Sign Out</span>
              </button>
            </form>
          </div>
        </div>
      </aside>
    </>
  );
}
