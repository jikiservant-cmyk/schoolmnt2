'use client';

import React, { useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Search, Bell, X, CheckCircle2, ChevronDown, User } from 'lucide-react';
import Link from 'next/link';

interface TopbarProps {
  adminName: string;
  initials: string;
  schoolName: string;
}

export default function Topbar({ adminName, initials, schoolName }: TopbarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [userDropdown, setUserDropdown] = useState(false);

  // Derive active title from pathname
  let pageTitle = 'Dashboard';
  if (pathname.includes('/classes')) pageTitle = 'Classes';
  else if (pathname.includes('/people')) pageTitle = 'Students & Teachers';
  else if (pathname.includes('/devices')) pageTitle = 'Hardware Terminals';
  else if (pathname.includes('/attendance')) pageTitle = 'Attendance & SMS Logs';

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 2400);
  };

  // Keyboard shortcut ⌘K / Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearchModal(prev => !prev);
      } else if (e.key === 'Escape') {
        setShowSearchModal(false);
        setUserDropdown(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const searchResults = [
    { title: 'Dashboard Overview', category: 'Navigation', href: '/dashboard' },
    { title: 'Class Registers & Streams', category: 'Classes', href: '/dashboard/classes' },
    { title: 'Student Directory', category: 'People', href: '/dashboard/people?role=student' },
    { title: 'Teacher Faculty & Passcodes', category: 'People', href: '/dashboard/people?role=teacher' },
    { title: 'Attendance Logs & SMS Wallet', category: 'Attendance', href: '/dashboard/attendance' },
    { title: 'ADMS Biometric Devices', category: 'Hardware', href: '/dashboard/devices' },
    { title: 'Kiosk Attendance Terminal', category: 'Kiosk', href: '/mark-attendance' },
  ].filter(item => 
    !searchQuery || 
    item.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    item.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      <header className="h-[70px] border-b border-[#e7e7ea] flex items-center justify-between px-6 sm:px-9 bg-[#f7f7f8]/85 backdrop-blur-[18px] sticky top-0 z-30">
        <div className="text-[13px] font-medium text-[#171719]" id="pageTitle">
          {pageTitle}
        </div>

        <div className="flex items-center gap-[14px]">
          {/* Search Button with ⌘ K */}
          <button
            type="button"
            onClick={() => setShowSearchModal(true)}
            className="hidden sm:flex w-[218px] h-[34px] border border-[#e1e1e5] hover:border-[#cfcfd4] rounded-[9px] bg-white items-center px-[10px] text-[#96969b] text-[11px] transition shadow-2xs cursor-pointer text-left"
          >
            <span>⌕&nbsp;&nbsp; Search</span>
            <kbd className="ml-auto border border-[#e3e3e6] rounded-[4px] px-[4px] py-[1px] text-[8px] text-[#999] font-mono bg-[#fafafa]">
              ⌘ K
            </kbd>
          </button>

          {/* Notification Bell */}
          <button
            type="button"
            onClick={() => showToast('All notifications are up to date.')}
            className="w-[30px] h-[30px] rounded-lg text-[#666] hover:text-[#171719] hover:bg-white border border-transparent hover:border-[#e7e7ea] grid place-items-center transition cursor-pointer text-sm"
            title="Notifications"
          >
            ♧
          </button>

          {/* User Avatar Menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setUserDropdown(!userDropdown)}
              className="flex items-center gap-[8px] p-1 rounded-lg hover:bg-white/80 transition cursor-pointer"
            >
              <div className="w-[30px] h-[30px] rounded-full bg-gradient-to-br from-[#171719] to-[#3a3a3c] text-white grid place-items-center text-[10px] font-semibold tracking-tight shadow-xs">
                {initials}
              </div>
              <div className="text-left hidden sm:block">
                <b className="text-[11px] text-[#171719] font-medium block leading-tight">{adminName}</b>
                <small className="block text-[#929297] text-[9px]">Administrator</small>
              </div>
              <span className="text-[#999] text-[11px] ml-0.5">⌄</span>
            </button>

            {/* Dropdown Menu */}
            {userDropdown && (
              <div className="absolute right-0 mt-2 w-56 bg-white border border-[#e7e7ea] rounded-xl shadow-lg p-2 z-50 text-xs text-[#171719] animate-fade-in">
                <div className="px-3 py-2 border-b border-[#f0f0f2]">
                  <p className="font-semibold text-xs text-[#171719]">{adminName}</p>
                  <p className="text-[10px] text-[#929297] truncate">{schoolName}</p>
                </div>
                <div className="py-1">
                  <Link
                    href="/dashboard/people"
                    onClick={() => setUserDropdown(false)}
                    className="block px-3 py-2 hover:bg-[#f7f7f8] rounded-lg transition"
                  >
                    User Management
                  </Link>
                  <Link
                    href="/dashboard/attendance"
                    onClick={() => setUserDropdown(false)}
                    className="block px-3 py-2 hover:bg-[#f7f7f8] rounded-lg transition"
                  >
                    SMS Wallet & Billing
                  </Link>
                </div>
                <div className="pt-1 border-t border-[#f0f0f2]">
                  <form action="/api/logout" method="POST">
                    <button
                      type="submit"
                      className="w-full text-left px-3 py-2 text-[#ef4444] hover:bg-[#fff0ef] rounded-lg font-medium transition"
                    >
                      Sign Out
                    </button>
                  </form>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Global Search Modal */}
      {showSearchModal && (
        <div className="fixed inset-0 z-50 bg-[#171719]/40 backdrop-blur-xs flex items-start justify-center pt-24 p-4">
          <div className="bg-white border border-[#e7e7ea] rounded-2xl max-w-lg w-full p-4 shadow-2xl space-y-3 animate-fade-in">
            <div className="flex items-center gap-2 px-2 border-b border-[#f0f0f2] pb-3">
              <Search className="w-4 h-4 text-[#929297]" />
              <input
                type="text"
                placeholder="Type a page, student, class, or action..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
                className="w-full text-sm text-[#171719] focus:outline-none placeholder:text-[#929297]"
              />
              <button
                type="button"
                onClick={() => setShowSearchModal(false)}
                className="text-[#929297] hover:text-[#171719] p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="max-h-64 overflow-y-auto space-y-1">
              {searchResults.length > 0 ? (
                searchResults.map((item) => (
                  <button
                    key={item.href + item.title}
                    onClick={() => {
                      setShowSearchModal(false);
                      router.push(item.href);
                    }}
                    className="w-full flex items-center justify-between p-2.5 rounded-lg hover:bg-[#f7f7f8] text-left transition"
                  >
                    <div>
                      <div className="text-xs font-medium text-[#171719]">{item.title}</div>
                      <div className="text-[10px] text-[#929297]">{item.category}</div>
                    </div>
                    <span className="text-xs text-[#929297]">↵</span>
                  </button>
                ))
              ) : (
                <div className="py-6 text-center text-xs text-[#929297]">
                  No matching links found.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating Apple-Style Toast */}
      {toastMessage && (
        <div className="fixed left-1/2 bottom-6 -translate-x-1/2 z-50 bg-[#1d1d1f] text-white px-4 py-2.5 rounded-[10px] text-xs font-medium shadow-2xl flex items-center gap-2 animate-fade-in">
          <CheckCircle2 className="w-3.5 h-3.5 text-[#30b357]" />
          <span>{toastMessage}</span>
        </div>
      )}
    </>
  );
}
