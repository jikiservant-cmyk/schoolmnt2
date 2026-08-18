'use client';

import React, { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { 
  FileText, 
  Download, 
  Printer, 
  Calendar, 
  User, 
  Users, 
  Search, 
  CheckCircle2, 
  Clock, 
  Filter, 
  FileSpreadsheet, 
  Check, 
  Copy, 
  Share2,
  GraduationCap,
  Briefcase,
  AlertTriangle,
  FileCheck,
  Building2,
  Phone,
  Layers,
  ChevronDown
} from 'lucide-react';
import { formatEATTime, formatEATDate, formatEATDateTime, getEATDateKey, getEATDayRange, EAT_TIMEZONE } from '@/lib/eat-time';

interface AttendanceReportsProps {
  logs: any[];
  people: any[];
  classes: any[];
  schoolName: string;
}

export default function AttendanceReports({
  logs,
  people,
  classes,
  schoolName
}: AttendanceReportsProps) {
  // Mode: 'class_daily_sheet' | 'group_period' | 'individual'
  const [reportMode, setReportMode] = useState<'class_daily_sheet' | 'group_period' | 'individual'>('class_daily_sheet');
  
  // Selected class for class-based reports (defaults to first class or 'all_students')
  const [selectedClassId, setSelectedClassId] = useState<string>(() => {
    return classes.length > 0 ? classes[0].id : 'all_students';
  });

  // Group filter for group period
  const [selectedGroup, setSelectedGroup] = useState<string>('all_students');
  
  // Selected person for individual dossier
  const [selectedPersonId, setSelectedPersonId] = useState<string>('');
  const [personSearch, setPersonSearch] = useState('');

  // Date controls (all initialized in EAT)
  const [selectedDayDate, setSelectedDayDate] = useState<string>(() => {
    return getEATDateKey(new Date());
  });

  const [datePreset, setDatePreset] = useState<'today' | 'yesterday' | 'week' | 'month' | 'last30' | 'custom'>('today');
  const [customStartDate, setCustomStartDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return getEATDateKey(d);
  });
  const [customEndDate, setCustomEndDate] = useState<string>(() => {
    return getEATDateKey(new Date());
  });


  // Copy to clipboard status
  const [copiedSummary, setCopiedSummary] = useState(false);

  // Class lookup map
  const classMap = useMemo(() => {
    const map = new Map<string, string>();
    classes.forEach(c => map.set(c.id, c.name));
    return map;
  }, [classes]);

  // People in selected class
  const classStudents = useMemo(() => {
    if (!selectedClassId || selectedClassId === 'all_students') {
      return people.filter(p => p.role === 'student');
    }
    return people.filter(p => p.role === 'student' && p.class_id === selectedClassId);
  }, [people, selectedClassId]);

  // Filter people for the individual picker
  const filteredPeopleForPicker = useMemo(() => {
    if (!personSearch.trim()) return people.slice(0, 60);
    const q = personSearch.toLowerCase();
    return people.filter(p => 
      p.full_name?.toLowerCase().includes(q) ||
      p.phone?.toLowerCase().includes(q) ||
      p.device_user_id?.toLowerCase().includes(q)
    );
  }, [people, personSearch]);

  // Calculate Date bounds for Period reports in East Africa Time
  const { startDate, endDate, dateRangeLabel } = useMemo(() => {
    if (reportMode === 'class_daily_sheet') {
      const range = getEATDayRange(selectedDayDate);
      return {
        startDate: new Date(range.startIso),
        endDate: new Date(range.endIso),
        dateRangeLabel: formatEATDate(range.startIso, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
      };
    }

    if (datePreset === 'today') {
      const range = getEATDayRange(new Date());
      return {
        startDate: new Date(range.startIso),
        endDate: new Date(range.endIso),
        dateRangeLabel: `Today (${formatEATDate(range.startIso, { month: 'short', day: 'numeric', year: 'numeric' })})`
      };
    } else if (datePreset === 'yesterday') {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const range = getEATDayRange(y);
      return {
        startDate: new Date(range.startIso),
        endDate: new Date(range.endIso),
        dateRangeLabel: `Yesterday (${formatEATDate(range.startIso, { month: 'short', day: 'numeric', year: 'numeric' })})`
      };
    } else if (datePreset === 'week') {
      const nowKey = getEATDateKey(new Date());
      const nowEat = new Date(`${nowKey}T00:00:00+03:00`);
      const day = nowEat.getDay();
      const diff = nowEat.getDate() - day + (day === 0 ? -6 : 1); // Monday
      const mondayDate = new Date(nowEat);
      mondayDate.setDate(diff);
      const startKey = getEATDateKey(mondayDate);
      const start = new Date(`${startKey}T00:00:00+03:00`);
      const end = new Date(`${nowKey}T23:59:59.999+03:00`);
      return {
        startDate: start,
        endDate: end,
        dateRangeLabel: `This Week (${formatEATDate(start, { month: 'short', day: 'numeric' })} – Present)`
      };
    } else if (datePreset === 'month') {
      const nowKey = getEATDateKey(new Date());
      const parts = nowKey.split('-');
      const start = new Date(`${parts[0]}-${parts[1]}-01T00:00:00+03:00`);
      const end = new Date(`${nowKey}T23:59:59.999+03:00`);
      return {
        startDate: start,
        endDate: end,
        dateRangeLabel: `${formatEATDate(start, { month: 'long', year: 'numeric' })}`
      };
    } else if (datePreset === 'last30') {
      const nowKey = getEATDateKey(new Date());
      const d = new Date(`${nowKey}T00:00:00+03:00`);
      d.setDate(d.getDate() - 30);
      const startKey = getEATDateKey(d);
      const start = new Date(`${startKey}T00:00:00+03:00`);
      const end = new Date(`${nowKey}T23:59:59.999+03:00`);
      return {
        startDate: start,
        endDate: end,
        dateRangeLabel: `Last 30 Days (${formatEATDate(start, { month: 'short', day: 'numeric' })} – ${formatEATDate(end, { month: 'short', day: 'numeric', year: 'numeric' })})`
      };
    } else {
      const sKey = customStartDate || getEATDateKey(new Date());
      const eKey = customEndDate || getEATDateKey(new Date());
      const s = new Date(`${sKey}T00:00:00+03:00`);
      const e = new Date(`${eKey}T23:59:59.999+03:00`);
      return {
        startDate: s,
        endDate: e,
        dateRangeLabel: `${formatEATDate(s, { month: 'short', day: 'numeric', year: 'numeric' })} to ${formatEATDate(e, { month: 'short', day: 'numeric', year: 'numeric' })}`
      };
    }
  }, [reportMode, selectedDayDate, datePreset, customStartDate, customEndDate]);

  // Filter logs for general/period reports
  const filteredReportLogs = useMemo(() => {
    return logs.filter(log => {
      if (!log.occurred_at) return false;
      const logDate = new Date(log.occurred_at);
      if (logDate < startDate || logDate > endDate) return false;

      if (reportMode === 'individual') {
        if (!selectedPersonId) return false;
        return log.person_id === selectedPersonId;
      } else if (reportMode === 'group_period') {
        const personRole = log.people?.role || 'student';
        const personClassId = log.people?.class_id || log.class_id;

        if (selectedGroup === 'all_students') {
          return personRole === 'student';
        } else if (selectedGroup === 'all_teachers') {
          return personRole === 'teacher' || personRole === 'admin' || personRole === 'support_staff';
        } else if (selectedGroup === 'all_support_staff') {
          return personRole === 'support_staff';
        } else {
          return personClassId === selectedGroup;
        }
      } else {
        // Daily class sheet logs
        const personClassId = log.people?.class_id || log.class_id;
        if (selectedClassId === 'all_students') return true;
        return personClassId === selectedClassId;
      }
    });
  }, [logs, startDate, endDate, reportMode, selectedPersonId, selectedGroup, selectedClassId]);

  // DAILY CLASS REGISTER ROSTER (All students in the class with their status on the selected day)
  const classDailyRoster = useMemo(() => {
    if (reportMode !== 'class_daily_sheet') return [];

    // Map logs by person_id for the selected day
    const logByPerson = new Map<string, any>();
    filteredReportLogs.forEach(log => {
      if (log.person_id) {
        logByPerson.set(log.person_id, log);
      }
    });

    return classStudents.map((student, index) => {
      const matchLog = logByPerson.get(student.id);
      let status: 'present' | 'late' | 'absent' = 'absent';
      let checkInTime: string = '—';
      let checkInType: string = '—';

      if (matchLog) {
        status = matchLog.status === 'late' ? 'late' : 'present';
        if (matchLog.occurred_at) {
          checkInTime = formatEATTime(matchLog.occurred_at, {
            hour: '2-digit',
            minute: '2-digit'
          });
        }
        checkInType = (matchLog.attendance_type || 'check_in').replace(/_/g, ' ');
      }

      return {
        rollNumber: index + 1,
        studentId: student.id,
        fullName: student.full_name,
        deviceUserId: student.device_user_id || 'N/A',
        phone: student.phone || '—',
        status,
        checkInTime,
        checkInType,
        className: classMap.get(student.class_id || '') || 'General'
      };
    });
  }, [reportMode, classStudents, filteredReportLogs, classMap]);

  // Aggregate Stats
  const stats = useMemo(() => {
    if (reportMode === 'class_daily_sheet') {
      const totalEnrolled = classDailyRoster.length;
      const presentCount = classDailyRoster.filter(r => r.status === 'present').length;
      const lateCount = classDailyRoster.filter(r => r.status === 'late').length;
      const absentCount = classDailyRoster.filter(r => r.status === 'absent').length;
      const totalAttended = presentCount + lateCount;
      const attendanceRate = totalEnrolled > 0 ? Math.round((totalAttended / totalEnrolled) * 100) : 0;
      const punctualityRate = totalAttended > 0 ? Math.round((presentCount / totalAttended) * 100) : 0;

      return {
        totalRecords: totalEnrolled,
        totalEnrolled,
        presentCount,
        lateCount,
        absentCount,
        totalAttended,
        onTimeRate: punctualityRate,
        attendanceRate,
        lateRate: totalEnrolled > 0 ? Math.round((lateCount / totalEnrolled) * 100) : 0,
        uniqueAttendees: totalAttended
      };
    } else {
      const totalRecords = filteredReportLogs.length;
      const presentCount = filteredReportLogs.filter(l => l.status === 'present').length;
      const lateCount = filteredReportLogs.filter(l => l.status === 'late').length;
      const onTimeRate = totalRecords > 0 ? Math.round((presentCount / totalRecords) * 100) : 0;
      const lateRate = totalRecords > 0 ? Math.round((lateCount / totalRecords) * 100) : 0;
      const uniquePeople = new Set(filteredReportLogs.map(l => l.person_id));

      return {
        totalRecords,
        totalEnrolled: uniquePeople.size,
        presentCount,
        lateCount,
        absentCount: 0,
        totalAttended: totalRecords,
        onTimeRate,
        attendanceRate: 100,
        lateRate,
        uniqueAttendees: uniquePeople.size
      };
    }
  }, [reportMode, classDailyRoster, filteredReportLogs]);

  // Target Subject Description
  const targetLabel = useMemo(() => {
    if (reportMode === 'class_daily_sheet') {
      if (selectedClassId === 'all_students') return 'All Students (School-Wide Daily Roll Call)';
      const clsName = classMap.get(selectedClassId);
      return clsName ? `Class Register: ${clsName}` : 'Class Daily Attendance Sheet';
    } else if (reportMode === 'individual') {
      const person = people.find(p => p.id === selectedPersonId);
      if (!person) return 'Individual Attendance Dossier';
      return `${person.full_name} (${person.role === 'student' ? classMap.get(person.class_id || '') || 'Student' : 'Faculty'})`;
    } else {
      if (selectedGroup === 'all_students') return 'All Registered Students (Cross-Class Audit)';
      if (selectedGroup === 'all_teachers') return 'All Faculty & Staff Members';
      const clsName = classMap.get(selectedGroup);
      return clsName ? `Class History: ${clsName}` : 'Selected Class History';
    }
  }, [reportMode, selectedClassId, selectedPersonId, selectedGroup, people, classMap]);

  // EXCEL (.XLSX) Export Handler
  const handleExportExcel = () => {
    try {
      const wb = XLSX.utils.book_new();

      if (reportMode === 'class_daily_sheet') {
        const headerInfo = [
          ['OFFICIAL CLASS ATTENDANCE SHEET'],
          ['School:', schoolName],
          ['Class:', classMap.get(selectedClassId) || 'All Classes'],
          ['Date:', dateRangeLabel],
          ['Total Enrolled:', stats.totalEnrolled],
          ['Present (On-Time):', stats.presentCount],
          ['Late:', stats.lateCount],
          ['Absent:', stats.absentCount],
          ['Attendance Rate:', `${stats.attendanceRate}%`],
          [] // empty separator
        ];

        const tableHeaders = ['Roll #', 'Student Full Name', 'Admission / Device UID', 'Class', 'Arrival Time', 'Status', 'Check-In Type', 'Parent Phone', 'Teacher Remarks'];
        const tableRows = classDailyRoster.map(row => [
          row.rollNumber,
          row.fullName,
          row.deviceUserId,
          row.className,
          row.checkInTime,
          row.status.toUpperCase(),
          row.checkInType,
          row.phone,
          '' // Empty for remarks
        ]);

        const wsData = [...headerInfo, tableHeaders, ...tableRows];
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb, ws, 'Class_Daily_Register');
      } else {
        const headerInfo = [
          ['NA\'JIKI TECH ATTENDANCE AUDIT REPORT'],
          ['School:', schoolName],
          ['Target Scope:', targetLabel],
          ['Period:', dateRangeLabel],
          ['Total Logs:', stats.totalRecords],
          ['On-Time Count:', stats.presentCount],
          ['Late Count:', stats.lateCount],
          ['On-Time Rate:', `${stats.onTimeRate}%`],
          []
        ];

        const tableHeaders = ['Date', 'Time', 'Person Name', 'Role', 'Class / Scope', 'Status', 'Channel', 'Device UID', 'Parent Phone'];
        const tableRows = filteredReportLogs.map(log => {
          return [
            formatEATDate(log.occurred_at, { month: '2-digit', day: '2-digit', year: 'numeric' }),
            formatEATTime(log.occurred_at, { hour: '2-digit', minute: '2-digit' }),
            log.people?.full_name || 'Unknown',
            log.people?.role || 'Student',
            log.people?.class_id ? classMap.get(log.people.class_id) || 'Unassigned' : 'General',
            (log.status || 'present').toUpperCase(),
            (log.attendance_type || 'check_in').replace(/_/g, ' '),
            log.people?.device_user_id || 'N/A',
            log.people?.phone || 'N/A'
          ];
        });

        const wsData = [...headerInfo, tableHeaders, ...tableRows];
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb, ws, 'Attendance_Audit');
      }

      const fileName = `NajikiTech_${targetLabel.replace(/[^a-zA-Z0-9]/g, '_')}_${reportMode === 'class_daily_sheet' ? selectedDayDate : datePreset}.xlsx`;
      XLSX.writeFile(wb, fileName);
    } catch (err) {
      console.error('Failed to export Excel file:', err);
      alert('Could not generate Excel export. Falling back to CSV export.');
      handleExportCSV();
    }
  };

  // CSV Export Handler
  const handleExportCSV = () => {
    if (reportMode === 'class_daily_sheet') {
      if (classDailyRoster.length === 0) {
        alert('No class roster data available to export.');
        return;
      }
      const headers = ['Roll Number', 'Student Name', 'Admission / Device UID', 'Class', 'Arrival Time', 'Status', 'Channel', 'Parent Phone'];
      const rows = classDailyRoster.map(r => [
        r.rollNumber,
        `"${r.fullName.replace(/"/g, '""')}"`,
        `"${r.deviceUserId}"`,
        `"${r.className}"`,
        `"${r.checkInTime}"`,
        `"${r.status.toUpperCase()}"`,
        `"${r.checkInType}"`,
        `"${r.phone}"`
      ].join(','));

      const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows].join('\n');
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `Class_Register_${classMap.get(selectedClassId) || 'Class'}_${selectedDayDate}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      if (filteredReportLogs.length === 0) {
        alert('No attendance logs to export for this report.');
        return;
      }
      const headers = ['Date', 'Time', 'Person Name', 'Role', 'Class / Scope', 'Status', 'Check-In Type', 'Device UID'];
      const rows = filteredReportLogs.map(log => {
        const dateStr = formatEATDate(log.occurred_at, { month: '2-digit', day: '2-digit', year: 'numeric' });
        const timeStr = formatEATTime(log.occurred_at, { hour: '2-digit', minute: '2-digit' });
        const name = log.people?.full_name || 'Unknown';
        const role = log.people?.role || 'Student';
        const className = log.people?.class_id ? classMap.get(log.people.class_id) || 'Unassigned' : 'General';
        const status = log.status || 'present';
        const type = (log.attendance_type || 'check_in').replace(/_/g, ' ');
        const uid = log.people?.device_user_id || 'N/A';

        return [
          `"${dateStr}"`,
          `"${timeStr}"`,
          `"${name.replace(/"/g, '""')}"`,
          `"${role}"`,
          `"${className}"`,
          `"${status.toUpperCase()}"`,
          `"${type}"`,
          `"${uid}"`
        ].join(',');
      });

      const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows].join('\n');
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `Attendance_Report_${targetLabel.replace(/[^a-zA-Z0-9]/g, '_')}_${datePreset}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  // Copy Briefing / WhatsApp Text Summary
  const handleCopyWhatsAppSummary = async () => {
    let summaryText = '';
    if (reportMode === 'class_daily_sheet') {
      const clsName = classMap.get(selectedClassId) || 'All Classes';
      summaryText = `📊 *${schoolName} - Class Attendance Sheet*\n` +
        `🏫 *Class:* ${clsName}\n` +
        `📅 *Date:* ${dateRangeLabel}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👥 *Total Enrolled:* ${stats.totalEnrolled}\n` +
        `✅ *Present (On-Time):* ${stats.presentCount}\n` +
        `⏰ *Late Arrivals:* ${stats.lateCount}\n` +
        `❌ *Absent:* ${stats.absentCount}\n` +
        `📈 *Attendance Rate:* ${stats.attendanceRate}%\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `*Absent Students:*\n` +
        (classDailyRoster.filter(r => r.status === 'absent').map(r => `• ${r.fullName} (${r.phone})`).join('\n') || 'None - 100% Attendance!') +
        `\n\n_Generated automatically by Na'Jiki Tech Portal_`;
    } else {
      summaryText = `📊 *${schoolName} - Attendance Report*\n` +
        `🎯 *Scope:* ${targetLabel}\n` +
        `📅 *Period:* ${dateRangeLabel}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📝 *Total Logs:* ${stats.totalRecords}\n` +
        `✅ *On-Time:* ${stats.presentCount} (${stats.onTimeRate}%)\n` +
        `⏰ *Late:* ${stats.lateCount} (${stats.lateRate}%)\n` +
        `👥 *Unique Individuals:* ${stats.uniqueAttendees}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `_Generated via Na'Jiki Tech Attendance Engine_`;
    }

    try {
      await navigator.clipboard.writeText(summaryText);
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2500);
    } catch {
      console.error('Failed to copy to clipboard');
    }
  };

  // Print Handler
  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-6">
      
      {/* 1. REPORT BUILDER CARD */}
      <div className="bg-white border border-[#e7e7ea] rounded-[16px] p-6 shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-5 print:hidden">
        
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#f1f1f4] pb-4">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-[#007aff] mb-1">
              ATTENDANCE REPORTING & EXPORT CENTER
            </div>
            <h2 className="text-lg font-bold text-[#171719] tracking-tight">
              Class Attendance Registers & Custom Reports
            </h2>
            <p className="text-xs text-[#85858a] mt-0.5">
              Generate daily roll call class sheets, period summaries, and export to PDF, Excel (.xlsx), CSV or print.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyWhatsAppSummary}
              className="h-8 px-3 border border-[#e1e1e5] bg-[#fafafa] hover:bg-white text-[#171719] rounded-[8px] text-xs font-medium flex items-center gap-1.5 transition cursor-pointer shadow-2xs"
            >
              {copiedSummary ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#30b357]" />
                  <span className="text-[#30b357] font-semibold">Copied Summary</span>
                </>
              ) : (
                <>
                  <Share2 className="w-3.5 h-3.5 text-[#85858a]" />
                  <span>Copy Summary</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Report Mode Tabs */}
        <div className="space-y-2">
          <label className="block text-[11px] font-semibold text-[#171719]">
            Select Report Type
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 bg-[#f5f5f7] p-1.5 rounded-[12px] border border-[#e7e7ea]">
            <button
              type="button"
              onClick={() => setReportMode('class_daily_sheet')}
              className={`py-2 px-3 rounded-[9px] text-xs font-medium transition cursor-pointer flex items-center justify-center gap-2 ${
                reportMode === 'class_daily_sheet'
                  ? 'bg-white text-[#171719] shadow-2xs font-bold border border-[#e1e1e5]'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <FileCheck className="w-4 h-4 text-[#007aff]" />
              <div className="text-left">
                <div className="leading-tight">Daily Class Sheet</div>
                <div className="text-[10px] text-[#85858a] font-normal">Roll call master register</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setReportMode('group_period')}
              className={`py-2 px-3 rounded-[9px] text-xs font-medium transition cursor-pointer flex items-center justify-center gap-2 ${
                reportMode === 'group_period'
                  ? 'bg-white text-[#171719] shadow-2xs font-bold border border-[#e1e1e5]'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <Layers className="w-4 h-4 text-[#30b357]" />
              <div className="text-left">
                <div className="leading-tight">Period Audit Report</div>
                <div className="text-[10px] text-[#85858a] font-normal">Weekly / monthly logs</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setReportMode('individual');
                if (!selectedPersonId && people.length > 0) {
                  setSelectedPersonId(people[0].id);
                }
              }}
              className={`py-2 px-3 rounded-[9px] text-xs font-medium transition cursor-pointer flex items-center justify-center gap-2 ${
                reportMode === 'individual'
                  ? 'bg-white text-[#171719] shadow-2xs font-bold border border-[#e1e1e5]'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <User className="w-4 h-4 text-[#f5a30a]" />
              <div className="text-left">
                <div className="leading-tight">Individual Dossier</div>
                <div className="text-[10px] text-[#85858a] font-normal">Single student or staff</div>
              </div>
            </button>
          </div>
        </div>

        {/* Configuration Filters based on selected Mode */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-1">
          
          {/* 1. Target Selector */}
          {reportMode === 'class_daily_sheet' && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold text-[#171719]">
                Select Class / Stream
              </label>
              <select
                value={selectedClassId}
                onChange={(e) => setSelectedClassId(e.target.value)}
                className="w-full h-9 px-3 bg-white border border-[#e1e1e5] rounded-[9px] text-xs text-[#171719] font-medium focus:outline-none focus:border-[#007aff] cursor-pointer"
              >
                <option value="all_students">All Students (Entire School Roster)</option>
                {classes.map(c => (
                  <option key={c.id} value={c.id}>
                    Class: {c.name} ({people.filter(p => p.role === 'student' && p.class_id === c.id).length} students)
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-[#85858a]">
                Generates a roll call sheet with Present, Late, and Absent status for this class.
              </p>
            </div>
          )}

          {reportMode === 'group_period' && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold text-[#171719]">
                Group or Class Scope
              </label>
              <select
                value={selectedGroup}
                onChange={(e) => setSelectedGroup(e.target.value)}
                className="w-full h-9 px-3 bg-white border border-[#e1e1e5] rounded-[9px] text-xs text-[#171719] font-medium focus:outline-none focus:border-[#007aff] cursor-pointer"
              >
                <optgroup label="General School Groups">
                  <option value="all_students">All Students (Entire School)</option>
                  <option value="all_teachers">All Faculty & Staff</option>
                  <option value="all_support_staff">Support Staff Only</option>
                </optgroup>
                <optgroup label="Specific Classes">
                  {classes.map(c => (
                    <option key={c.id} value={c.id}>
                      Class: {c.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
          )}

          {reportMode === 'individual' && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold text-[#171719]">
                Select Student, Teacher, or Staff
              </label>
              <input
                type="text"
                placeholder="Search person name..."
                value={personSearch}
                onChange={(e) => setPersonSearch(e.target.value)}
                className="w-full h-8 px-2.5 bg-[#fafafa] border border-[#e1e1e5] rounded-[8px] text-xs text-[#171719] placeholder:text-[#96969b]"
              />
              <select
                value={selectedPersonId}
                onChange={(e) => setSelectedPersonId(e.target.value)}
                className="w-full h-9 px-3 bg-white border border-[#e1e1e5] rounded-[9px] text-xs text-[#171719] font-medium focus:outline-none focus:border-[#007aff] cursor-pointer"
              >
                {filteredPeopleForPicker.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.full_name} ({p.role}) {p.class_id ? `— ${classMap.get(p.class_id)}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 2. Date Selection */}
          {reportMode === 'class_daily_sheet' ? (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold text-[#171719]">
                Attendance Date
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={selectedDayDate}
                  onChange={(e) => setSelectedDayDate(e.target.value)}
                  className="flex-1 h-9 px-3 bg-white border border-[#e1e1e5] rounded-[9px] text-xs text-[#171719] font-medium focus:outline-none focus:border-[#007aff]"
                />
                <button
                  type="button"
                  onClick={() => setSelectedDayDate(new Date().toISOString().split('T')[0])}
                  className="h-9 px-3 bg-[#f5f5f7] hover:bg-[#ebebee] border border-[#e1e1e5] rounded-[9px] text-xs font-semibold text-[#171719] cursor-pointer transition"
                >
                  Today
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold text-[#171719]">
                Date Period
              </label>
              <div className="grid grid-cols-4 gap-1 bg-[#f5f5f7] p-1 rounded-[10px] border border-[#e7e7ea] text-xs">
                <button
                  type="button"
                  onClick={() => setDatePreset('today')}
                  className={`py-1.5 rounded-[7px] text-[11px] font-medium transition cursor-pointer text-center ${
                    datePreset === 'today' ? 'bg-white text-[#171719] shadow-2xs font-semibold' : 'text-[#85858a]'
                  }`}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => setDatePreset('week')}
                  className={`py-1.5 rounded-[7px] text-[11px] font-medium transition cursor-pointer text-center ${
                    datePreset === 'week' ? 'bg-white text-[#171719] shadow-2xs font-semibold' : 'text-[#85858a]'
                  }`}
                >
                  Week
                </button>
                <button
                  type="button"
                  onClick={() => setDatePreset('month')}
                  className={`py-1.5 rounded-[7px] text-[11px] font-medium transition cursor-pointer text-center ${
                    datePreset === 'month' ? 'bg-white text-[#171719] shadow-2xs font-semibold' : 'text-[#85858a]'
                  }`}
                >
                  Month
                </button>
                <button
                  type="button"
                  onClick={() => setDatePreset('custom')}
                  className={`py-1.5 rounded-[7px] text-[11px] font-medium transition cursor-pointer text-center ${
                    datePreset === 'custom' ? 'bg-white text-[#007aff] shadow-2xs font-semibold' : 'text-[#85858a]'
                  }`}
                >
                  Custom
                </button>
              </div>

              {datePreset === 'custom' && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    className="h-8 px-2 bg-white border border-[#e1e1e5] rounded-[8px] text-[11px] text-[#171719]"
                  />
                  <input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    className="h-8 px-2 bg-white border border-[#e1e1e5] rounded-[8px] text-[11px] text-[#171719]"
                  />
                </div>
              )}
            </div>
          )}

          {/* 3. Export Action Center */}
          <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold text-[#171719]">
              Export Formats & Download
            </label>
            <div className="grid grid-cols-2 gap-2">
              {/* Excel Button */}
              <button
                type="button"
                onClick={handleExportExcel}
                className="h-9 px-3 bg-[#edf9f0] hover:bg-[#d2f4d9] border border-[#b2eac0] text-[#2da94f] rounded-[9px] text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer shadow-2xs"
                title="Download formatted Excel spreadsheet (.xlsx)"
              >
                <FileSpreadsheet className="w-4 h-4 text-[#30b357]" />
                <span>Excel (.xlsx)</span>
              </button>

              {/* PDF / Print Button */}
              <button
                type="button"
                onClick={handlePrint}
                className="h-9 px-3 bg-[#edf5ff] hover:bg-[#d6e7ff] border border-[#c2dbff] text-[#007aff] rounded-[9px] text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer shadow-2xs"
                title="Print or Save as PDF"
              >
                <FileText className="w-4 h-4 text-[#007aff]" />
                <span>PDF / Print</span>
              </button>

              {/* CSV Button */}
              <button
                type="button"
                onClick={handleExportCSV}
                className="h-8 px-2.5 bg-[#f7f7f9] hover:bg-[#efeff2] border border-[#e1e1e5] text-[#171719] rounded-[8px] text-[11px] font-medium flex items-center justify-center gap-1.5 transition cursor-pointer"
                title="Download raw CSV file"
              >
                <Download className="w-3.5 h-3.5 text-[#5e5e63]" />
                <span>CSV File</span>
              </button>

              {/* Direct Print Button */}
              <button
                type="button"
                onClick={handlePrint}
                className="h-8 px-2.5 bg-[#171719] hover:bg-[#2c2c2e] text-white rounded-[8px] text-[11px] font-medium flex items-center justify-center gap-1.5 transition cursor-pointer shadow-2xs"
              >
                <Printer className="w-3.5 h-3.5 text-white" />
                <span>Print Sheet</span>
              </button>
            </div>
          </div>

        </div>

      </div>

      {/* 2. OFFICIAL PRINTABLE REPORT CANVAS */}
      <div className="bg-white border border-[#e7e7ea] rounded-[16px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] overflow-hidden">
        
        {/* Printable Official Header */}
        <div className="p-6 border-b border-[#f1f1f4] bg-[#fafafa] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-[12px] bg-[#171719] text-white grid place-items-center text-lg font-bold shadow-2xs shrink-0">
              {schoolName.substring(0, 2).toUpperCase() || 'SS'}
            </div>
            <div>
              <div className="text-[10px] font-semibold tracking-wider uppercase text-[#007aff] flex items-center gap-1.5">
                <span>OFFICIAL ATTENDANCE RECORD</span>
                <span>&middot;</span>
                <span>{schoolName}</span>
              </div>
              <h2 className="text-xl font-bold text-[#171719] tracking-tight mt-0.5">
                {targetLabel}
              </h2>
              <div className="flex flex-wrap items-center gap-3 text-xs text-[#85858a] mt-1">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-[#929297]" />
                  <span>{dateRangeLabel}</span>
                </span>
                {reportMode === 'class_daily_sheet' && (
                  <span className="flex items-center gap-1 text-[#171719] font-medium">
                    <GraduationCap className="w-3.5 h-3.5 text-[#007aff]" />
                    <span>{classDailyRoster.length} Total Enrolled Students</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 print:hidden">
            <span className="px-3 py-1 bg-white border border-[#e1e1e5] rounded-full text-xs font-semibold text-[#171719] shadow-2xs">
              {reportMode === 'class_daily_sheet' ? `${stats.totalAttended} / ${stats.totalEnrolled} Clocked In` : `${stats.totalRecords} Logs Found`}
            </span>
          </div>
        </div>

        {/* 4 Summary KPI Metric Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-[#f1f1f4] border-b border-[#f1f1f4] bg-white">
          
          <div className="p-4 sm:p-5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#929297] block">
              {reportMode === 'class_daily_sheet' ? 'Total Enrolled' : 'Total Logs'}
            </span>
            <div className="text-2xl font-bold tracking-tight text-[#171719] mt-1">
              {stats.totalRecords.toLocaleString()}
            </div>
            <span className="text-[11px] text-[#85858a] mt-0.5 block">
              {reportMode === 'class_daily_sheet' ? 'Registered in Class' : `${stats.uniqueAttendees} unique attendees`}
            </span>
          </div>

          <div className="p-4 sm:p-5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#30b357] block">
              On-Time (Present)
            </span>
            <div className="text-2xl font-bold tracking-tight text-[#2da94f] mt-1">
              {stats.presentCount.toLocaleString()}
            </div>
            <span className="text-[11px] text-[#30b357] font-medium mt-0.5 block">
              {stats.onTimeRate}% punctuality rate
            </span>
          </div>

          <div className="p-4 sm:p-5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#f5a30a] block">
              Late Arrivals
            </span>
            <div className="text-2xl font-bold tracking-tight text-[#f5a30a] mt-1">
              {stats.lateCount.toLocaleString()}
            </div>
            <span className="text-[11px] text-[#f5a30a] font-medium mt-0.5 block">
              {stats.lateRate}% late arrival rate
            </span>
          </div>

          <div className="p-4 sm:p-5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#007aff] block">
              {reportMode === 'class_daily_sheet' ? 'Absent / Unmarked' : 'Attendance Rate'}
            </span>
            <div className={`text-2xl font-bold tracking-tight mt-1 ${reportMode === 'class_daily_sheet' && stats.absentCount > 0 ? 'text-[#ef4444]' : 'text-[#007aff]'}`}>
              {reportMode === 'class_daily_sheet' ? stats.absentCount.toLocaleString() : `${stats.attendanceRate}%`}
            </div>
            <span className="text-[11px] text-[#85858a] mt-0.5 block">
              {reportMode === 'class_daily_sheet' ? `${stats.attendanceRate}% daily attendance` : 'Verified records'}
            </span>
          </div>

        </div>

        {/* 3. DETAILED TABLE RENDERING */}
        
        {/* VIEW A: CLASS DAILY ROLL CALL REGISTER */}
        {reportMode === 'class_daily_sheet' && (
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#fafafa] border-b border-[#f1f1f4] text-[10px] uppercase font-semibold tracking-wider text-[#929297]">
                  <th className="py-3 px-4 w-12 text-center">#</th>
                  <th className="py-3 px-4 whitespace-nowrap">Student Name</th>
                  <th className="py-3 px-4 whitespace-nowrap">Class / Stream</th>
                  <th className="py-3 px-4 whitespace-nowrap">Arrival Time</th>
                  <th className="py-3 px-4 whitespace-nowrap">Status</th>
                  <th className="py-3 px-4 whitespace-nowrap">Parent Phone</th>
                  <th className="py-3 px-4 whitespace-nowrap">UID</th>
                  <th className="py-3 px-5 whitespace-nowrap text-right">Remarks / Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f7f7f9]">
                {classDailyRoster.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-16 text-center text-xs text-[#929297]">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <GraduationCap className="w-10 h-10 text-[#929297]" />
                        <p className="font-semibold text-[#171719]">No students registered in this class</p>
                        <p className="text-[11px] text-[#85858a]">
                          Select another class or register students from the Students directory.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  classDailyRoster.map((row) => (
                    <tr key={row.studentId} className="hover:bg-[#fbfbfd] transition">
                      <td className="py-3 px-4 text-center font-mono text-[11px] text-[#85858a]">
                        {row.rollNumber}
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="font-semibold text-[#171719] text-xs">
                          {row.fullName}
                        </div>
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className="px-2 py-0.5 bg-[#f7f7f9] border border-[#e7e7ea] rounded text-[11px] font-medium text-[#171719]">
                          {row.className}
                        </span>
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap font-mono text-[11px] text-[#171719]">
                        {row.checkInTime}
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold ${
                          row.status === 'present'
                            ? 'bg-[#edf9f0] text-[#2da94f]'
                            : row.status === 'late'
                            ? 'bg-[#fff5e7] text-[#f5a30a]'
                            : 'bg-[#fff0ef] text-[#ef4444]'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            row.status === 'present' ? 'bg-[#30b357]' : row.status === 'late' ? 'bg-[#f5a30a]' : 'bg-[#ef4444]'
                          }`} />
                          <span className="capitalize">{row.status}</span>
                        </span>
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap font-mono text-[11px] text-[#5e5e63]">
                        {row.phone}
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap font-mono text-[10px] text-[#929297]">
                        {row.deviceUserId}
                      </td>

                      <td className="py-3 px-5 whitespace-nowrap text-right">
                        <div className="w-24 border-b border-[#e1e1e5] ml-auto pb-2" />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* VIEW B: GENERAL / GROUP PERIOD & INDIVIDUAL LOGS */}
        {reportMode !== 'class_daily_sheet' && (
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#fafafa] border-b border-[#f1f1f4] text-[10px] uppercase font-semibold tracking-wider text-[#929297]">
                  <th className="py-3 px-5 whitespace-nowrap">Date</th>
                  <th className="py-3 px-4 whitespace-nowrap">Person</th>
                  <th className="py-3 px-4 whitespace-nowrap">Role / Class</th>
                  <th className="py-3 px-4 whitespace-nowrap">Time</th>
                  <th className="py-3 px-4 whitespace-nowrap">Status</th>
                  <th className="py-3 px-4 whitespace-nowrap">Channel</th>
                  <th className="py-3 px-5 whitespace-nowrap text-right">Device UID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f7f7f9]">
                {filteredReportLogs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-16 text-center text-xs text-[#929297]">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Clock className="w-10 h-10 text-[#929297]" />
                        <p className="font-semibold text-[#171719]">No attendance entries found for this report period</p>
                        <p className="text-[11px] text-[#85858a]">
                          Try expanding the date period or changing the selected group.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredReportLogs.map((log) => {
                    const dateFormatted = formatEATDate(log.occurred_at, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric'
                    });
                    const timeFormatted = formatEATTime(log.occurred_at, {
                      hour: '2-digit',
                      minute: '2-digit'
                    });

                    const personName = log.people?.full_name || 'Unknown';
                    const role = log.people?.role || 'student';
                    const className = log.people?.class_id ? classMap.get(log.people.class_id) || 'Unassigned' : 'General';

                    return (
                      <tr key={log.id} className="hover:bg-[#fbfbfd] transition">
                        <td className="py-3 px-5 whitespace-nowrap font-medium text-[#171719]" suppressHydrationWarning>
                          {dateFormatted}
                        </td>

                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-semibold text-[#171719]">{personName}</div>
                        </td>

                        <td className="py-3 px-4 whitespace-nowrap text-[#5e5e63]">
                          {role === 'student' ? (
                            <span className="px-2 py-0.5 bg-[#f7f7f9] border border-[#e7e7ea] rounded text-[11px] font-medium text-[#171719]">
                              {className}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 bg-[#edf9f0] text-[#2da94f] rounded text-[11px] font-medium">
                              Faculty
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-4 whitespace-nowrap font-mono text-[11px] text-[#171719]" suppressHydrationWarning>
                          {timeFormatted}
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

                        <td className="py-3 px-4 whitespace-nowrap text-[#85858a] capitalize">
                          {(log.attendance_type || 'check_in').replace(/_/g, ' ')}
                        </td>

                        <td className="py-3 px-5 whitespace-nowrap text-right font-mono text-[11px] text-[#85858a]">
                          {log.people?.device_user_id || '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Official Printable Signature Footer */}
        <div className="p-6 bg-[#fafafa] border-t border-[#f1f1f4] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <div className="text-[11px] text-[#85858a]" suppressHydrationWarning>
            Generated by Na&apos;Jiki Tech Portal &middot; {formatEATDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} at {formatEATTime(new Date(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>

          <div className="flex items-center gap-8 text-xs text-[#5e5e63]">
            <div className="text-center">
              <div className="w-36 border-b border-[#cfcfd4] pb-6 mb-1" />
              <span className="text-[10px] uppercase tracking-wider text-[#929297]">
                {reportMode === 'class_daily_sheet' ? 'Class Teacher Signature' : 'Registrar Signature'}
              </span>
            </div>
            <div className="text-center">
              <div className="w-36 border-b border-[#cfcfd4] pb-6 mb-1" />
              <span className="text-[10px] uppercase tracking-wider text-[#929297]">Headteacher Stamp</span>
            </div>
          </div>
        </div>

      </div>

    </div>
  );
}
