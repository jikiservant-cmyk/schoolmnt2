'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  verifyTeacherPin, 
  getStudentsForClass, 
  submitClassAttendance,
  type StudentAttendanceStatus 
} from './actions';
import { 
  ShieldAlert, 
  CheckCircle2, 
  Circle, 
  Loader2, 
  ArrowRight, 
  UserCheck, 
  Search, 
  X, 
  Clock, 
  Sunrise, 
  Sunset,
  RefreshCw,
  Check,
  Radio
} from 'lucide-react';
import { useParams } from 'next/navigation';

export default function ManualAttendancePage() {
  const params = useParams();
  const classId = params.classId as string;

  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [teacher, setTeacher] = useState<{ id: string; full_name: string } | null>(null);
  
  const [students, setStudents] = useState<StudentAttendanceStatus[]>([]);
  const [activeMode, setActiveMode] = useState<'check_in' | 'check_out'>('check_in');
  const [newlySelectedIds, setNewlySelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'unmarked' | 'marked'>('all');
  
  const [submitting, setSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'info' | 'error'; message: string } | null>(null);

  const fetchStudents = useCallback(async (isInitial = false) => {
    if (!classId) return;
    if (!isInitial) setIsRefreshing(true);
    try {
      const res = await getStudentsForClass(classId);
      if (res.students) {
        setStudents(res.students);
        setLastRefreshedAt(new Date());
        if (isInitial && res.activeWindowMode) {
          setActiveMode(res.activeWindowMode);
        }

        // Prune any newlySelectedIds that have since been marked (e.g. via biometric device or other teacher)
        setNewlySelectedIds(prev => {
          if (prev.size === 0) return prev;
          const next = new Set(prev);
          for (const s of res.students) {
            const isMarkedInActiveMode = activeMode === 'check_in' ? s.has_checked_in : s.has_checked_out;
            if (isMarkedInActiveMode && next.has(s.id)) {
              next.delete(s.id);
            }
          }
          return next;
        });
      } else if (isInitial) {
        setError(res.error || 'Failed to load students.');
      }
    } catch {
      if (isInitial) {
        setError('Failed to fetch class roster.');
      }
    } finally {
      if (!isInitial) setIsRefreshing(false);
    }
  }, [classId, activeMode]);

  // Real-time polling every 10 seconds once teacher is authenticated
  useEffect(() => {
    if (!teacher) return;

    // Set up 10-second interval
    const interval = setInterval(() => {
      fetchStudents(false);
    }, 10000);

    return () => clearInterval(interval);
  }, [teacher, fetchStudents]);

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin) return;
    
    setLoading(true);
    setError('');
    
    try {
      const res = await verifyTeacherPin(classId, pin);
      if (res.success && res.teacher) {
        setTeacher(res.teacher);
        await fetchStudents(true);
      } else {
        setError(res.error || 'Invalid PIN');
      }
    } catch {
      setError('A network error occurred.');
    } finally {
      setLoading(false);
    }
  };

  // Determine which students are already marked for the current activeMode
  const alreadyMarkedMap = useMemo(() => {
    const map = new Map<string, { marked: boolean; time: string | null; status: 'present' | 'late' | null }>();
    for (const student of students) {
      if (activeMode === 'check_in') {
        map.set(student.id, {
          marked: student.has_checked_in,
          time: student.check_in_time,
          status: student.check_in_status,
        });
      } else {
        map.set(student.id, {
          marked: student.has_checked_out,
          time: student.check_out_time,
          status: 'present',
        });
      }
    }
    return map;
  }, [students, activeMode]);

  const alreadyMarkedCount = useMemo(() => {
    let count = 0;
    for (const info of alreadyMarkedMap.values()) {
      if (info.marked) count++;
    }
    return count;
  }, [alreadyMarkedMap]);

  // Unmarked students available for selection
  const unmarkedStudents = useMemo(() => {
    return students.filter(s => !alreadyMarkedMap.get(s.id)?.marked);
  }, [students, alreadyMarkedMap]);

  const filteredStudents = useMemo(() => {
    return students.filter(student => {
      const info = alreadyMarkedMap.get(student.id);
      if (filterTab === 'unmarked' && info?.marked) return false;
      if (filterTab === 'marked' && !info?.marked) return false;

      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      return (
        student.full_name.toLowerCase().includes(q) ||
        (student.device_user_id && student.device_user_id.toLowerCase().includes(q))
      );
    });
  }, [students, alreadyMarkedMap, filterTab, searchQuery]);

  const toggleStudent = (id: string) => {
    const isAlreadyMarked = alreadyMarkedMap.get(id)?.marked;
    if (isAlreadyMarked) return; // Cannot toggle students who are already marked

    setNewlySelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAllUnmarked = () => {
    const next = new Set<string>();
    for (const s of filteredStudents) {
      if (!alreadyMarkedMap.get(s.id)?.marked) {
        next.add(s.id);
      }
    }
    setNewlySelectedIds(next);
  };

  const handleClearSelection = () => {
    setNewlySelectedIds(new Set());
  };

  const handleSubmitAttendance = async () => {
    if (!teacher) return;
    if (newlySelectedIds.size === 0) {
      setFeedback({ type: 'info', message: 'No new students selected to mark.' });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    try {
      const presentIds = Array.from(newlySelectedIds);
      const res = await submitClassAttendance(
        classId,
        teacher.id,
        presentIds,
        [],
        activeMode
      );

      if (res.success) {
        setFeedback({
          type: 'success',
          message: res.skipped 
            ? (res.message || 'Students already marked.')
            : `Successfully recorded ${res.count} student(s) for ${activeMode === 'check_in' ? 'Morning Check-In' : 'Evening Check-Out'}.`
        });
        setNewlySelectedIds(new Set());
        await fetchStudents(false);
      } else {
        setFeedback({
          type: 'error',
          message: res.error || 'Failed to submit attendance.'
        });
      }
    } catch {
      setFeedback({ type: 'error', message: 'A network error occurred.' });
    } finally {
      setSubmitting(false);
    }
  };

  if (!teacher) {
    return (
      <div className="min-h-screen bg-meridian-background flex flex-col items-center justify-center p-6 font-sans">
        <div className="w-full max-w-md bg-meridian-panel border border-meridian-border rounded-2xl p-8 shadow-xl">
          <div className="text-center mb-8">
            <div className="mx-auto w-12 h-12 bg-meridian-background border border-meridian-border rounded-xl flex items-center justify-center mb-4">
              <UserCheck className="w-6 h-6 text-meridian-gold" />
            </div>
            <h1 className="font-serif text-2xl text-meridian-text-1 font-medium tracking-tight">Teacher Authentication</h1>
            <p className="text-sm text-meridian-text-3 mt-1">Enter your Teacher PIN to open class attendance register</p>
          </div>

          <form onSubmit={handlePinSubmit} className="space-y-4">
            <div>
              <input
                type="password"
                placeholder="Enter your PIN..."
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                className="w-full bg-meridian-background border border-meridian-border rounded-xl px-4 py-3 text-center text-xl tracking-[0.5em] text-meridian-text-1 focus:outline-none focus:border-meridian-gold transition-colors"
                maxLength={8}
                autoFocus
              />
            </div>
            
            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !pin}
              className="w-full py-3 bg-meridian-gold text-meridian-background rounded-xl font-medium tracking-wide flex items-center justify-center gap-2 hover:bg-meridian-gold-dim transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Authenticate'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-meridian-background flex flex-col font-sans">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-meridian-panel/90 backdrop-blur-md border-b border-meridian-border px-6 py-4">
        <div className="max-w-3xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-serif text-xl text-meridian-text-1 font-medium">Class Attendance Register</h1>
              {/* Real-time sync badge */}
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-mono text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>Live (10s sync)</span>
                <button
                  type="button"
                  onClick={() => fetchStudents(false)}
                  title="Refresh now"
                  className="ml-1 text-emerald-300 hover:text-emerald-100 p-0.5 rounded"
                >
                  <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
            <p className="text-xs text-meridian-text-3 mt-0.5">Teacher: <span className="text-meridian-text-1 font-medium">{teacher.full_name}</span></p>
          </div>

          {/* Time Window Mode Selector */}
          <div className="flex items-center bg-meridian-background border border-meridian-border rounded-xl p-1 gap-1">
            <button
              type="button"
              onClick={() => {
                setActiveMode('check_in');
                setNewlySelectedIds(new Set());
                setFeedback(null);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeMode === 'check_in'
                  ? 'bg-meridian-gold text-meridian-background font-semibold shadow-xs'
                  : 'text-meridian-text-3 hover:text-meridian-text-1'
              }`}
            >
              <Sunrise className="w-3.5 h-3.5" />
              <span>Morning (5 - 9 AM)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveMode('check_out');
                setNewlySelectedIds(new Set());
                setFeedback(null);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeMode === 'check_out'
                  ? 'bg-meridian-gold text-meridian-background font-semibold shadow-xs'
                  : 'text-meridian-text-3 hover:text-meridian-text-1'
              }`}
            >
              <Sunset className="w-3.5 h-3.5" />
              <span>Evening (4 - 10 PM)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-4 pb-32">
          {/* Feedback banner */}
          {feedback && (
            <div className={`p-4 rounded-xl border flex items-center justify-between gap-3 text-sm ${
              feedback.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : feedback.type === 'info'
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-300'
                : 'bg-red-500/10 border-red-500/30 text-red-300'
            }`}>
              <div className="flex items-center gap-2">
                {feedback.type === 'success' ? (
                  <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400" />
                ) : (
                  <ShieldAlert className="w-5 h-5 shrink-0" />
                )}
                <span>{feedback.message}</span>
              </div>
              <button 
                onClick={() => setFeedback(null)}
                className="text-xs opacity-70 hover:opacity-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Stats Bar & Filter Tabs */}
          <div className="bg-meridian-panel border border-meridian-border rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-meridian-text-3 font-mono">STATUS:</span>
                <span className="font-semibold text-meridian-text-1">
                  {alreadyMarkedCount} of {students.length} Marked
                </span>
              </div>
              {newlySelectedIds.size > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-md bg-meridian-gold/20 text-meridian-gold font-medium">
                  +{newlySelectedIds.size} new selected
                </span>
              )}
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => setFilterTab('all')}
                className={`px-3 py-1 rounded-lg transition-colors ${
                  filterTab === 'all'
                    ? 'bg-meridian-background text-meridian-text-1 border border-meridian-border font-medium'
                    : 'text-meridian-text-3 hover:text-meridian-text-2'
                }`}
              >
                All ({students.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('unmarked')}
                className={`px-3 py-1 rounded-lg transition-colors ${
                  filterTab === 'unmarked'
                    ? 'bg-meridian-background text-meridian-text-1 border border-meridian-border font-medium'
                    : 'text-meridian-text-3 hover:text-meridian-text-2'
                }`}
              >
                Unmarked ({unmarkedStudents.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('marked')}
                className={`px-3 py-1 rounded-lg transition-colors ${
                  filterTab === 'marked'
                    ? 'bg-meridian-background text-meridian-text-1 border border-meridian-border font-medium'
                    : 'text-meridian-text-3 hover:text-meridian-text-2'
                }`}
              >
                Marked ({alreadyMarkedCount})
              </button>
            </div>
          </div>

          {/* Search and Bulk Select */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-meridian-text-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Search student by name or ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-meridian-panel border border-meridian-border rounded-xl pl-10 pr-10 py-2.5 text-sm text-meridian-text-1 placeholder:text-meridian-text-3 focus:outline-none focus:border-meridian-gold transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-meridian-text-3 hover:text-meridian-text-1 p-1 rounded-md"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {unmarkedStudents.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSelectAllUnmarked}
                  className="px-3 py-2.5 bg-meridian-panel hover:bg-meridian-background border border-meridian-border rounded-xl text-xs text-meridian-text-2 font-medium transition-colors whitespace-nowrap"
                >
                  Select Unmarked
                </button>
                {newlySelectedIds.size > 0 && (
                  <button
                    type="button"
                    onClick={handleClearSelection}
                    className="px-3 py-2.5 bg-meridian-panel hover:bg-meridian-background border border-meridian-border rounded-xl text-xs text-meridian-text-3 hover:text-meridian-text-1 transition-colors whitespace-nowrap"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Student List */}
          {students.length === 0 ? (
            <div className="text-center py-12 bg-meridian-panel border border-meridian-border rounded-2xl text-meridian-text-3">
              No students found in this class.
            </div>
          ) : filteredStudents.length === 0 ? (
            <div className="text-center py-12 bg-meridian-panel border border-meridian-border rounded-2xl">
              <p className="text-meridian-text-2 font-medium">No students match your filter.</p>
              <button 
                onClick={() => { setSearchQuery(''); setFilterTab('all'); }}
                className="mt-2 text-xs text-meridian-gold hover:underline"
              >
                Reset filters
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {filteredStudents.map(student => {
                const markInfo = alreadyMarkedMap.get(student.id);
                const isAlreadyMarked = markInfo?.marked;
                const isNewlySelected = newlySelectedIds.has(student.id);

                return (
                  <div
                    key={student.id}
                    onClick={() => toggleStudent(student.id)}
                    className={`flex items-center justify-between p-4 rounded-xl border transition-all ${
                      isAlreadyMarked
                        ? 'bg-meridian-panel/80 border-meridian-gold/40 cursor-default opacity-95'
                        : isNewlySelected
                        ? 'bg-meridian-panel border-meridian-gold ring-1 ring-meridian-gold cursor-pointer'
                        : 'bg-meridian-panel/40 border-meridian-border hover:bg-meridian-panel/80 cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-meridian-background border border-meridian-border flex items-center justify-center text-xs font-semibold text-meridian-text-2">
                        {student.full_name.charAt(0)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-meridian-text-1 text-sm">{student.full_name}</p>
                          {isAlreadyMarked && (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-medium tracking-wide uppercase ${
                              markInfo?.status === 'late'
                                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            }`}>
                              {activeMode === 'check_in' 
                                ? (markInfo?.status === 'late' ? 'Checked In (Late)' : 'Checked In') 
                                : 'Checked Out'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-meridian-text-3 font-mono mt-0.5">
                          <span>ID: {student.device_user_id || 'N/A'}</span>
                          {isAlreadyMarked && markInfo?.time && (
                            <span className="flex items-center gap-1 text-meridian-text-2">
                              <Clock className="w-3 h-3 text-meridian-gold" />
                              {markInfo.time}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div>
                      {isAlreadyMarked ? (
                        <div className="flex items-center gap-1.5 text-xs text-meridian-gold font-medium px-2.5 py-1 rounded-lg bg-meridian-gold/10 border border-meridian-gold/20">
                          <CheckCircle2 className="w-4 h-4 text-meridian-gold" />
                          <span className="hidden sm:inline">Recorded</span>
                        </div>
                      ) : isNewlySelected ? (
                        <div className="w-6 h-6 rounded-full bg-meridian-gold text-meridian-background flex items-center justify-center shadow-xs">
                          <Check className="w-4 h-4 stroke-[3]" />
                        </div>
                      ) : (
                        <Circle className="w-6 h-6 text-meridian-text-3 hover:text-meridian-text-2" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Sticky Action Bar */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-meridian-background via-meridian-background/95 to-transparent backdrop-blur-xs border-t border-meridian-border/50">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
          <div className="text-xs text-meridian-text-3">
            <span className="font-medium text-meridian-text-1">{newlySelectedIds.size}</span> student(s) selected
            {activeMode === 'check_in' ? ' for Morning Check-In' : ' for Evening Check-Out'}
          </div>

          <button
            type="button"
            onClick={handleSubmitAttendance}
            disabled={submitting || newlySelectedIds.size === 0}
            className="py-3 px-6 bg-meridian-gold text-meridian-background rounded-xl font-medium tracking-wide flex items-center gap-2 hover:bg-meridian-gold-dim transition disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-meridian-gold/10"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Recording...</span>
              </>
            ) : (
              <>
                <span>Save {activeMode === 'check_in' ? 'Morning Check-In' : 'Evening Check-Out'} ({newlySelectedIds.size})</span>
                <ArrowRight className="w-4 h-4 shrink-0" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
