'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { getAttendanceData, topUpBalance, getSchoolBalance } from './actions';
import { 
  Clock, 
  Wallet, 
  Check, 
  AlertCircle, 
  RefreshCw, 
  Plus, 
  MessageSquare, 
  Calendar, 
  User, 
  Users,
  Send, 
  Search, 
  X,
  CreditCard,
  Sparkles,
  ChevronRight,
  ChevronDown,
  Smartphone,
  ShieldCheck,
  CheckCircle2,
  ExternalLink,
  Copy,
  Briefcase,
  FileText,
  GraduationCap
} from 'lucide-react';
import TeacherAttendanceManager from './TeacherAttendanceManager';
import AttendanceReports from './AttendanceReports';
import { formatEATTime, formatEATDate, getEATDateKey } from '@/lib/eat-time';

export default function AttendancePage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [people, setPeople] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [school, setSchool] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Active View Tab: 'students' | 'teachers' | 'reports'
  const [activeTab, setActiveTab] = useState<'students' | 'teachers' | 'reports'>('students');
  
  // Wallet / Top Up state
  const [showTopUpModal, setShowTopUpModal] = useState(false);
  const [topUpStep, setTopUpStep] = useState<'form' | 'waiting' | 'success'>('form');
  const [topUpAmount, setTopUpAmount] = useState<string>('50000');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [isToppingUp, setIsToppingUp] = useState(false);
  const [topUpMessage, setTopUpMessage] = useState('');
  const [initialBalance, setInitialBalance] = useState<number>(0);
  const [copiedLink, setCopiedLink] = useState(false);

  // Foldable / Collapsible date groups state (empty set means all groups are expanded by default)
  const [collapsedStudentDateKeys, setCollapsedStudentDateKeys] = useState<Set<string>>(() => new Set());

  // Search & Filter state for Students tab
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [classFilter, setClassFilter] = useState<string>('all');

  useEffect(() => {
    loadData();
  }, []);

  // Poll for balance updates when waiting for Mobile Money PIN confirmation
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (showTopUpModal && topUpStep === 'waiting') {
      const checkBalanceNow = async () => {
        try {
          const result = await getSchoolBalance();
          if (result && typeof result.balance === 'number') {
            setSchool((prev: any) => ({
              ...prev,
              settings: { ...(prev?.settings || {}), balance: result.balance }
            }));
            if (result.balance > initialBalance) {
              setTopUpStep('success');
              setTopUpMessage(`Payment received! New balance: ${result.balance.toLocaleString()} UGX`);
              if (interval) clearInterval(interval);
            }
          }
        } catch (e) {
          console.error('Polling error', e);
        }
      };

      // Check immediately, then poll every 2.5s
      checkBalanceNow();
      interval = setInterval(checkBalanceNow, 2500);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [showTopUpModal, topUpStep, initialBalance]);

  async function loadData() {
    try {
      setLoading(true);
      const data = await getAttendanceData();
      if (data.error) {
        setError(data.error);
      } else {
        setLogs(data.logs || []);
        setPeople(data.people || []);
        setClasses(data.classes || []);
        setSchool(data.school || null);
        setError(null);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load attendance data');
    } finally {
      setLoading(false);
    }
  }

  const openTopUpModal = () => {
    setTopUpStep('form');
    setError(null);
    setInitialBalance(school?.settings?.balance || 0);
    setShowTopUpModal(true);
  };

  const handleTopUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountNum = parseInt(topUpAmount);
    if (isNaN(amountNum) || amountNum <= 0) return;
    if (!phoneNumber || phoneNumber.length < 9) {
      setError('Please enter a valid phone number');
      return;
    }

    setIsToppingUp(true);
    setError(null);
    const startBal = school?.settings?.balance || 0;
    setInitialBalance(startBal);

    try {
      const result = await topUpBalance(amountNum, phoneNumber);
      if (result.error) {
        setError(result.error);
      } else {
        setTopUpMessage(result.message || 'Prompt sent to your phone.');
        setTopUpStep('waiting');
      }
    } catch {
      setError('An unexpected error occurred during top up.');
    } finally {
      setIsToppingUp(false);
    }
  };

  const handleQuickAmount = (amount: number) => {
    setTopUpAmount(amount.toString());
  };

  const copyTeacherLink = async () => {
    const origin = window.location.origin;
    const url = `${origin}/mark-attendance`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      console.error('Failed to copy link');
    }
  };

  // Split people into students and teachers/staff
  const teachersList = useMemo(() => {
    return people.filter(p => p.role === 'teacher' || p.role === 'admin' || p.role === 'support_staff');
  }, [people]);

  // Students attendance logs
  const studentLogs = useMemo(() => {
    return logs.filter(l => (l.people?.role || 'student') === 'student');
  }, [logs]);

  // Filter students logs
  const filteredStudentLogs = useMemo(() => {
    return studentLogs.filter(log => {
      const personName = log.people?.full_name || '';
      const matchesSearch = personName.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === 'all' || log.status === statusFilter;
      const personClassId = log.people?.class_id || log.class_id;
      const matchesClass = classFilter === 'all' || personClassId === classFilter;
      return matchesSearch && matchesStatus && matchesClass;
    });
  }, [studentLogs, searchTerm, statusFilter, classFilter]);

  // Group student logs by date in East Africa Time (YYYY-MM-DD)
  const groupedStudentLogs = useMemo(() => {
    const map: { [key: string]: any[] } = {};
    
    filteredStudentLogs.forEach(log => {
      if (!log.occurred_at) return;
      const dateKey = getEATDateKey(log.occurred_at);
      
      if (!map[dateKey]) {
        map[dateKey] = [];
      }
      map[dateKey].push(log);
    });

    const todayKey = getEATDateKey(new Date());
    
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = getEATDateKey(yesterday);

    return Object.keys(map)
      .sort((a, b) => b.localeCompare(a))
      .map(dateKey => {
        const dayLogs = map[dateKey];
        const sampleIso = dayLogs[0]?.occurred_at || `${dateKey}T00:00:00+03:00`;
        
        let label = formatEATDate(sampleIso, {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        });

        let badge = '';
        if (dateKey === todayKey) {
          badge = 'Today';
        } else if (dateKey === yesterdayKey) {
          badge = 'Yesterday';
        }

        const presentCount = dayLogs.filter(l => l.status === 'present').length;
        const lateCount = dayLogs.filter(l => l.status === 'late').length;

        return {
          dateKey,
          label,
          badge,
          logs: dayLogs,
          presentCount,
          lateCount
        };
      });
  }, [filteredStudentLogs]);

  const toggleStudentDateKey = (dateKey: string) => {
    setCollapsedStudentDateKeys((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) {
        next.delete(dateKey); // Unfold
      } else {
        next.add(dateKey); // Fold
      }
      return next;
    });
  };

  const expandAllStudentDates = () => {
    setCollapsedStudentDateKeys(new Set());
  };

  const collapseAllStudentDates = () => {
    setCollapsedStudentDateKeys(new Set(groupedStudentLogs.map(g => g.dateKey)));
  };

  const currentBalance = school?.settings?.balance || 0;
  const approxSMSCount = Math.floor(currentBalance / 50);

  if (loading && logs.length === 0) {
    return (
      <div className="pt-12 text-center flex flex-col items-center justify-center space-y-3">
        <RefreshCw className="w-6 h-6 text-[#007aff] animate-spin" />
        <p className="text-xs text-[#85858a]">Loading attendance tracking center...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pt-5 animate-fade-in">
      
      {/* Top Header Row with Wallet Section */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-white border border-[#e7e7ea] p-6 rounded-[16px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-[#929297] mb-1">
            ATTENDANCE MANAGEMENT & REPORTS
          </div>
          <h1 className="text-[22px] sm:text-[25px] font-bold tracking-tight text-[#171719] leading-tight">
            Attendance Tracking Center
          </h1>
          <p className="text-[12px] text-[#85858a] mt-0.5 max-w-xl">
            Monitor real-time student and faculty clock-ins, view entry times, and generate comprehensive attendance reports.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <a 
              href="/mark-attendance" 
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#171719] hover:bg-[#2c2c2e] text-white rounded-[8px] text-[11px] font-medium transition shadow-2xs"
            >
              <Smartphone className="w-3.5 h-3.5 text-white/80" />
              <span>Open Kiosk Terminal</span>
              <ExternalLink className="w-3 h-3 opacity-60 ml-0.5" />
            </a>

            <button
              type="button"
              onClick={copyTeacherLink}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#e1e1e5] bg-white hover:bg-[#f7f7f8] rounded-[8px] text-[11px] font-medium text-[#171719] transition cursor-pointer"
            >
              {copiedLink ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#30b357]" />
                  <span className="text-[#30b357]">Copied Teacher Link</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-[#929297]" />
                  <span>Copy Link for Teachers</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Top-Right Wallet Section */}
        <div className="bg-[#f7f7f9] border border-[#e7e7ea] p-4 sm:p-5 rounded-[13px] flex flex-wrap sm:flex-nowrap items-center justify-between gap-5 min-w-[280px]">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-[10px] bg-[#edf9f0] border border-[#d2f4d9] flex items-center justify-center text-[#30b357] shrink-0">
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[#929297]">
                SMS Wallet Balance
              </div>
              <div className="text-xl font-bold tracking-tight text-[#171719] flex items-baseline gap-1 mt-0.5">
                <span>{currentBalance.toLocaleString()}</span>
                <span className="text-xs font-semibold text-[#85858a]">UGX</span>
              </div>
              <div className="text-[11px] text-[#30b357] font-medium flex items-center gap-1 mt-0.5">
                <MessageSquare className="w-3 h-3" />
                <span>~{approxSMSCount.toLocaleString()} SMS credits</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={openTopUpModal}
            className="w-full sm:w-auto px-3.5 py-2 bg-[#007aff] hover:bg-[#0062cc] text-white font-medium text-xs rounded-[9px] shadow-2xs flex items-center justify-center gap-1.5 transition cursor-pointer shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Top Up</span>
          </button>
        </div>
      </div>

      {/* Main Mode Toggle Switcher: Students | Teachers | Generate Reports */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-white p-2 border border-[#e7e7ea] rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
        
        <div className="flex items-center gap-1.5 w-full sm:w-auto bg-[#f5f5f7] p-1 rounded-[10px] border border-[#e7e7ea]">
          <button
            type="button"
            onClick={() => setActiveTab('students')}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-[8px] text-xs font-medium transition cursor-pointer flex items-center justify-center gap-2 ${
              activeTab === 'students'
                ? 'bg-white text-[#171719] shadow-2xs font-semibold'
                : 'text-[#85858a] hover:text-[#171719]'
            }`}
          >
            <GraduationCap className="w-4 h-4 text-[#007aff]" />
            <span>Students Attendance</span>
            <span className="text-[10px] px-1.5 py-0.2 bg-[#edf5ff] text-[#007aff] rounded-full font-bold">
              {studentLogs.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('teachers')}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-[8px] text-xs font-medium transition cursor-pointer flex items-center justify-center gap-2 ${
              activeTab === 'teachers'
                ? 'bg-white text-[#171719] shadow-2xs font-semibold'
                : 'text-[#85858a] hover:text-[#171719]'
            }`}
          >
            <Briefcase className="w-4 h-4 text-[#30b357]" />
            <span>Teachers Attendance</span>
            <span className="text-[10px] px-1.5 py-0.2 bg-[#edf9f0] text-[#30b357] rounded-full font-bold">
              {teachersList.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('reports')}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-[8px] text-xs font-medium transition cursor-pointer flex items-center justify-center gap-2 ${
              activeTab === 'reports'
                ? 'bg-white text-[#171719] shadow-2xs font-semibold'
                : 'text-[#85858a] hover:text-[#171719]'
            }`}
          >
            <FileText className="w-4 h-4 text-[#f5a30a]" />
            <span>Generate Reports</span>
            <span className="text-[10px] px-1.5 py-0.2 bg-[#fff5e7] text-[#f5a30a] rounded-full font-bold">
              PDF & Excel
            </span>
          </button>
        </div>

        <div className="text-xs text-[#85858a] px-2 font-medium hidden md:block">
          {activeTab === 'students' && 'Showing student clock-in history and parent notifications'}
          {activeTab === 'teachers' && 'Showing faculty entry logs and arrival times'}
          {activeTab === 'reports' && 'Class registers, custom date reports, PDF & Excel export'}
        </div>

      </div>

      {/* TAB 1: STUDENTS ATTENDANCE VIEW */}
      {activeTab === 'students' && (
        <div className="space-y-6">
          {/* Filter and Search Controls */}
          <div className="bg-white border border-[#e7e7ea] p-4 rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
            <div className="flex flex-col sm:flex-row items-center gap-2.5 flex-1">
              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#929297]" />
                <input
                  type="text"
                  placeholder="Search student by name..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full h-9 pl-8 pr-3 text-xs border border-[#e1e1e5] rounded-[9px] bg-[#fafafa] focus:bg-white text-[#171719] placeholder:text-[#96969b] focus:outline-none focus:border-[#007aff] transition"
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={() => setSearchTerm('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#929297] hover:text-[#171719]"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Class Filter Dropdown */}
              <div className="w-full sm:w-auto">
                <select
                  value={classFilter}
                  onChange={(e) => setClassFilter(e.target.value)}
                  className="w-full sm:w-auto h-9 px-3 text-xs border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff] transition font-medium cursor-pointer"
                >
                  <option value="all">All Classes ({classes.length})</option>
                  {classes.map(cls => (
                    <option key={cls.id} value={cls.id}>
                      Class: {cls.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-2 justify-between lg:justify-end">
              <div className="flex items-center gap-1 bg-[#f5f5f7] p-1 rounded-[9px] border border-[#e7e7ea] text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setStatusFilter('all')}
                  className={`px-3 py-1 rounded-[6px] transition text-xs font-medium cursor-pointer ${
                    statusFilter === 'all'
                      ? 'bg-white text-[#171719] shadow-2xs font-semibold'
                      : 'text-[#85858a] hover:text-[#171719]'
                  }`}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('present')}
                  className={`px-3 py-1 rounded-[6px] transition text-xs font-medium cursor-pointer ${
                    statusFilter === 'present'
                      ? 'bg-white text-[#30b357] shadow-2xs font-semibold'
                      : 'text-[#85858a] hover:text-[#171719]'
                  }`}
                >
                  Present
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('late')}
                  className={`px-3 py-1 rounded-[6px] transition text-xs font-medium cursor-pointer ${
                    statusFilter === 'late'
                      ? 'bg-white text-[#f5a30a] shadow-2xs font-semibold'
                      : 'text-[#85858a] hover:text-[#171719]'
                  }`}
                >
                  Late
                </button>
              </div>

              {(searchTerm || statusFilter !== 'all' || classFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchTerm('');
                    setStatusFilter('all');
                    setClassFilter('all');
                  }}
                  className="h-9 px-2.5 border border-[#e1e1e5] rounded-[9px] bg-white hover:bg-[#f7f7f8] text-[#85858a] hover:text-[#171719] text-xs transition cursor-pointer"
                  title="Reset all filters"
                >
                  Reset
                </button>
              )}

              <button
                type="button"
                onClick={loadData}
                className="w-9 h-9 border border-[#e1e1e5] rounded-[9px] bg-white hover:bg-[#f7f7f8] text-[#5e5e63] transition flex items-center justify-center cursor-pointer shadow-2xs"
                title="Refresh student logs"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Logs Grouped by Date */}
          <div className="space-y-4">
            {groupedStudentLogs.length > 1 && (
              <div className="flex items-center justify-between px-1">
                <span className="text-xs text-[#85858a] font-medium">
                  {groupedStudentLogs.length} attendance dates recorded
                </span>
                <div className="flex items-center gap-1.5 bg-[#f5f5f7] border border-[#e7e7ea] p-1 rounded-lg text-xs">
                  <button
                    type="button"
                    onClick={expandAllStudentDates}
                    className="px-2 py-0.5 rounded text-[#5e5e63] hover:text-[#171719] hover:bg-white transition cursor-pointer font-medium"
                  >
                    Expand all
                  </button>
                  <span className="text-[#d1d1d6]">&middot;</span>
                  <button
                    type="button"
                    onClick={collapseAllStudentDates}
                    className="px-2 py-0.5 rounded text-[#5e5e63] hover:text-[#171719] hover:bg-white transition cursor-pointer font-medium"
                  >
                    Collapse all
                  </button>
                </div>
              </div>
            )}

            {groupedStudentLogs.length > 0 ? (
              groupedStudentLogs.map((group) => {
                const isOpen = !collapsedStudentDateKeys.has(group.dateKey);

                return (
                  <div 
                    key={group.dateKey} 
                    className="bg-white border border-[#e7e7ea] rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] overflow-hidden transition-all duration-200"
                  >
                    {/* Foldable Date Header */}
                    <button
                      type="button"
                      onClick={() => toggleStudentDateKey(group.dateKey)}
                      className={`w-full px-5 py-3.5 bg-[#fafafa] hover:bg-[#f4f4f7] transition flex flex-wrap items-center justify-between gap-3 text-left cursor-pointer select-none ${
                        isOpen ? 'border-b border-[#f1f1f4]' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-md bg-white border border-[#e7e7ea] flex items-center justify-center text-[#5e5e63] shrink-0">
                          {isOpen ? (
                            <ChevronDown className="w-3.5 h-3.5 text-[#171719] transition-transform duration-200" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-[#85858a] transition-transform duration-200" />
                          )}
                        </div>
                        <Calendar className="w-4 h-4 text-[#85858a]" />
                        <h2 className="font-bold text-xs text-[#171719]" suppressHydrationWarning>
                          {group.label}
                        </h2>
                        {group.badge && (
                          <span className="px-2 py-0.5 text-[10px] font-semibold bg-[#edf5ff] text-[#007aff] rounded-full">
                            {group.badge}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-xs">
                        <span className="px-2.5 py-0.5 bg-white rounded-md border border-[#e7e7ea] text-[#85858a] text-[11px]">
                          Total: <strong className="text-[#171719]">{group.logs.length}</strong>
                        </span>
                        <span className="px-2.5 py-0.5 bg-[#edf9f0] border border-[#d2f4d9] text-[#2da94f] rounded-md text-[11px]">
                          Present: <strong>{group.presentCount}</strong>
                        </span>
                        {group.lateCount > 0 && (
                          <span className="px-2.5 py-0.5 bg-[#fff5e7] border border-[#ffe0b2] text-[#f5a30a] rounded-md text-[11px]">
                            Late: <strong>{group.lateCount}</strong>
                          </span>
                        )}
                        <span className="text-[11px] text-[#85858a] pl-1 font-medium hidden sm:inline">
                          {isOpen ? 'Click to fold' : 'Click to unfold'}
                        </span>
                      </div>
                    </button>

                    {/* Table Container with Horizontal Scrolling */}
                    {isOpen && (
                      <div className="w-full overflow-x-auto animate-fade-in">
                        <table className="w-full min-w-[760px] text-left text-xs border-collapse">
                          <thead>
                            <tr className="border-b border-[#f1f1f4] text-[10px] uppercase font-semibold tracking-wider text-[#929297]">
                              <th className="py-3 px-5 whitespace-nowrap">Student</th>
                              <th className="py-3 px-4 whitespace-nowrap">Time Entered</th>
                              <th className="py-3 px-4 whitespace-nowrap">Status</th>
                              <th className="py-3 px-4 whitespace-nowrap">Check-In Type</th>
                              <th className="py-3 px-5 whitespace-nowrap text-right">Parent SMS Notification</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#f7f7f9]">
                            {group.logs.map((log) => {
                              const logTime = formatEATTime(log.occurred_at, { hour: '2-digit', minute: '2-digit' });
                              
                              const personName = log.people?.full_name || 'Student';
                              const initials = personName
                                .split(' ')
                                .map((n: string) => n[0])
                                .join('')
                                .substring(0, 2)
                                .toUpperCase();

                              return (
                                <tr key={log.id} className="hover:bg-[#fbfbfd] transition">
                                  <td className="py-3 px-5 whitespace-nowrap">
                                    <div className="flex items-center gap-2.5">
                                      <div className="w-7 h-7 rounded-full bg-[#f0f0f3] text-[#555] flex items-center justify-center font-bold text-[10px]">
                                        {initials}
                                      </div>
                                      <div>
                                        <div className="font-semibold text-[#171719] text-xs">{personName}</div>
                                        <div className="text-[10px] text-[#929297]">
                                          {log.people?.classes?.name || 'Class Student'}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                  
                                  <td className="py-3 px-4 whitespace-nowrap font-mono text-[11px] text-[#171719]" suppressHydrationWarning>
                                    {logTime}
                                  </td>
                                  
                                  <td className="py-3 px-4 whitespace-nowrap">
                                    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-medium ${
                                      log.status === 'present'
                                        ? 'bg-[#edf9f0] text-[#2da94f]'
                                        : log.status === 'late'
                                        ? 'bg-[#fff5e7] text-[#f5a30a]'
                                        : 'bg-[#fff0ef] text-[#ef4444]'
                                    }`}>
                                      <span className={`w-1.5 h-1.5 rounded-full ${
                                        log.status === 'present' ? 'bg-[#30b357]' : log.status === 'late' ? 'bg-[#f5a30a]' : 'bg-[#ef4444]'
                                      }`} />
                                      <span className="capitalize">{log.status}</span>
                                    </span>
                                  </td>

                                  <td className="py-3 px-4 whitespace-nowrap text-xs text-[#5e5e63]">
                                    <span className="capitalize">{(log.attendance_type || 'check_in').replace(/_/g, ' ')}</span>
                                  </td>

                                  <td className="py-3 px-5 whitespace-nowrap text-right">
                                    <div className="inline-flex items-center gap-1.5 text-xs text-[#2da94f] font-medium bg-[#edf9f0] px-2.5 py-0.5 rounded-full">
                                      <Send className="w-3 h-3 text-[#30b357]" />
                                      <span>SMS Delivered</span>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="bg-white border border-[#e7e7ea] rounded-[14px] p-12 text-center shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-2">
                <Clock className="w-8 h-8 text-[#929297] mx-auto" />
                <h3 className="text-sm font-bold text-[#171719]">No student attendance logs found</h3>
                <p className="text-xs text-[#85858a] max-w-sm mx-auto">
                  {searchTerm || statusFilter !== 'all' 
                    ? 'Try adjusting your search query or status filter.'
                    : 'Clock-in entries recorded via biometric terminal or teacher registers will appear here grouped by day.'}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: TEACHERS ATTENDANCE VIEW */}
      {activeTab === 'teachers' && (
        <TeacherAttendanceManager 
          logs={logs}
          teachers={teachersList}
          onRefresh={loadData}
        />
      )}

      {/* TAB 3: GENERATE REPORTS */}
      {activeTab === 'reports' && (
        <AttendanceReports 
          logs={logs}
          people={people}
          classes={classes}
          schoolName={school?.name || 'Na\'Jiki Academy'}
        />
      )}

      {/* Top Up Modal */}
      {showTopUpModal && (
        <div className="fixed inset-0 z-50 bg-[#171719]/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-[#e7e7ea] rounded-[16px] max-w-md w-full p-6 shadow-2xl space-y-4 relative animate-fade-in">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-[#f1f1f4]">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-full bg-[#edf5ff] border border-[#d6e7ff] flex items-center justify-center text-[#007aff]">
                  {topUpStep === 'waiting' ? (
                    <Smartphone className="w-5 h-5 animate-pulse" />
                  ) : topUpStep === 'success' ? (
                    <CheckCircle2 className="w-5 h-5 text-[#30b357]" />
                  ) : (
                    <CreditCard className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <h3 className="text-base font-bold text-[#171719]">
                    {topUpStep === 'waiting' 
                      ? 'Enter PIN on Mobile Phone' 
                      : topUpStep === 'success' 
                        ? 'Payment Approved' 
                        : 'Top Up SMS Balance'}
                  </h3>
                  <p className="text-[11px] text-[#85858a]">
                    {topUpStep === 'waiting'
                      ? 'Authorization prompt dispatched to your device'
                      : topUpStep === 'success'
                        ? 'Funds successfully added to school wallet'
                        : 'Add funds to send automated parent notifications'}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowTopUpModal(false)}
                className="p-1 rounded-lg text-[#929297] hover:text-[#171719] transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Current Balance Summary Banner */}
            <div className="bg-[#f7f7f9] text-[#171719] p-3.5 rounded-[11px] border border-[#e7e7ea] flex items-center justify-between">
              <div>
                <div className="text-[10px] font-semibold text-[#85858a] uppercase">Current Balance</div>
                <div className="text-base font-bold font-mono text-[#171719]">
                  {currentBalance.toLocaleString()} <span className="text-xs font-normal text-[#85858a]">UGX</span>
                </div>
              </div>
              <div className="text-right text-xs font-medium text-[#30b357]">
                ~{approxSMSCount.toLocaleString()} SMS
              </div>
            </div>

            {/* ERROR ALERT IF ANY */}
            {error && (
              <div className="bg-[#fff0ef] border border-[#fbd1cf] text-[#ef4444] text-xs p-3 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* STEP 1: FORM */}
            {topUpStep === 'form' && (
              <form onSubmit={handleTopUpSubmit} className="space-y-4">
                <div>
                  <label className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                    Select Quick Amount (UGX)
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[10000, 20000, 50000, 100000, 200000, 500000].map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        onClick={() => handleQuickAmount(amount)}
                        className={`py-2 px-2 text-xs font-medium rounded-[8px] border transition cursor-pointer ${
                          topUpAmount === amount.toString()
                            ? 'bg-[#007aff] text-white border-[#007aff] font-bold shadow-2xs'
                            : 'bg-white border-[#e1e1e5] text-[#171719] hover:border-[#cfcfd4]'
                        }`}
                      >
                        {amount.toLocaleString()}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label htmlFor="topup-amount" className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                    Custom Amount (UGX)
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      id="topup-amount"
                      min="1000"
                      step="1000"
                      required
                      value={topUpAmount}
                      onChange={(e) => setTopUpAmount(e.target.value)}
                      className="block w-full px-3 py-2 border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] text-xs font-mono focus:border-[#007aff] focus:outline-none transition"
                      placeholder="50000"
                    />
                  </div>
                  <p className="text-[10px] text-[#85858a] mt-1 flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-[#f5a30a]" />
                    Provides approx {Math.floor((parseInt(topUpAmount) || 0) / 50).toLocaleString()} SMS messages to parents.
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="phone-number" className="block text-[11px] font-semibold text-[#171719]">
                      Mobile Money Phone Number
                    </label>
                    <span className="text-[10px] font-medium text-[#5e5e63] bg-[#f2f2f4] px-1.5 py-0.5 rounded">
                      MTN & Airtel Uganda
                    </span>
                  </div>
                  <div className="relative">
                    <input
                      type="tel"
                      id="phone-number"
                      required
                      value={phoneNumber}
                      onChange={(e) => setPhoneNumber(e.target.value)}
                      className="block w-full px-3 py-2 border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] text-xs font-mono focus:border-[#007aff] focus:outline-none transition"
                      placeholder="0770 000 000 or 0700 000 000"
                    />
                  </div>
                  <p className="text-[10px] text-[#85858a] mt-1 flex items-center gap-1">
                    <span>Supports 077/078/076 (MTN) and 070/075/074 (Airtel). PIN prompt will appear automatically.</span>
                  </p>
                </div>

                <div className="pt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowTopUpModal(false)}
                    className="flex-1 h-9 border border-[#e1e1e5] rounded-[8px] text-xs font-medium text-[#5e5e63] hover:bg-[#f7f7f8] transition cursor-pointer"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={isToppingUp}
                    className="flex-1 h-9 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-[8px] text-xs font-medium shadow-2xs transition flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    {isToppingUp ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Sending Request...</span>
                      </>
                    ) : (
                      <>
                        <span>Confirm Top Up</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}

            {/* STEP 2: WAITING */}
            {topUpStep === 'waiting' && (
              <div className="space-y-4 py-2 animate-fade-in text-center">
                <div className="w-14 h-14 rounded-full bg-[#edf5ff] border border-[#d6e7ff] flex items-center justify-center text-[#007aff] mx-auto shadow-2xs">
                  <Smartphone className="w-6 h-6 animate-pulse" />
                </div>

                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-[#171719]">
                    Check Phone: Enter Mobile Money PIN
                  </h4>
                  <p className="text-xs text-[#5e5e63] max-w-xs mx-auto leading-relaxed">
                    A payment prompt of <strong className="text-[#171719] font-mono">{parseInt(topUpAmount).toLocaleString()} UGX</strong> has been sent to <strong className="text-[#171719] font-mono">{phoneNumber}</strong>.
                  </p>
                </div>

                <div className="bg-[#f7f7f9] border border-[#e7e7ea] rounded-[10px] p-3 text-left text-xs space-y-1.5 text-[#5e5e63]">
                  <div className="font-semibold text-[#171719] text-[11px] flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-[#30b357]" />
                    <span>How to complete payment:</span>
                  </div>
                  <ol className="list-decimal list-inside space-y-1 text-[11px] text-[#85858a]">
                    <li>Unlock your mobile phone screen.</li>
                    <li>Enter your Mobile Money PIN when prompted.</li>
                    <li>Wait a moment for automatic confirmation.</li>
                  </ol>
                </div>

                <div className="flex items-center justify-center gap-2 text-xs font-mono text-[#007aff] bg-[#edf5ff] py-2 px-3 rounded-[9px] border border-[#d6e7ff]">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>Listening for payment confirmation...</span>
                </div>

                <div className="pt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowTopUpModal(false)}
                    className="flex-1 h-9 border border-[#e1e1e5] rounded-[8px] text-xs font-medium text-[#85858a] hover:bg-[#f7f7f8] transition cursor-pointer"
                  >
                    Close Window
                  </button>

                  <button
                    type="button"
                    onClick={() => loadData()}
                    className="flex-1 h-9 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-[8px] text-xs font-medium shadow-2xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Check Balance</span>
                  </button>
                </div>
              </div>
            )}

            {/* STEP 3: SUCCESS */}
            {topUpStep === 'success' && (
              <div className="space-y-4 py-3 animate-fade-in text-center">
                <div className="w-12 h-12 bg-[#edf9f0] border border-[#d2f4d9] rounded-full flex items-center justify-center text-[#30b357] mx-auto shadow-2xs">
                  <CheckCircle2 className="w-6 h-6" />
                </div>

                <div className="space-y-1">
                  <h4 className="text-base font-bold text-[#171719]">
                    Top Up Successful!
                  </h4>
                  <p className="text-xs text-[#30b357] font-medium">
                    {topUpMessage || `Successfully added ${parseInt(topUpAmount).toLocaleString()} UGX to school balance.`}
                  </p>
                </div>

                <div className="bg-[#edf9f0] border border-[#d2f4d9] rounded-[10px] p-3 text-xs text-[#2da94f]">
                  <span>Your new school SMS balance is </span>
                  <strong className="font-mono text-sm">{currentBalance.toLocaleString()} UGX</strong>.
                </div>

                <button
                  type="button"
                  onClick={() => setShowTopUpModal(false)}
                  className="w-full h-9 bg-[#171719] hover:bg-[#2c2c2e] text-white rounded-[8px] text-xs font-medium transition cursor-pointer"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
