'use client';

import React, { useState, useMemo, useTransition } from 'react';
import { 
  Briefcase, 
  Clock, 
  Search, 
  Calendar, 
  RefreshCw, 
  X,
  Plus,
  Check,
  UserCheck,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import { markTeacherAttendanceAction } from './actions';
import { formatEATTime, formatEATDate, getEATDateKey } from '@/lib/eat-time';

interface TeacherAttendanceManagerProps {
  logs: any[];
  teachers: any[];
  onRefresh: () => void;
}

export default function TeacherAttendanceManager({
  logs,
  teachers,
  onRefresh
}: TeacherAttendanceManagerProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'present' | 'late'>('all');
  const [showManualModal, setShowManualModal] = useState(false);
  const [selectedTeacherId, setSelectedTeacherId] = useState('');
  const [manualStatus, setManualStatus] = useState<'present' | 'late'>('present');
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Foldable state (empty set = all groups expanded by default)
  const [collapsedTeacherDateKeys, setCollapsedTeacherDateKeys] = useState<Set<string>>(() => new Set());

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTeacherId) {
      setActionError('Please select a teacher.');
      return;
    }

    setActionError(null);
    setActionSuccess(null);

    startTransition(async () => {
      try {
        const res = await markTeacherAttendanceAction(selectedTeacherId, manualStatus);
        if (res && res.error) {
          setActionError(res.error);
        } else {
          setActionSuccess('Teacher attendance recorded successfully!');
          setSelectedTeacherId('');
          onRefresh();
          setTimeout(() => {
            setShowManualModal(false);
            setActionSuccess(null);
          }, 1200);
        }
      } catch (err: any) {
        setActionError(err.message || 'Failed to record attendance.');
      }
    });
  };

  // Filter logs for teachers/staff only
  const teacherLogs = useMemo(() => {
    return logs.filter(log => {
      const role = log.people?.role;
      return role === 'teacher' || role === 'admin' || role === 'support_staff';
    });
  }, [logs]);

  // Filtered by search and status
  const filteredTeacherLogs = useMemo(() => {
    return teacherLogs.filter(log => {
      const name = log.people?.full_name || '';
      const phone = log.people?.phone || '';
      const uid = log.people?.device_user_id || '';
      const q = searchTerm.toLowerCase();

      const matchesSearch = 
        name.toLowerCase().includes(q) ||
        phone.toLowerCase().includes(q) ||
        uid.toLowerCase().includes(q);

      const matchesStatus = statusFilter === 'all' || log.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [teacherLogs, searchTerm, statusFilter]);

  // Group logs by date in East Africa Time (YYYY-MM-DD)
  const groupedTeacherLogs = useMemo(() => {
    const map: { [key: string]: any[] } = {};

    filteredTeacherLogs.forEach(log => {
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
  }, [filteredTeacherLogs]);

  const toggleTeacherDateKey = (dateKey: string) => {
    setCollapsedTeacherDateKeys((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) {
        next.delete(dateKey); // Unfold
      } else {
        next.add(dateKey); // Fold
      }
      return next;
    });
  };

  const expandAllTeacherDates = () => {
    setCollapsedTeacherDateKeys(new Set());
  };

  const collapseAllTeacherDates = () => {
    setCollapsedTeacherDateKeys(new Set(groupedTeacherLogs.map(g => g.dateKey)));
  };

  return (
    <div className="space-y-6">
      
      {/* Filter and Action Bar */}
      <div className="bg-white border border-[#e7e7ea] p-4 rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#929297]" />
          <input
            type="text"
            placeholder="Search teacher by name or UID..."
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

        <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
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

          <button
            type="button"
            onClick={() => setShowManualModal(true)}
            className="h-9 px-3 bg-[#007aff] hover:bg-[#0062cc] text-white text-xs font-medium rounded-[9px] transition flex items-center gap-1.5 cursor-pointer shadow-2xs"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Clock In Faculty</span>
          </button>

          <button
            type="button"
            onClick={onRefresh}
            className="w-9 h-9 border border-[#e1e1e5] rounded-[9px] bg-white hover:bg-[#f7f7f8] text-[#5e5e63] transition flex items-center justify-center cursor-pointer shadow-2xs"
            title="Refresh faculty attendance logs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Manual Clock In Modal */}
      {showManualModal && (
        <div className="fixed inset-0 z-50 bg-[#171719]/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-[#e7e7ea] rounded-[16px] max-w-md w-full p-6 shadow-xl animate-fade-in space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#f1f1f4]">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-[#edf5ff] text-[#007aff] flex items-center justify-center">
                  <UserCheck className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#171719]">Record Faculty Attendance</h3>
                  <p className="text-[11px] text-[#85858a]">Log entry for faculty or staff member</p>
                </div>
              </div>
              <button 
                onClick={() => {
                  setShowManualModal(false);
                  setActionError(null);
                  setActionSuccess(null);
                }} 
                className="p-1 text-[#929297] hover:text-[#171719]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {actionError && (
              <div className="p-3 text-xs text-[#ef4444] bg-[#fff0ef] rounded-[9px] border border-[#fbd1cf] flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{actionError}</span>
              </div>
            )}

            {actionSuccess && (
              <div className="p-3 text-xs text-[#2da94f] bg-[#edf9f0] rounded-[9px] border border-[#d2f4d9] flex items-center gap-2">
                <Check className="w-4 h-4 shrink-0" />
                <span>{actionSuccess}</span>
              </div>
            )}

            <form onSubmit={handleManualSubmit} className="space-y-4">
              <div>
                <label className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                  Select Faculty Member
                </label>
                <select
                  value={selectedTeacherId}
                  onChange={(e) => setSelectedTeacherId(e.target.value)}
                  required
                  disabled={isPending}
                  className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs rounded-[9px] focus:outline-none focus:border-[#007aff] transition text-[#171719]"
                >
                  <option value="">-- Choose Faculty Member --</option>
                  {teachers.map((t: any) => (
                    <option key={t.id} value={t.id}>
                      {t.full_name} {t.device_user_id ? `(UID: ${t.device_user_id})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                  Status
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setManualStatus('present')}
                    className={`h-9 rounded-[8px] text-xs font-medium border transition flex items-center justify-center gap-1.5 ${
                      manualStatus === 'present'
                        ? 'bg-[#edf9f0] border-[#30b357] text-[#2da94f] font-semibold'
                        : 'bg-white border-[#e1e1e5] text-[#5e5e63] hover:bg-[#fafafa]'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-[#30b357]" />
                    <span>On-Time (Present)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualStatus('late')}
                    className={`h-9 rounded-[8px] text-xs font-medium border transition flex items-center justify-center gap-1.5 ${
                      manualStatus === 'late'
                        ? 'bg-[#fff5e7] border-[#f5a30a] text-[#d97706] font-semibold'
                        : 'bg-white border-[#e1e1e5] text-[#5e5e63] hover:bg-[#fafafa]'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-[#f5a30a]" />
                    <span>Late Arrival</span>
                  </button>
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowManualModal(false)}
                  disabled={isPending}
                  className="h-9 px-3.5 border border-[#e1e1e5] hover:bg-[#f7f7f8] rounded-[9px] text-xs text-[#5e5e63] font-medium transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="h-9 px-4 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-[9px] text-xs font-medium transition flex items-center gap-1.5 cursor-pointer shadow-2xs disabled:opacity-60"
                >
                  {isPending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Save Attendance</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Date-Grouped Teacher Attendance Logs */}
      <div className="space-y-4">
        {groupedTeacherLogs.length > 1 && (
          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-[#85858a] font-medium">
              {groupedTeacherLogs.length} faculty attendance dates recorded
            </span>
            <div className="flex items-center gap-1.5 bg-[#f5f5f7] border border-[#e7e7ea] p-1 rounded-lg text-xs">
              <button
                type="button"
                onClick={expandAllTeacherDates}
                className="px-2 py-0.5 rounded text-[#5e5e63] hover:text-[#171719] hover:bg-white transition cursor-pointer font-medium"
              >
                Expand all
              </button>
              <span className="text-[#d1d1d6]">&middot;</span>
              <button
                type="button"
                onClick={collapseAllTeacherDates}
                className="px-2 py-0.5 rounded text-[#5e5e63] hover:text-[#171719] hover:bg-white transition cursor-pointer font-medium"
              >
                Collapse all
              </button>
            </div>
          </div>
        )}

        {groupedTeacherLogs.length > 0 ? (
          groupedTeacherLogs.map((group) => {
            const isOpen = !collapsedTeacherDateKeys.has(group.dateKey);

            return (
              <div 
                key={group.dateKey} 
                className="bg-white border border-[#e7e7ea] rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] overflow-hidden transition-all duration-200"
              >
                {/* Foldable Date Header */}
                <button
                  type="button"
                  onClick={() => toggleTeacherDateKey(group.dateKey)}
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
                      Total Checked-In: <strong className="text-[#171719]">{group.logs.length}</strong>
                    </span>
                    <span className="px-2.5 py-0.5 bg-[#edf9f0] border border-[#d2f4d9] text-[#2da94f] rounded-md text-[11px]">
                      On-Time: <strong>{group.presentCount}</strong>
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
                          <th className="py-3 px-5 whitespace-nowrap">Faculty Member</th>
                          <th className="py-3 px-4 whitespace-nowrap">Time Entered</th>
                          <th className="py-3 px-4 whitespace-nowrap">Status</th>
                          <th className="py-3 px-4 whitespace-nowrap">Verification Source</th>
                          <th className="py-3 px-4 whitespace-nowrap">Hardware UID</th>
                          <th className="py-3 px-5 whitespace-nowrap text-right">Contact Phone</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#f7f7f9]">
                        {group.logs.map((log) => {
                          const logTime = formatEATTime(log.occurred_at, { hour: '2-digit', minute: '2-digit' });
                          
                          const personName = log.people?.full_name || 'Faculty Member';
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
                                  <div className="w-7 h-7 rounded-full bg-[#171719] text-white flex items-center justify-center font-bold text-[10px]">
                                    {initials}
                                  </div>
                                  <div>
                                    <div className="font-semibold text-[#171719] text-xs">{personName}</div>
                                    <div className="text-[10px] text-[#007aff] font-medium capitalize">
                                      {log.people?.role === 'admin'
                                        ? 'School Administrator'
                                        : log.people?.role === 'support_staff'
                                        ? 'Support Staff'
                                        : 'Teacher / Faculty'}
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
                                  <span className="capitalize">{log.status === 'present' ? 'On-Time' : 'Late Arrival'}</span>
                                </span>
                              </td>

                              <td className="py-3 px-4 whitespace-nowrap text-xs text-[#5e5e63]">
                                <span className="capitalize">
                                  {(log.attendance_type || 'ZKTeco Clock-In').replace(/_/g, ' ')}
                                </span>
                              </td>

                              <td className="py-3 px-4 whitespace-nowrap font-mono text-[11px] text-[#85858a]">
                                {log.people?.device_user_id || 'ZK-100'}
                              </td>

                              <td className="py-3 px-5 whitespace-nowrap text-right text-xs text-[#85858a] font-mono">
                                {log.people?.phone || '—'}
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
            <Briefcase className="w-8 h-8 text-[#929297] mx-auto" />
            <h3 className="text-sm font-bold text-[#171719]">No teacher attendance recorded yet</h3>
            <p className="text-xs text-[#85858a] max-w-sm mx-auto">
              {searchTerm || statusFilter !== 'all' 
                ? 'Try adjusting your search query or status filter.'
                : 'Teachers clocking in via the biometric scanner, kiosk terminal, or manual register will automatically appear here grouped by day.'}
            </p>
            <div className="pt-2">
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
