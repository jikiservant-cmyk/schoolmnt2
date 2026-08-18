'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { 
  ChevronRight, 
  ExternalLink, 
  RefreshCw, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Smartphone,
  Send,
  MoreHorizontal,
  GraduationCap,
  Briefcase,
  Users,
  FileText
} from 'lucide-react';

interface DashboardInteractiveProps {
  initialLogs: any[];
  studentCount: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  presentPct: number;
  latePct: number;
  absentPct: number;
  teacherCount?: number;
  teacherPresentCount?: number;
  teacherLateCount?: number;
  teacherAbsentCount?: number;
  teacherPresentPct?: number;
  teacherLatePct?: number;
  teacherAbsentPct?: number;
  devicesList: any[];
  recentMessages: any[];
  greeting: string;
  adminName: string;
  formattedDate: string;
}

export default function DashboardClient({
  initialLogs,
  studentCount,
  presentCount,
  lateCount,
  absentCount,
  presentPct,
  latePct,
  absentPct,
  teacherCount = 42,
  teacherPresentCount = 37,
  teacherLateCount = 3,
  teacherAbsentCount = 2,
  teacherPresentPct = 88.0,
  teacherLatePct = 7.0,
  teacherAbsentPct = 5.0,
  devicesList,
  recentMessages,
  greeting,
  adminName,
  formattedDate
}: DashboardInteractiveProps) {
  const [chartRange, setChartRange] = useState<'week' | 'month'>('week');
  const [dashboardRoleScope, setDashboardRoleScope] = useState<'students' | 'teachers'>('students');
  const [logFilter, setLogFilter] = useState<'all' | 'students' | 'teachers'>('all');

  // Filter logs for the recent check-ins table
  const displayedLogs = useMemo(() => {
    if (logFilter === 'all') return initialLogs;
    if (logFilter === 'students') return initialLogs.filter(l => (l.people?.role || 'student') === 'student');
    return initialLogs.filter(l => l.people?.role === 'teacher' || l.people?.role === 'admin');
  }, [initialLogs, logFilter]);

  // Current scope metrics
  const activeCount = dashboardRoleScope === 'students' ? studentCount : teacherCount;
  const activePresent = dashboardRoleScope === 'students' ? presentCount : teacherPresentCount;
  const activeLate = dashboardRoleScope === 'students' ? lateCount : teacherLateCount;
  const activeAbsent = dashboardRoleScope === 'students' ? absentCount : teacherAbsentCount;
  const activePresentPct = dashboardRoleScope === 'students' ? presentPct : teacherPresentPct;
  const activeLatePct = dashboardRoleScope === 'students' ? latePct : teacherLatePct;
  const activeAbsentPct = dashboardRoleScope === 'students' ? absentPct : teacherAbsentPct;

  return (
    <div className="space-y-6 pt-5 animate-fade-in">
      
      {/* Hero Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-2">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-[#929297] mb-1">
            {formattedDate}
          </div>
          <h1 className="text-[22px] sm:text-[25px] font-bold tracking-tight text-[#171719] leading-tight">
            {greeting}, {adminName}.
          </h1>
          <p className="text-[12px] text-[#85858a] mt-0.5">
            A quiet overview of how your school and faculty are doing today.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Role Switcher Pill */}
          <div className="flex items-center gap-1 bg-[#f5f5f7] p-1 rounded-[10px] border border-[#e7e7ea] text-xs">
            <button
              type="button"
              onClick={() => setDashboardRoleScope('students')}
              className={`px-3 py-1.5 rounded-[7px] text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                dashboardRoleScope === 'students'
                  ? 'bg-white text-[#171719] shadow-2xs font-semibold'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <GraduationCap className="w-3.5 h-3.5 text-[#007aff]" />
              <span>Students</span>
            </button>
            <button
              type="button"
              onClick={() => setDashboardRoleScope('teachers')}
              className={`px-3 py-1.5 rounded-[7px] text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                dashboardRoleScope === 'teachers'
                  ? 'bg-white text-[#171719] shadow-2xs font-semibold'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <Briefcase className="w-3.5 h-3.5 text-[#30b357]" />
              <span>Faculty / Teachers</span>
            </button>
          </div>

          <Link
            href="/dashboard/attendance"
            className="h-[34px] px-3 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-[9px] text-[11px] font-medium flex items-center gap-1.5 shadow-2xs transition"
          >
            <FileText className="w-3.5 h-3.5 text-white" />
            <span>Attendance Reports</span>
          </Link>

          <Link
            href="/mark-attendance"
            target="_blank"
            className="h-[34px] px-3.5 bg-[#171719] hover:bg-[#2c2c2e] text-white rounded-[9px] text-[11px] font-medium flex items-center gap-1.5 shadow-2xs transition"
          >
            <span>Kiosk Terminal</span>
            <ExternalLink className="w-3 h-3 opacity-70" />
          </Link>
        </div>
      </div>

      {/* 4 Stat Cards (Responsive to Students vs Teachers Scope) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[14px]">
        
        {/* Total Roster */}
        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[16px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#85858a] font-medium">
              {dashboardRoleScope === 'students' ? 'Total Students' : 'Total Faculty Members'}
            </span>
            <span className="w-7 h-7 rounded-[8px] bg-[#edf5ff] text-[#007aff] grid place-items-center text-xs font-semibold">
              {dashboardRoleScope === 'students' ? '♙' : '♖'}
            </span>
          </div>
          <div className="mt-3">
            <b className="text-[26px] font-bold tracking-tight text-[#171719] leading-none block">
              {activeCount.toLocaleString()}
            </b>
            <div className="text-[10px] text-[#85858a] mt-1.5 flex items-center gap-1">
              <span className="text-[#30b357] font-semibold">↑ Active</span>
              <span>{dashboardRoleScope === 'students' ? 'across all class streams' : 'school teaching staff'}</span>
            </div>
          </div>
        </div>

        {/* Present Today */}
        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[16px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#85858a] font-medium">
              {dashboardRoleScope === 'students' ? 'Students Present' : 'Faculty Present'}
            </span>
            <span className="w-7 h-7 rounded-[8px] bg-[#edf9f0] text-[#30b357] grid place-items-center text-xs font-semibold">
              ✓
            </span>
          </div>
          <div className="mt-3">
            <b className="text-[26px] font-bold tracking-tight text-[#2da94f] leading-none block">
              {activePresent.toLocaleString()}
            </b>
            <div className="text-[10px] text-[#85858a] mt-1.5">
              <strong className="text-[#171719] font-medium">{activePresentPct}%</strong> on-time arrival rate
            </div>
          </div>
        </div>

        {/* Late Today */}
        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[16px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#85858a] font-medium">
              {dashboardRoleScope === 'students' ? 'Late Students' : 'Late Faculty'}
            </span>
            <span className="w-7 h-7 rounded-[8px] bg-[#fff5e7] text-[#f5a30a] grid place-items-center text-xs font-semibold">
              ◷
            </span>
          </div>
          <div className="mt-3">
            <b className="text-[26px] font-bold tracking-tight text-[#f5a30a] leading-none block">
              {activeLate.toLocaleString()}
            </b>
            <div className="text-[10px] text-[#85858a] mt-1.5">
              <strong className="text-[#f5a30a] font-medium">{activeLatePct}%</strong> arrived beyond 8:00 AM
            </div>
          </div>
        </div>

        {/* Absent Today */}
        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[16px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#85858a] font-medium">
              {dashboardRoleScope === 'students' ? 'Absent Students' : 'Absent / Pending'}
            </span>
            <span className="w-7 h-7 rounded-[8px] bg-[#fff0ef] text-[#ef4444] grid place-items-center text-xs font-semibold">
              ×
            </span>
          </div>
          <div className="mt-3">
            <b className="text-[26px] font-bold tracking-tight text-[#171719] leading-none block">
              {activeAbsent.toLocaleString()}
            </b>
            <div className="text-[10px] text-[#85858a] mt-1.5">
              <strong className="text-[#ef4444] font-medium">{activeAbsentPct}%</strong> pending clock-in
            </div>
          </div>
        </div>

      </div>

      {/* Main 2-Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-[18px]">
        
        {/* Left Column */}
        <div className="lg:col-span-8 space-y-[18px]">
          
          {/* Attendance Overview Card with SVG Chart */}
          <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[18px_20px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <div className="flex items-center justify-between pb-3">
              <div>
                <b className="text-[12px] font-semibold text-[#171719] block">
                  {dashboardRoleScope === 'students' ? 'Student Attendance Trends' : 'Faculty Attendance Trends'}
                </b>
                <small className="text-[10px] text-[#929297]">
                  Daily attendance rate across the entire institution
                </small>
              </div>

              <div className="flex items-center gap-1.5 bg-[#f5f5f7] p-0.5 rounded-[8px] border border-[#e7e7ea] text-[10px]">
                <button
                  type="button"
                  onClick={() => setChartRange('week')}
                  className={`px-2.5 py-1 rounded-[6px] transition font-medium cursor-pointer ${
                    chartRange === 'week' ? 'bg-white text-[#171719] shadow-2xs' : 'text-[#85858a] hover:text-[#171719]'
                  }`}
                >
                  This week
                </button>
                <button
                  type="button"
                  onClick={() => setChartRange('month')}
                  className={`px-2.5 py-1 rounded-[6px] transition font-medium cursor-pointer ${
                    chartRange === 'month' ? 'bg-white text-[#171719] shadow-2xs' : 'text-[#85858a] hover:text-[#171719]'
                  }`}
                >
                  Month
                </button>
              </div>
            </div>

            {/* SVG Interactive Chart */}
            <div className="pt-2">
              <div className="relative h-[210px] w-full">
                <svg className="w-full h-full" viewBox="0 0 500 200" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="appleAreaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#007aff" stopOpacity="0.14" />
                      <stop offset="100%" stopColor="#007aff" stopOpacity="0.00" />
                    </linearGradient>
                  </defs>

                  {/* Grid Lines & Labels */}
                  <line x1="40" y1="20" x2="490" y2="20" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="23" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">100%</text>

                  <line x1="40" y1="65" x2="490" y2="65" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="68" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">75%</text>

                  <line x1="40" y1="110" x2="490" y2="110" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="113" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">50%</text>

                  <line x1="40" y1="155" x2="490" y2="155" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="158" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">25%</text>

                  <line x1="40" y1="190" x2="490" y2="190" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="190" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">0%</text>

                  {/* Area Gradient Fill */}
                  <path
                    d="M 50 50 C 120 40, 180 100, 250 35 C 320 50, 390 60, 470 30 L 470 190 L 50 190 Z"
                    fill="url(#appleAreaGrad)"
                  />

                  {/* Line Stroke */}
                  <path
                    d="M 50 50 C 120 40, 180 100, 250 35 C 320 50, 390 60, 470 30"
                    fill="none"
                    stroke="#007aff"
                    strokeWidth="2.3"
                    strokeLinecap="round"
                  />

                  {/* Point circles */}
                  <circle cx="50" cy="50" r="3.5" fill="#ffffff" stroke="#007aff" strokeWidth="2" />
                  <circle cx="150" cy="80" r="3.5" fill="#ffffff" stroke="#007aff" strokeWidth="2" />
                  <circle cx="250" cy="35" r="3.5" fill="#ffffff" stroke="#007aff" strokeWidth="2" />
                  <circle cx="360" cy="55" r="3.5" fill="#ffffff" stroke="#007aff" strokeWidth="2" />
                  <circle cx="470" cy="30" r="4.5" fill="#007aff" stroke="#ffffff" strokeWidth="2" />
                </svg>
              </div>

              {/* Days axis labels */}
              <div className="flex justify-between pl-10 pr-2 pt-2 text-[10px] text-[#929297] font-medium">
                <span>Mon</span>
                <span>Tue</span>
                <span>Wed</span>
                <span>Thu</span>
                <span>Fri</span>
                <span>Sat</span>
                <span>Sun</span>
              </div>
            </div>
          </div>

          {/* Recent Check-ins Card with filter */}
          <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[18px_20px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-[#f1f1f4]">
              <div>
                <b className="text-[12px] font-semibold text-[#171719] block">
                  Recent Check-ins
                </b>
                <small className="text-[10px] text-[#929297]">
                  Latest biometric clock-ins from students and faculty
                </small>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 bg-[#f5f5f7] p-0.5 rounded-[7px] border border-[#e7e7ea] text-[10px]">
                  <button
                    type="button"
                    onClick={() => setLogFilter('all')}
                    className={`px-2 py-0.5 rounded-[5px] transition cursor-pointer ${
                      logFilter === 'all' ? 'bg-white text-[#171719] font-semibold shadow-2xs' : 'text-[#85858a]'
                    }`}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogFilter('students')}
                    className={`px-2 py-0.5 rounded-[5px] transition cursor-pointer ${
                      logFilter === 'students' ? 'bg-white text-[#007aff] font-semibold shadow-2xs' : 'text-[#85858a]'
                    }`}
                  >
                    Students
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogFilter('teachers')}
                    className={`px-2 py-0.5 rounded-[5px] transition cursor-pointer ${
                      logFilter === 'teachers' ? 'bg-white text-[#30b357] font-semibold shadow-2xs' : 'text-[#85858a]'
                    }`}
                  >
                    Teachers
                  </button>
                </div>

                <Link 
                  href="/dashboard/attendance"
                  className="text-[11px] text-[#007aff] hover:underline font-medium flex items-center gap-0.5"
                >
                  <span>Attendance center</span>
                  <ChevronRight className="w-3 h-3" />
                </Link>
              </div>
            </div>

            {displayedLogs.length === 0 ? (
              <div className="py-12 text-center text-xs text-[#929297]">
                No check-in activity recorded yet for this filter.
              </div>
            ) : (
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-left text-[11px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-[#a0a0a5] border-b border-[#f1f1f4]">
                      <th className="py-2.5 font-semibold">Person</th>
                      <th className="py-2.5 font-semibold">Role / Class</th>
                      <th className="py-2.5 font-semibold">Time</th>
                      <th className="py-2.5 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f7f7f9]">
                    {displayedLogs.slice(0, 8).map((log) => {
                      const name = log.people?.full_name || 'Individual';
                      const role = log.people?.role || 'student';
                      const className = log.classes?.name || (role === 'teacher' ? 'Faculty' : 'Form General');
                      const initials = name
                        .split(' ')
                        .map((n: string) => n[0])
                        .join('')
                        .substring(0, 2)
                        .toUpperCase();

                      const timeStr = log.occurred_at
                        ? new Date(log.occurred_at).toLocaleTimeString('en-US', { timeZone: 'Africa/Kampala',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '08:00 AM';

                      const status = log.status || 'present';

                      return (
                        <tr key={log.id} className="hover:bg-[#fbfbfd] transition">
                          <td className="py-3 pr-3">
                            <div className="flex items-center gap-2.5">
                              <div className={`w-7 h-7 rounded-full grid place-items-center text-[10px] font-semibold shrink-0 ${
                                role === 'teacher' || role === 'admin'
                                  ? 'bg-[#171719] text-white'
                                  : 'bg-[#f0f0f3] text-[#555]'
                              }`}>
                                {initials}
                              </div>
                              <span className="font-medium text-[#171719] truncate max-w-[140px] sm:max-w-[200px]">
                                {name}
                              </span>
                            </div>
                          </td>
                          <td className="py-3 text-[#5e5e63]">
                            {role === 'teacher' ? (
                              <span className="text-[#30b357] font-medium">Faculty Member</span>
                            ) : (
                              className
                            )}
                          </td>
                          <td className="py-3 text-[#85858a] font-mono text-[10px]" suppressHydrationWarning>
                            {timeStr}
                          </td>
                          <td className="py-3">
                            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                              status === 'present'
                                ? 'bg-[#edf9f0] text-[#2da94f]'
                                : status === 'late'
                                ? 'bg-[#fff5e7] text-[#e99500]'
                                : 'bg-[#fff0ef] text-[#eb453c]'
                            }`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${
                                status === 'present'
                                  ? 'bg-[#30b357]'
                                  : status === 'late'
                                  ? 'bg-[#f5a30a]'
                                  : 'bg-[#ef4444]'
                              }`} />
                              <span className="capitalize">{status}</span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {displayedLogs.length > 8 && (
              <div className="pt-3 mt-1 border-t border-[#f4f4f6] flex items-center justify-between text-[11px] text-[#85858a]">
                <span>Showing 8 of {displayedLogs.length} recent check-ins</span>
                <Link 
                  href="/dashboard/attendance" 
                  className="font-medium text-[#007aff] hover:underline flex items-center gap-0.5"
                >
                  <span>View complete list</span>
                  <ChevronRight className="w-3 h-3" />
                </Link>
              </div>
            )}
          </div>

        </div>

        {/* Right Column */}
        <div className="lg:col-span-4 space-y-[18px]">
          
          {/* Today's Summary Conic Donut Card */}
          <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[18px_20px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <div className="flex items-center justify-between pb-2">
              <b className="text-[12px] font-semibold text-[#171719]">
                {dashboardRoleScope === 'students' ? 'Student Attendance Ratio' : 'Faculty Attendance Ratio'}
              </b>
              <small className="text-[10px] text-[#929297]">{activeCount} total</small>
            </div>

            {/* Conic Donut Graphic */}
            <div className="py-4 flex flex-col items-center justify-center">
              <div 
                className="w-32 h-32 rounded-full relative grid place-items-center shadow-xs"
                style={{
                  background: `conic-gradient(#30b357 0% ${activePresentPct}%, #f5a30a ${activePresentPct}% ${activePresentPct + activeLatePct}%, #ef4444 ${activePresentPct + activeLatePct}% 100%)`
                }}
              >
                {/* Center Cutout */}
                <div className="w-22 h-22 rounded-full bg-white grid place-items-center text-center shadow-inner">
                  <div>
                    <b className="text-lg font-bold text-[#171719] block leading-tight">
                      {activePresentPct}%
                    </b>
                    <small className="text-[9px] uppercase tracking-wider text-[#929297] font-semibold">
                      Present
                    </small>
                  </div>
                </div>
              </div>
            </div>

            {/* Legend breakdown */}
            <div className="pt-2 border-t border-[#f1f1f4] space-y-2 text-[11px]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#30b357]" />
                  <span className="text-[#5e5e63]">Present (On-Time)</span>
                </div>
                <span className="font-semibold text-[#171719]">{activePresent}</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#f5a30a]" />
                  <span className="text-[#5e5e63]">Late Arrival (&gt; 8 AM)</span>
                </div>
                <span className="font-semibold text-[#171719]">{activeLate}</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#ef4444]" />
                  <span className="text-[#5e5e63]">Absent / Pending</span>
                </div>
                <span className="font-semibold text-[#171719]">{activeAbsent}</span>
              </div>
            </div>
          </div>

          {/* Quick Reports Launcher Card */}
          <div className="bg-[#171719] text-white rounded-[13px] p-[18px_20px] shadow-sm space-y-3">
            <div className="flex items-center gap-2 text-[#30b357] text-xs font-semibold">
              <FileText className="w-4 h-4" />
              <span>Export & Reports Hub</span>
            </div>
            <p className="text-[11px] text-white/70 leading-relaxed">
              Generate official attendance summaries, download CSV records, or print verified reports for parents and school inspectors.
            </p>
            <Link
              href="/dashboard/attendance"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-white/15 hover:bg-white/25 px-3 py-2 rounded-[8px] transition"
            >
              <span>Open Reports Generator</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {/* Devices Card */}
          <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[18px_20px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <div className="flex items-center justify-between pb-3 border-b border-[#f1f1f4]">
              <div>
                <b className="text-[12px] font-semibold text-[#171719] block">Devices</b>
                <small className="text-[10px] text-[#929297]">ADMS hardware sync</small>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#edf9f0] text-[#2da94f]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#30b357] animate-pulse" />
                <span>{devicesList.length || 0} Online</span>
              </span>
            </div>

            <div className="mt-3 space-y-2.5">
              {devicesList.length > 0 ? (
                devicesList.map((dev: any) => (
                  <div key={dev.id} className="flex items-center justify-between p-2 rounded-lg bg-[#fafafa] border border-[#f0f0f3]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-md bg-white border border-[#e7e7ea] text-[#171719] grid place-items-center text-xs">
                        <Smartphone className="w-3.5 h-3.5 text-[#5e5e63]" />
                      </div>
                      <div>
                        <div className="text-[11px] font-medium text-[#171719]">{dev.name || 'Terminal'}</div>
                        <div className="text-[9px] text-[#929297]">SN: {dev.serial_number || 'ADMS'}</div>
                      </div>
                    </div>
                    <span className="text-[10px] text-[#30b357] font-medium">Active</span>
                  </div>
                ))
              ) : (
                <div className="text-[11px] text-[#929297] text-center p-3">No active devices found</div>
              )}
            </div>

            <div className="pt-3 mt-3 border-t border-[#f1f1f4] flex justify-end">
              <Link 
                href="/dashboard/devices"
                className="text-[10.5px] text-[#007aff] hover:underline font-medium flex items-center gap-1"
              >
                <span>Manage Devices</span>
                <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
