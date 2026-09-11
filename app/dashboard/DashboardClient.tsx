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
  GraduationCap,
  Briefcase,
  Users,
  FileText,
  Search,
  Calendar
} from 'lucide-react';
import { formatEATTime } from '@/lib/eat-time';
import { useRouter } from 'next/navigation';

interface ClassBreakdownItem {
  id: string;
  name: string;
  enrolled: number;
  presentToday: number;
  lateToday: number;
  absentToday: number;
  rate: number;
}

interface WeekTrendItem {
  dayName: string;
  dateKey: string;
  dateLabel: string;
  isToday: boolean;
  isFuture: boolean;
  attendedCount: number;
  rate: number | null;
}

interface DashboardInteractiveProps {
  todayLogs: any[];
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
  classBreakdown: ClassBreakdownItem[];
  weekTrend: WeekTrendItem[];
  recentMessages: any[];
  greeting: string;
  adminName: string;
  formattedDate: string;
}

export default function DashboardClient({
  todayLogs,
  studentCount,
  presentCount,
  lateCount,
  absentCount,
  presentPct,
  latePct,
  absentPct,
  teacherCount = 0,
  teacherPresentCount = 0,
  teacherLateCount = 0,
  teacherAbsentCount = 0,
  teacherPresentPct = 0,
  teacherLatePct = 0,
  teacherAbsentPct = 0,
  devicesList,
  classBreakdown,
  weekTrend,
  recentMessages,
  greeting,
  adminName,
  formattedDate
}: DashboardInteractiveProps) {
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dashboardRoleScope, setDashboardRoleScope] = useState<'students' | 'teachers'>('students');
  const [logFilter, setLogFilter] = useState<'all' | 'students' | 'teachers' | 'late' | 'present'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const handleRefresh = () => {
    setIsRefreshing(true);
    router.refresh();
    setTimeout(() => {
      setIsRefreshing(false);
    }, 600);
  };

  // Filter today's logs for the live check-ins table
  const displayedLogs进 = useMemo(() => {
    return todayLogs.filter(l => {
      const role = l.people?.role || 'student';
      const isStudent = role === 'student';
      const isTeacher = role === 'teacher' || role === 'admin' || role === 'support_staff';
      const status = l.status || 'present';

      if (logFilter === 'students' && !isStudent) return false;
      if (logFilter === 'teachers' && !isTeacher) return false;
      if (logFilter === 'late' && status !== 'late') return false;
      if (logFilter === 'present' && status !== 'present') return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const name = (l.people?.full_name || '').toLowerCase();
        const clsName = (l.classes?.name || l.people?.classes?.name || '').toLowerCase();
        if (!name.includes(q) && !clsName.includes(q)) {
          return false;
        }
      }

      return true;
    });
  }, [todayLogs, logFilter, searchQuery]);

  // Current scope metrics
  const activeCount = dashboardRoleScope === 'students' ? studentCount : teacherCount;
  const activePresent = dashboardRoleScope === 'students' ? presentCount : teacherPresentCount;
  const activeLate不易 = dashboardRoleScope === 'students' ? lateCount : teacherLateCount;
  const activeAbsent = dashboardRoleScope === 'students' ? absentCount : teacherAbsentCount;
  const activePresentPct = dashboardRoleScope === 'students' ? presentPct : teacherPresentPct;
  const activeLatePct = dashboardRoleScope === 'students' ? latePct : teacherLatePct;
  const activeAbsentPct不易 = dashboardRoleScope === 'students' ? absentPct : teacherAbsentPct;

  // Compute SVG Points for Week Trend
  const chartPoints = useMemo(() => {
    if (!weekTrend || weekTrend.length === 0) return { pathD: '', areaD: '', dots: [] };

    // 7 days mapped across width 40 to 480
    // X coordinates: Mon=50, Tue=120, Wed=190, Thu=260, Fri=330, Sat=400, Sun=470
    // Y coordinates: 0% = 190, 100% = 30
    const startX = 50;
    const endX = 470;
    const stepX受到 = (endX - startX) / 6;

    const validPoints: { x: number; y: number; rate: number; dayName: string; isToday: boolean; isFuture: boolean }[] = [];

    weekTrend.forEach((item, index) => {
      const x = startX + index * stepX受到;
      const rateVal = item.rate ?? 0;
      // Map 0 -> 190, 100 -> 30
      const y = 190 - (rateVal / 100) * 160;

      validPoints.push({
        x,
        y: item.isFuture ? 190 : y,
        rate: rateVal,
        dayName: item.dayName,
        isToday: item.isToday,
        isFuture: item.isFuture,
      });
    });

    const recordedPoints = validPoints.filter(p => !p.isFuture);
    if (recordedPoints.length === 0) {
      return { pathD: 'M 50 190 L 470 190', areaD: 'M 50 190 L 470 190 L 470 190 L 50 190 Z', dots: validPoints };
    }

    let pathD = `M ${recordedPoints[0].x} ${recordedPoints[0].y}`;
    for (let i = 1; i < recordedPoints.length; i++) {
      pathD += ` L ${recordedPoints[i].x} ${recordedPoints[i].y}`;
    }

    const lastRecorded = recordedPoints[recordedPoints.length - 1];
    const areaD = `${pathD} L ${lastRecorded.x} 190 L ${recordedPoints[0].x} 190 Z`;

    return { pathD, areaD, dots: validPoints };
  }, [weekTrend]);

  return (
    <div className="space-y-6 pt-3 animate-fade-in pb-12">
      
      {/* Hero Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-1">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-semibold tracking-[0.12em] uppercase text-[#929297]">
              {formattedDate}
            </span>
          </div>
          <h1 className="text-[22px] sm:text-[25px] font-bold tracking-tight text-[#171719] leading-tight">
            {greeting}, {adminName}.
          </h1>
          <p className="text-[12px] text-[#85858a] mt-0.5">
            Real-time daily attendance overview and biometric check-ins recorded today.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Refresh Button */}
          <button
            type="button"
            onClick={handleRefresh}
            title="Refresh today's live feed"
            className="h-[34px] px-2.5 bg-white hover:bg-[#f5f5f7] border border-[#e7e7ea] text-[#171719] rounded-[9px] text-[11px] font-medium flex items-center gap-1.5 shadow-2xs transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-[#5e5e63] ${isRefreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>

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
            <span>Attendance Center</span>
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

      {/* 4 Stat Cards for Today */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[14px]">
        
        {/* Total Roster */}
        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[16px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#85858a] font-medium">
              {dashboardRoleScope === 'students' ? 'Enrolled Students' : 'Total Faculty Members'}
            </span>
            <span className="w-7 h-7 rounded-[8px] bg-[#edf5ff] text-[#007aff] grid place-items-center text-xs font-semibold">
              {dashboardRoleScope === 'students' ? <Users className="w-3.5 h-3.5" /> : <Briefcase className="w-3.5 h-3.5" />}
            </span>
          </div>
          <div className="mt-3">
            <b className="text-[26px] font-bold tracking-tight text-[#171719] leading-none block">
              {activeCount.toLocaleString()}
            </b>
            <div className="text-[10px] text-[#85858a] mt-1.5 flex items-center gap-1">
              <span className="text-[#30b357] font-semibold">Active Roster</span>
              <span>{dashboardRoleScope === 'students' ? 'across all classes' : 'registered staff'}</span>
            </div>
          </div>
        </div>

        {/* Present Today */}
        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[16px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#85858a] font-medium">
              {dashboardRoleScope === 'students' ? 'Present Today (On Time)' : 'Faculty Present Today'}
            </span>
            <span className="w-7 h-7 rounded-[8px] bg-[#edf9f0] text-[#30b357] grid place-items-center text-xs font-semibold">
              <CheckCircle2 className="w-3.5 h-3.5" />
            </span>
          </div>
          <div className="mt-3">
            <b className="text-[26px] font-bold tracking-tight text-[#2da94f] leading-none block">
              {activePresent.toLocaleString()}
            </b>
            <div className="text-[10px] text-[#85858a] mt-1.5">
              <strong className="text-[#171719] font-medium">{activePresentPct}%</strong> on-time arrival today
            </div>
          </div>
        </div>

        {/* Late Today */}
        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[16px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#85858a] font-medium">
              {dashboardRoleScope === 'students' ? 'Late Arrivals Today' : 'Late Faculty Today'}
            </span>
            <span className="w-7 h-7 rounded-[8px] bg-[#fff5e7] text-[#f5a30a] grid place-items-center text-xs font-semibold">
              <Clock className="w-3.5 h-3.5" />
            </span>
          </div>
          <div className="mt-3">
            <b className="text-[26px] font-bold tracking-tight text-[#f5a30a] leading-none block">
              {activeLate不易.toLocaleString()}
            </b>
            <div className="text-[10px] text-[#85858a] mt-1.5">
              <strong className="text-[#f5a30a] font-medium">{activeLatePct}%</strong> recorded late today
            </div>
          </div>
        </div>

        {/* Absent / Pending Today */}
        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[16px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#85858a] font-medium">
              {dashboardRoleScope === 'students' ? 'Absent / Pending Today' : 'Pending Clock-in Today'}
            </span>
            <span className="w-7 h-7 rounded-[8px] bg-[#fff0ef] text-[#ef4444] grid place-items-center text-xs font-semibold">
              <AlertCircle className="w-3.5 h-3.5" />
            </span>
          </div>
          <div className="mt-3">
            <b className="text-[26px] font-bold tracking-tight text-[#171719] leading-none block">
              {activeAbsent.toLocaleString()}
            </b>
            <div className="text-[10px] text-[#85858a] mt-1.5">
              <strong className="text-[#ef4444] font-medium">{activeAbsentPct不易}%</strong> not yet checked in today
            </div>
          </div>
        </div>

      </div>

      {/* Main 2-Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-[18px]">
        
        {/* Left Column (8 spans) */}
        <div className="lg:col-span-8 space-y-[18px]">
          
          {/* Today's Live Check-ins Card */}
          <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[18px_20px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[#f1f1f4]">
              <div>
                <div className="flex items-center gap-2">
                  <b className="text-[13px] font-semibold text-[#171719] block">
                    Today&apos;s Live Check-ins
                  </b>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-[#edf9f0] text-[#2da94f]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#30b357] animate-pulse" />
                    <span>{todayLogs.length} Scans Today</span>
                  </span>
                </div>
                <small className="text-[10px] text-[#929297]">
                  Real-time clock-in log recorded today exclusively
                </small>
              </div>

              {/* Filters & Search */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#929297]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search today's check-ins..."
                    className="pl-8 pr-2.5 py-1 text-[11px] bg-[#f5f5f7] border border-[#e7e7ea] rounded-[7px] focus:outline-none focus:border-[#007aff] focus:bg-white w-40 sm:w-48 transition"
                  />
                </div>

                <div className="flex items-center gap-1 bg-[#f5f5f7] p-0.5 rounded-[7px] border border-[#e7e7ea] text-[10px]">
                  <button
                    type="button"
                    onClick={() => setLogFilter('all')}
                    className={`px-2 py-1 rounded-[5px] transition cursor-pointer ${
                      logFilter === 'all' ? 'bg-white text-[#171719] font-semibold shadow-2xs' : 'text-[#85858a]'
                    }`}
                  >
                    All ({todayLogs.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogFilter('students')}
                    className={`px-2 py-1 rounded-[5px] transition cursor-pointer ${
                      logFilter === 'students' ? 'bg-white text-[#007aff] font-semibold shadow-2xs' : 'text-[#85858a]'
                    }`}
                  >
                    Students
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogFilter('teachers')}
                    className={`px-2 py-1 rounded-[5px] transition cursor-pointer ${
                      logFilter === 'teachers' ? 'bg-white text-[#30b357] font-semibold shadow-2xs' : 'text-[#85858a]'
                    }`}
                  >
                    Faculty
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogFilter('late')}
                    className={`px-2 py-1 rounded-[5px] transition cursor-pointer ${
                      logFilter === 'late' ? 'bg-white text-[#f5a30a] font-semibold shadow-2xs' : 'text-[#85858a]'
                    }`}
                  >
                    Late ({todayLogs.filter(l => l.status === 'late').length})
                  </button>
                </div>
              </div>
            </div>

            {displayedLogs进.length === 0 ? (
              <div className="py-12 text-center">
                <div className="w-12 h-12 rounded-full bg-[#f5f5f7] text-[#929297] grid place-items-center mx-auto mb-3">
                  <Calendar className="w-6 h-6" />
                </div>
                <div className="text-sm font-semibold text-[#171719]">
                  {todayLogs.length === 0 ? "No Check-ins Recorded Today Yet" : "No Matches for Current Filter"}
                </div>
                <p className="text-xs text-[#85858a] mt-1 max-w-sm mx-auto">
                  {todayLogs.length === 0 
                    ? "Attendance scans from biometric hardware or the Kiosk will appear here in real-time as students and staff arrive today."
                    : "Try adjusting your search query or switching to the 'All' tab to view today's records."}
                </p>
                {todayLogs.length === 0 && (
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <Link
                      href="/mark-attendance"
                      target="_blank"
                      className="px-3 py-1.5 bg-[#171719] hover:bg-[#2c2c2e] text-white rounded-[8px] text-xs font-medium inline-flex items-center gap-1.5 shadow-2xs transition"
                    >
                      <span>Launch Kiosk Terminal</span>
                      <ExternalLink className="w-3 h-3 opacity-80" />
                    </Link>
                  </div>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-left text-[11px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-[#a0a0a5] border-b border-[#f1f1f4]">
                      <th className="py-2.5 font-semibold">Person</th>
                      <th className="py-2.5 font-semibold">Role / Stream</th>
                      <th className="py-2.5 font-semibold">Clock-in Time</th>
                      <th className="py-2.5 font-semibold">Source</th>
                      <th className="py-2.5 font-semibold">Today&apos;s Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f7f7f9]">
                    {displayedLogs进.slice(0, 10).map((log) => {
                      const name = log.people?.full_name || 'Individual';
                      const role剩下 = log.people?.role || 'student';
                      const isFaculty = role剩下 === 'teacher' || role剩下 === 'admin' || role剩下 === 'support_staff';
                      const className = log.classes?.name || log.people?.classes?.name || (isFaculty ? 'Faculty / Staff' : 'Form General');
                      const initials = name
                        .split(' ')
                        .map((n: string) => n[0])
                        .join('')
                        .substring(0, 2)
                        .toUpperCase();

                      const timeStr = formatEATTime(log.occurred_at);
                      const status = log.status || 'present';
                      const sourceLabel = log.source === 'adms' ? 'Biometric Device' : log.source === 'kiosk' ? 'Kiosk Terminal' : log.source === 'manual' ? 'Manual Registry' : 'System';

                      return (
                        <tr key={log.id} className="hover:bg-[#fbfbfd] transition">
                          <td className="py-2.5 pr-3">
                            <div className="flex items-center gap-2.5">
                              <div className={`w-7 h-7 rounded-full grid place-items-center text-[10px] font-semibold shrink-0 ${
                                isFaculty ? 'bg-[#171719] text-white' : 'bg-[#eef4ff] text-[#007aff]'
                              }`}>
                                {initials}
                              </div>
                              <span className="font-medium text-[#171719] truncate max-w-[140px] sm:max-w-[180px]">
                                {name}
                              </span>
                            </div>
                          </td>
                          <td className="py-2.5 text-[#5e5e63]">
                            {isFaculty ? (
                              <span className="text-[#30b357] font-medium inline-flex items-center gap-1">
                                <Briefcase className="w-3 h-3" />
                                <span>Faculty</span>
                              </span>
                            ) : (
                              className
                            )}
                          </td>
                          <td className="py-2.5 text-[#171719] font-mono text-[10.5px] font-medium" suppressHydrationWarning>
                            {timeStr}
                          </td>
                          <td className="py-2.5 text-[#85858a] text-[10px]">
                            {sourceLabel}
                          </td>
                          <td className="py-2.5">
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

            {displayedLogs进.length > 10 && (
              <div className="pt-3 mt-1 border-t border-[#f4f4f6] flex items-center justify-between text-[11px] text-[#85858a]">
                <span>Showing 10 of {displayedLogs进.length} check-ins for today</span>
                <Link 
                  href="/dashboard/attendance" 
                  className="font-medium text-[#007aff] hover:underline flex items-center gap-0.5"
                >
                  <span>View all records & historical logs</span>
                  <ChevronRight className="w-3 h-3" />
                </Link>
              </div>
            )}
          </div>

          {/* Today's Class-by-Class Breakdown (Live Stream Progress) */}
          {classBreakdown && classBreakdown.length > 0 && (
            <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[18px_20px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
              <div className="flex items-center justify-between pb-3 border-b border-[#f1f1f4]">
                <div>
                  <b className="text-[13px] font-semibold text-[#171719] block">
                    Today&apos;s Class Stream Progress
                  </b>
                  <small className="text-[10px] text-[#929297]">
                    Live attendance percentage by registered class stream for today
                  </small>
                </div>
                <span className="text-[11px] text-[#85858a] font-medium">
                  {classBreakdown.length} Classes
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3">
                {classBreakdown.map(cls => (
                  <div key={cls.id} className="p-3 rounded-[10px] bg-[#fafafa] border border-[#f0f0f3] space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#171719]">{cls.name}</span>
                      <span className={`text-[11px] font-bold ${
                        cls.rate >= 90 ? 'text-[#30b357]' : cls.rate >= 70 ? 'text-[#007aff]' : cls.rate > 0 ? 'text-[#f5a30a]' : 'text-[#85858a]'
                      }`}>
                        {cls.rate}%
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="h-2 w-full bg-[#e8e8ec] rounded-full overflow-hidden flex">
                      <div 
                        className="bg-[#30b357] h-full transition-all duration-500" 
                        style={{ width: `${cls.enrolled > 0 ? (cls.presentToday / cls.enrolled) * 100 : 0}%` }}
                        title={`${cls.presentToday} On-time`}
                      />
                      <div 
                        className="bg-[#f5a30a] h-full transition-all duration-500" 
                        style={{ width: `${cls.enrolled > 0 ? (cls.lateToday / cls.enrolled) * 100 : 0}%` }}
                        title={`${cls.lateToday} Late`}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-[#85858a]">
                      <span>
                        <strong className="text-[#171719]">{cls.presentToday + cls.lateToday}</strong> / {cls.enrolled} present today
                      </span>
                      <span>
                        {cls.absentToday > 0 ? `${cls.absentToday} pending` : 'All accounted'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 7-Day Weekly Attendance Rate Chart */}
          <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[18px_20px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <div className="flex items-center justify-between pb-3">
              <div>
                <b className="text-[13px] font-semibold text-[#171719] block">
                  Daily Attendance Rate (Current Week)
                </b>
                <small className="text-[10px] text-[#929297]">
                  Daily attendance comparison for Monday through Sunday
                </small>
              </div>

              <div className="text-[10px] text-[#007aff] font-semibold bg-[#edf5ff] px-2 py-0.5 rounded-full border border-[#d2e5fe]">
                Week Overview
              </div>
            </div>

            {/* SVG Interactive Chart */}
            <div className="pt-2">
              <div className="relative h-[200px] w-full">
                <svg className="w-full h-full" viewBox="0 0 500 200" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="appleAreaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#007aff" stopOpacity="0.14" />
                      <stop offset="100%" stopColor="#007aff" stopOpacity="0.00" />
                    </linearGradient>
                  </defs>

                  {/* Grid Lines & Labels */}
                  <line x1="40" y1="30" x2="490" y2="30" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="33" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">100%</text>

                  <line x1="40" y1="70" x2="490" y2="70" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="73" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">75%</text>

                  <line x1="40" y1="110" x2="490" y2="110" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="113" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">50%</text>

                  <line x1="40" y1="150" x2="490" y2="150" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="153" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">25%</text>

                  <line x1="40" y1="190" x2="490" y2="190" stroke="#f1f1f4" strokeWidth="1" />
                  <text x="30" y="190" textAnchor="end" fill="#b4b4b8" fontSize="9" fontFamily="sans-serif">0%</text>

                  {/* Area Gradient Fill */}
                  {chartPoints.areaD && (
                    <path
                      d={chartPoints.areaD}
                      fill="url(#appleAreaGrad)"
                    />
                  )}

                  {/* Line Stroke */}
                  {chartPoints.pathD && (
                    <path
                      d={chartPoints.pathD}
                      fill="none"
                      stroke="#007aff"
                      strokeWidth="2.3"
                      strokeLinecap="round"
                    />
                  )}

                  {/* Point circles */}
                  {chartPoints.dots.map((dot, idx) => (
                    <g key={idx}>
                      <circle
                        cx={dot.x}
                        cy={dot.y}
                        r={dot.isToday ? 5 : 3.5}
                        fill={dot.isToday ? "#007aff" : dot.isFuture ? "#e5e5ea" : "#ffffff"}
                        stroke={dot.isToday ? "#ffffff" : dot.isFuture ? "#d1d1d6" : "#007aff"}
                        strokeWidth="2"
                      />
                      {!dot.isFuture && dot.rate > 0 && (
                        <text
                          x={dot.x}
                          y={dot.y - 8}
                          textAnchor="middle"
                          fill="#007aff"
                          fontSize="9"
                          fontWeight="bold"
                        >
                          {dot.rate}%
                        </text>
                      )}
                    </g>
                  ))}
                </svg>
              </div>

              {/* Days axis labels */}
              <div className="flex justify-between pl-10 pr-2 pt-2 text-[10px] font-medium">
                {weekTrend.map((wd, i) => (
                  <div key={i} className={`text-center ${wd.isToday ? 'text-[#007aff] font-bold' : wd.isFuture ? 'text-[#c7c7cc]' : 'text-[#85858a]'}`}>
                    <div>{wd.dayName}</div>
                    <div className="text-[8.5px] opacity-80">{wd.dateLabel}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>

        {/* Right Column (4 spans) */}
        <div className="lg:col-span-4 space-y-[18px]">
          
          {/* Today's Summary Conic Donut Card */}
          <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[18px_20px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <div className="flex items-center justify-between pb-2">
              <b className="text-[12px] font-semibold text-[#171719]">
                {dashboardRoleScope === 'students' ? 'Today’s Student Ratio' : 'Today’s Faculty Ratio'}
              </b>
              <small className="text-[10px] text-[#929297]">{activeCount} total</small>
            </div>

            {/* Conic Donut Graphic for TODAY */}
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
                      Present Today
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
                  <span className="text-[#5e5e63]">Present On-Time</span>
                </div>
                <span className="font-semibold text-[#171719]">{activePresent}</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#f5a30a]" />
                  <span className="text-[#5e5e63]">Late Arrival</span>
                </div>
                <span className="font-semibold text-[#171719]">{activeLate不易}</span>
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

          {/* Historical Data & Reports Link */}
          <div className="bg-[#171719] text-white rounded-[13px] p-[18px_20px] shadow-sm space-y-3">
            <div className="flex items-center gap-2 text-[#30b357] text-xs font-semibold">
              <FileText className="w-4 h-4" />
              <span>Full Historical Archives</span>
            </div>
            <p className="text-[11px] text-white/70 leading-relaxed">
              Older records, term summaries, monthly PDF reports, and previous dates are preserved in the Attendance Center.
            </p>
            <Link
              href="/dashboard/attendance"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-white/15 hover:bg-white/25 px-3 py-2 rounded-[8px] transition"
            >
              <span>Open Attendance History</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {/* Devices Card */}
          <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[18px_20px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <div className="flex items-center justify-between pb-3 border-b border-[#f1f1f4]">
              <div>
                <b className="text-[12px] font-semibold text-[#171719] block">Connected Terminals</b>
                <small className="text-[10px] text-[#929297]">ADMS hardware sync</small>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#edf9f0] text-[#2da94f]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#30b357] animate-pulse" />
                <span>{devicesList.length || 0} Ready</span>
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
                    <span className="text-[10px] text-[#30b357] font-medium">Online</span>
                  </div>
                ))
              ) : (
                <div className="text-[11px] text-[#929297] text-center p-3">No active devices configured</div>
              )}
            </div>

            <div className="pt-3 mt-3 border-t border-[#f1f1f4] flex justify-end">
              <Link 
                href="/dashboard/devices"
                className="text-[10.5px] text-[#007aff] hover:underline font-medium flex items-center gap-1"
              >
                <span>Manage Hardware</span>
                <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
