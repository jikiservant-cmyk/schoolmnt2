'use client';

import { useState } from 'react';
import { Calendar, ChevronDown, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { formatEATTime, formatEATDate, getEATDateKey, getEATDayRange } from '@/lib/eat-time';

interface LogItem {
  id: string;
  status: string;
  attendance_type?: string;
  occurred_at: string;
  source: string;
  people?: {
    full_name: string;
    role: string;
  } | null;
  classes?: {
    name: string;
  } | null;
}

function formatDateLabel(dateKey: string, sampleDateStr: string): string {
  const todayKey = getEATDateKey(new Date());
  
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterdayKey = getEATDateKey(y);

  const formatted = formatEATDate(sampleDateStr, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  if (dateKey === todayKey) {
    return `Today (${formatted})`;
  } else if (dateKey === yesterdayKey) {
    return `Yesterday (${formatted})`;
  } else {
    return formatted;
  }
}

export default function AttendanceLogsByDate({ logs }: { logs: LogItem[] }) {
  // Group logs by YYYY-MM-DD in EAT
  const groupsMap: Record<string, { label: string; dateKey: string; logs: LogItem[] }> = {};

  logs.forEach((log) => {
    const key = getEATDateKey(log.occurred_at);
    if (!groupsMap[key]) {
      groupsMap[key] = {
        dateKey: key,
        label: formatDateLabel(key, log.occurred_at),
        logs: []
      };
    }
    groupsMap[key].logs.push(log);
  });


  // Sort groups descending by date key
  const sortedKeys = Object.keys(groupsMap).sort((a, b) => b.localeCompare(a));

  const todayKey = getEATDateKey(new Date());

  // Default open groups
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (sortedKeys.length > 0) {
      if (sortedKeys.includes(todayKey)) {
        initial.add(todayKey);
      } else {
        initial.add(sortedKeys[0]);
      }
    }
    return initial;
  });

  const toggleKey = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const expandAll = () => {
    setOpenKeys(new Set(sortedKeys));
  };

  const collapseAll = () => {
    setOpenKeys(new Set());
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 gap-2">
        <div>
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-emerald-700" />
            Attendance Logs Timeline
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Organized timeline of student entry & exit logs
          </p>
        </div>
        
        <div className="flex items-center gap-2">
          {sortedKeys.length > 1 && (
            <div className="flex gap-1 bg-slate-50 border border-slate-200 p-0.5 rounded-lg text-xs">
              <button
                onClick={expandAll}
                className="px-2 py-1 rounded text-slate-600 hover:text-slate-900 font-medium"
              >
                Expand All
              </button>
              <button
                onClick={collapseAll}
                className="px-2 py-1 rounded text-slate-500 hover:text-slate-900 font-medium"
              >
                Collapse All
              </button>
            </div>
          )}
          <Link 
            href="/dashboard/attendance" 
            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline"
          >
            Full Register
            <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {sortedKeys.length === 0 ? (
        <div className="py-10 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg">
          No active attendance logs found. Scans recorded via terminal or manual portal will appear here.
        </div>
      ) : (
        <div className="space-y-3">
          {sortedKeys.map((key) => {
            const group = groupsMap[key];
            const isOpen = openKeys.has(key);
            const isToday = key === todayKey;

            const presentCount = group.logs.filter((l) => l.status === 'present').length;

            return (
              <div 
                key={key}
                className="border border-slate-200 rounded-lg overflow-hidden bg-white"
              >
                {/* Accordion Date Header */}
                <button
                  type="button"
                  onClick={() => toggleKey(key)}
                  className={`w-full flex items-center justify-between p-4 text-left transition-colors cursor-pointer select-none ${
                    isOpen 
                      ? 'bg-slate-50 border-b border-slate-200' 
                      : 'hover:bg-slate-50/50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg border ${
                      isToday 
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
                        : 'bg-slate-100 text-slate-600 border-slate-200'
                    }`}>
                      <Calendar className="w-4 h-4" />
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-slate-900" suppressHydrationWarning>
                          {group.label}
                        </span>
                        {isToday && (
                          <span className="text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded">
                            Today
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {group.logs.length} Log{group.logs.length > 1 ? 's' : ''} &middot; {presentCount} Present
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-xs font-medium text-slate-600 bg-slate-100 px-2.5 py-1 rounded-full border border-slate-200">
                      {group.logs.length} Entries
                    </span>
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4 text-slate-500" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-400" />
                    )}
                  </div>
                </button>

                {/* Log List View */}
                {isOpen && (
                  <div className="p-3 sm:p-4 bg-white border-t border-slate-200">
                    {/* Mobile Card Layout */}
                    <div className="space-y-2 md:hidden">
                      {group.logs.map((log) => {
                        const isPresent = log.status === 'present';
                        const isLate = log.status === 'late';
                        const isCheckOut = log.attendance_type === 'check_out';

                        return (
                          <div 
                            key={log.id} 
                            className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 space-y-2"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <h4 className="text-sm font-semibold text-slate-900">
                                  {log.people?.full_name || 'Unknown Student'}
                                </h4>
                                <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-500">
                                  <span className="capitalize">{log.people?.role || 'student'}</span>
                                  <span>&bull;</span>
                                  <span>{log.classes?.name || 'Form General'}</span>
                                </div>
                              </div>
                              <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-semibold ${
                                isCheckOut
                                  ? 'bg-sky-50 text-sky-700 border border-sky-200'
                                  : isPresent 
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                                    : isLate 
                                      ? 'bg-amber-50 text-amber-700 border border-amber-200' 
                                      : 'bg-rose-50 text-rose-700 border border-rose-200'
                              }`}>
                                {isCheckOut ? 'CHECKED OUT' : log.status.toUpperCase()}
                              </span>
                            </div>

                            <div className="flex items-center justify-between pt-2 border-t border-slate-200 text-xs text-slate-500">
                              <span className="px-2 py-0.5 rounded text-[11px] bg-slate-100 border border-slate-200 font-medium">
                                {log.source === 'device' ? 'Biometric' : 'Manual'}
                              </span>
                              <span suppressHydrationWarning>
                                {formatEATTime(log.occurred_at, {
                                  hour: 'numeric',
                                  minute: '2-digit',
                                  second: '2-digit',
                                  hour12: true
                                })}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Desktop Table Layout */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                            <th className="text-left pb-2.5">Name</th>
                            <th className="text-left pb-2.5">Role</th>
                            <th className="text-left pb-2.5">Class Stream</th>
                            <th className="text-center pb-2.5">Source</th>
                            <th className="text-right pb-2.5">Time</th>
                            <th className="text-right pb-2.5">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-sm">
                          {group.logs.map((log) => {
                            const isPresent = log.status === 'present';
                            const isLate = log.status === 'late';
                            const isCheckOut = log.attendance_type === 'check_out';

                            return (
                              <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                                <td className="py-3 font-semibold text-slate-900">
                                  {log.people?.full_name || 'Unknown Student'}
                                </td>
                                <td className="py-3 text-xs text-slate-500 capitalize">
                                  {log.people?.role || 'student'}
                                </td>
                                <td className="py-3 text-slate-600">
                                  {log.classes?.name || 'Form General'}
                                </td>
                                <td className="py-3 text-center">
                                  <span className="inline-block px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-700 border border-slate-200 font-medium">
                                    {log.source === 'device' ? 'Biometric' : 'Manual'}
                                  </span>
                                </td>
                                <td className="py-3 text-right text-xs text-slate-500 font-medium" suppressHydrationWarning>
                                  {formatEATTime(log.occurred_at, {
                                    hour: 'numeric',
                                    minute: '2-digit',
                                    second: '2-digit',
                                    hour12: true
                                  })}
                                </td>
                                <td className="py-3 text-right">
                                  <span className={`inline-block px-2.5 py-0.5 rounded text-xs font-semibold ${
                                    isCheckOut
                                      ? 'bg-sky-50 text-sky-700 border border-sky-200'
                                      : isPresent 
                                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                                        : isLate 
                                          ? 'bg-amber-50 text-amber-700 border border-amber-200' 
                                          : 'bg-rose-50 text-rose-700 border border-rose-200'
                                  }`}>
                                    {isCheckOut ? 'CHECKED OUT' : log.status.toUpperCase()}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
