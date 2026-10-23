'use client';

import React, { useState, useMemo, useTransition } from 'react';
import {
  Building2,
  Clock,
  MessageSquare,
  Cpu,
  Wallet,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import {
  COMMON_SCHOOL_TIMEZONES,
  DEFAULT_SCHOOL_POLICY_SETTINGS,
  formatHhMm12Hour,
  parseHhMmToMinutes,
  renderAttendanceSmsMessage,
  type ResolvedSchoolConfiguration,
} from '@/lib/school-settings';
import { formatZKTecoDisplayName } from '@/utils/zkteco/formatter';
import { saveSchoolSettingsAction, resetSchoolSettingsAction } from './actions';

type SettingsSectionId = 'general' | 'attendance' | 'sms' | 'hardware' | 'wallet';

interface SettingsFormProps {
  initialSettings: ResolvedSchoolConfiguration;
}

export default function SettingsForm({ initialSettings }: SettingsFormProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general');
  const [isPending, startTransition] = useTransition();
  const [statusBanner, setStatusBanner] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Form state seeded from database-backed per-school configuration
  const [schoolName, setSchoolName] = useState(initialSettings.schoolName);
  const [academicTermLabel, setAcademicTermLabel] = useState(initialSettings.academicTermLabel);
  const [supportPhone, setSupportPhone] = useState(initialSettings.supportPhone);
  const [timeZone, setTimeZone] = useState(initialSettings.timeZone);

  const [studentLateCutoff, setStudentLateCutoff] = useState(initialSettings.studentLateCutoff);
  const [studentGraceMinutes, setStudentGraceMinutes] = useState(String(initialSettings.studentGraceMinutes));
  const [staffLateCutoff, setStaffLateCutoff] = useState(initialSettings.staffLateCutoff);
  const [afternoonSwitchoverTime, setAfternoonSwitchoverTime] = useState(initialSettings.afternoonSwitchoverTime);
  const [duplicatePunchWindowSeconds, setDuplicatePunchWindowSeconds] = useState(
    String(initialSettings.duplicatePunchWindowSeconds)
  );

  const [smsEnabled, setSmsEnabled] = useState(initialSettings.smsEnabled);
  const [sendCheckInSms, setSendCheckInSms] = useState(initialSettings.sendCheckInSms);
  const [sendLateSms, setSendLateSms] = useState(initialSettings.sendLateSms);
  const [sendCheckOutSms, setSendCheckOutSms] = useState(initialSettings.sendCheckOutSms);
  const [restrictSmsWindows, setRestrictSmsWindows] = useState(initialSettings.restrictSmsWindows);
  const [checkInSmsStart, setCheckInSmsStart] = useState(initialSettings.checkInSmsStart);
  const [checkInSmsEnd, setCheckInSmsEnd] = useState(initialSettings.checkInSmsEnd);
  const [checkOutSmsStart, setCheckOutSmsStart] = useState(initialSettings.checkOutSmsStart);
  const [checkOutSmsEnd, setCheckOutSmsEnd] = useState(initialSettings.checkOutSmsEnd);
  const [smsTemplateCheckIn, setSmsTemplateCheckIn] = useState(initialSettings.smsTemplateCheckIn);
  const [smsTemplateLate, setSmsTemplateLate] = useState(initialSettings.smsTemplateLate);
  const [smsTemplateCheckOut, setSmsTemplateCheckOut] = useState(initialSettings.smsTemplateCheckOut);

  const [enforceStandardClassPrefix, setEnforceStandardClassPrefix] = useState(
    initialSettings.enforceStandardClassPrefix
  );
  const [maxPinFailures, setMaxPinFailures] = useState(String(initialSettings.maxPinFailures));
  const [pinLockoutMinutes, setPinLockoutMinutes] = useState(String(initialSettings.pinLockoutMinutes));
  const [startingBiometricPin, setStartingBiometricPin] = useState(String(initialSettings.startingBiometricPin));
  const [lcdPrefixTeacher, setLcdPrefixTeacher] = useState(initialSettings.lcdPrefixTeacher);
  const [lcdPrefixAdmin, setLcdPrefixAdmin] = useState(initialSettings.lcdPrefixAdmin);
  const [lcdPrefixSupport, setLcdPrefixSupport] = useState(initialSettings.lcdPrefixSupport);
  const [lcdShowStudentClass, setLcdShowStudentClass] = useState(initialSettings.lcdShowStudentClass);

  const [defaultTopUpAmount, setDefaultTopUpAmount] = useState(String(initialSettings.defaultTopUpAmount));
  const [topUpPresetsText, setTopUpPresetsText] = useState(initialSettings.topUpPresets.join(', '));
  const [lowBalanceThresholdUgx, setLowBalanceThresholdUgx] = useState(
    String(initialSettings.lowBalanceThresholdUgx)
  );

  const platformSmsRate = initialSettings.platformSmsUnitCostUgx;

  const hydrateStateFromConfig = (cfg: ResolvedSchoolConfiguration) => {
    setSchoolName(cfg.schoolName);
    setAcademicTermLabel(cfg.academicTermLabel);
    setSupportPhone(cfg.supportPhone);
    setTimeZone(cfg.timeZone);
    setStudentLateCutoff(cfg.studentLateCutoff);
    setStudentGraceMinutes(String(cfg.studentGraceMinutes));
    setStaffLateCutoff(cfg.staffLateCutoff);
    setAfternoonSwitchoverTime(cfg.afternoonSwitchoverTime);
    setDuplicatePunchWindowSeconds(String(cfg.duplicatePunchWindowSeconds));
    setSmsEnabled(cfg.smsEnabled);
    setSendCheckInSms(cfg.sendCheckInSms);
    setSendLateSms(cfg.sendLateSms);
    setSendCheckOutSms(cfg.sendCheckOutSms);
    setRestrictSmsWindows(cfg.restrictSmsWindows);
    setCheckInSmsStart(cfg.checkInSmsStart);
    setCheckInSmsEnd(cfg.checkInSmsEnd);
    setCheckOutSmsStart(cfg.checkOutSmsStart);
    setCheckOutSmsEnd(cfg.checkOutSmsEnd);
    setSmsTemplateCheckIn(cfg.smsTemplateCheckIn);
    setSmsTemplateLate(cfg.smsTemplateLate);
    setSmsTemplateCheckOut(cfg.smsTemplateCheckOut);
    setEnforceStandardClassPrefix(cfg.enforceStandardClassPrefix);
    setMaxPinFailures(String(cfg.maxPinFailures));
    setPinLockoutMinutes(String(cfg.pinLockoutMinutes));
    setStartingBiometricPin(String(cfg.startingBiometricPin));
    setLcdPrefixTeacher(cfg.lcdPrefixTeacher);
    setLcdPrefixAdmin(cfg.lcdPrefixAdmin);
    setLcdPrefixSupport(cfg.lcdPrefixSupport);
    setLcdShowStudentClass(cfg.lcdShowStudentClass);
    setDefaultTopUpAmount(String(cfg.defaultTopUpAmount));
    setTopUpPresetsText(cfg.topUpPresets.join(', '));
    setLowBalanceThresholdUgx(String(cfg.lowBalanceThresholdUgx));
  };

  // Effective student cutoff display (cutoff + grace minutes)
  const effectiveStudentCutoffLabel = useMemo(() => {
    const baseMins = parseHhMmToMinutes(studentLateCutoff, 8 * 60);
    const grace = Math.max(0, Math.min(60, parseInt(studentGraceMinutes || '0', 10) || 0));
    const total = (baseMins + grace) % (24 * 60);
    const hh = String(Math.floor(total / 60)).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return formatHhMm12Hour(`${hh}:${mm}`);
  }, [studentLateCutoff, studentGraceMinutes]);

  // Live SMS previews
  const previewPolicy = useMemo(
    () => ({
      ...DEFAULT_SCHOOL_POLICY_SETTINGS,
      smsTemplateCheckIn,
      smsTemplateLate,
      smsTemplateCheckOut,
    }),
    [smsTemplateCheckIn, smsTemplateLate, smsTemplateCheckOut]
  );

  const sampleCheckInSms = useMemo(
    () =>
      renderAttendanceSmsMessage(previewPolicy, 'check_in', {
        studentName: 'Grace Namukasa',
        schoolName: schoolName || 'Your School',
        time: '07:42 AM',
        className: 'P6 Blue',
        status: 'present',
      }),
    [previewPolicy, schoolName]
  );

  const sampleLateSms = useMemo(
    () =>
      renderAttendanceSmsMessage(previewPolicy, 'check_in', {
        studentName: 'Grace Namukasa',
        schoolName: schoolName || 'Your School',
        time: '08:19 AM',
        className: 'P6 Blue',
        status: 'late',
      }),
    [previewPolicy, schoolName]
  );

  const sampleCheckOutSms = useMemo(
    () =>
      renderAttendanceSmsMessage(previewPolicy, 'check_out', {
        studentName: 'Grace Namukasa',
        schoolName: schoolName || 'Your School',
        time: '04:35 PM',
        className: 'P6 Blue',
        status: 'present',
      }),
    [previewPolicy, schoolName]
  );

  // Live 24-character ZKTeco LCD previews
  const lcdPreviewSamples = useMemo(() => {
    const opts = {
      prefixTeacher: lcdPrefixTeacher,
      prefixAdmin: lcdPrefixAdmin,
      prefixSupport: lcdPrefixSupport,
      showStudentClass: lcdShowStudentClass,
    };
    return [
      {
        label: 'Student',
        lcd: formatZKTecoDisplayName(
          { full_name: 'Grace Namukasa', role: 'student', classes: { name: 'P6' } },
          opts
        ),
      },
      {
        label: 'Teacher',
        lcd: formatZKTecoDisplayName({ full_name: 'Sarah Nambi', role: 'teacher' }, opts),
      },
      {
        label: 'Administrator',
        lcd: formatZKTecoDisplayName({ full_name: 'David Okello', role: 'admin' }, opts),
      },
      {
        label: 'Support Staff',
        lcd: formatZKTecoDisplayName({ full_name: 'Peter Kato', role: 'support_staff' }, opts),
      },
    ];
  }, [lcdPrefixTeacher, lcdPrefixAdmin, lcdPrefixSupport, lcdShowStudentClass]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setStatusBanner(null);

    startTransition(async () => {
      const res = await saveSchoolSettingsAction({
        schoolName,
        academicTermLabel,
        supportPhone,
        timeZone,
        studentLateCutoff,
        studentGraceMinutes: Number(studentGraceMinutes),
        staffLateCutoff,
        afternoonSwitchoverTime,
        duplicatePunchWindowSeconds: Number(duplicatePunchWindowSeconds),
        smsEnabled,
        sendCheckInSms,
        sendLateSms,
        sendCheckOutSms,
        restrictSmsWindows,
        checkInSmsStart,
        checkInSmsEnd,
        checkOutSmsStart,
        checkOutSmsEnd,
        smsTemplateCheckIn,
        smsTemplateLate,
        smsTemplateCheckOut,
        enforceStandardClassPrefix,
        maxPinFailures: Number(maxPinFailures),
        pinLockoutMinutes: Number(pinLockoutMinutes),
        startingBiometricPin: Number(startingBiometricPin),
        lcdPrefixTeacher,
        lcdPrefixAdmin,
        lcdPrefixSupport,
        lcdShowStudentClass,
        defaultTopUpAmount: Number(defaultTopUpAmount),
        topUpPresets: topUpPresetsText,
        lowBalanceThresholdUgx: Number(lowBalanceThresholdUgx),
      });

      if ('error' in res) {
        setStatusBanner({ type: 'error', text: res.error });
      } else {
        hydrateStateFromConfig(res.settings);
        setStatusBanner({ type: 'success', text: res.message });
      }
    });
  };

  const handleResetDefaults = () => {
    setStatusBanner(null);
    startTransition(async () => {
      const res = await resetSchoolSettingsAction();
      if ('error' in res) {
        setStatusBanner({ type: 'error', text: res.error });
      } else {
        hydrateStateFromConfig(res.settings);
        setStatusBanner({ type: 'success', text: res.message });
      }
    });
  };

  const sections: { id: SettingsSectionId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'general', label: 'School & Timezone', icon: Building2 },
    { id: 'attendance', label: 'Cutoffs & Sessions', icon: Clock },
    { id: 'sms', label: 'Parent SMS & Templates', icon: MessageSquare },
    { id: 'hardware', label: 'Classes, PINs & Hardware', icon: Cpu },
    { id: 'wallet', label: 'Wallet & Top-Up Defaults', icon: Wallet },
  ];

  const isCustomTimezone = !COMMON_SCHOOL_TIMEZONES.some((t) => t.value === timeZone);

  return (
    <form onSubmit={handleSave} className="space-y-6 pt-5 pb-12 animate-fade-in">
      {/* Header Card */}
      <div className="bg-white border border-[#e7e7ea] p-6 rounded-[16px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-[#929297] mb-1">
            PER-SCHOOL OPERATIONAL POLICY ENGINE
          </div>
          <h1 className="text-[22px] sm:text-[25px] font-bold tracking-tight text-[#171719] leading-tight">
            School Settings & Policies
          </h1>
          <p className="text-[12px] text-[#85858a] mt-0.5 max-w-2xl">
            Configure arrival cutoffs, grace minutes, time zone, SMS dispatch hours, custom parent SMS templates,
            Teacher PIN security, and biometric terminal display rules exclusively for your school.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            disabled={isPending}
            onClick={handleResetDefaults}
            className="h-9 px-3.5 border border-[#e1e1e5] bg-white hover:bg-[#f7f7f8] text-[#5e5e63] hover:text-[#171719] rounded-[9px] text-xs font-medium flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Defaults</span>
          </button>

          <button
            type="submit"
            disabled={isPending}
            className="h-9 px-4 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-[9px] text-xs font-semibold shadow-2xs flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
          >
            {isPending ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Saving...</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                <span>Save Settings</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {statusBanner && (
        <div
          className={`p-3.5 rounded-[12px] border text-xs font-medium flex items-center gap-2.5 ${
            statusBanner.type === 'success'
              ? 'bg-[#edf9f0] border-[#d2f4d9] text-[#2da94f]'
              : 'bg-[#fff0ef] border-[#fbd1cf] text-[#ef4444]'
          }`}
        >
          {statusBanner.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span>{statusBanner.text}</span>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="bg-white p-1.5 border border-[#e7e7ea] rounded-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-wrap gap-1">
        {sections.map((sec) => {
          const Icon = sec.icon;
          const active = activeSection === sec.id;
          return (
            <button
              key={sec.id}
              type="button"
              onClick={() => setActiveSection(sec.id)}
              className={`px-3.5 py-2 rounded-[9px] text-xs font-medium flex items-center gap-2 transition cursor-pointer ${
                active
                  ? 'bg-[#171719] text-white font-semibold shadow-2xs'
                  : 'text-[#5e5e63] hover:text-[#171719] hover:bg-[#f5f5f7]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{sec.label}</span>
            </button>
          );
        })}
      </div>

      {/* SECTION 1: GENERAL & TIMEZONE */}
      {activeSection === 'general' && (
        <div className="bg-white border border-[#e7e7ea] rounded-[16px] p-6 shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-5">
          <div>
            <h2 className="text-sm font-bold text-[#171719]">School Identity & Regional Timezone</h2>
            <p className="text-xs text-[#85858a] mt-0.5">
              Used in parent SMS notifications, reports, daily attendance day-rollover boundaries, and ADMS device handshakes.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="schoolName" className="block text-xs font-semibold text-[#171719]">
                Official School Name
              </label>
              <input
                id="schoolName"
                type="text"
                required
                minLength={2}
                maxLength={120}
                value={schoolName}
                onChange={(e) => setSchoolName(e.target.value)}
                className="w-full h-9 px-3 text-xs border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
              />
              <p className="text-[11px] text-[#85858a]">Substituted automatically into {'{school_name}'} in SMS alerts.</p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="academicTermLabel" className="block text-xs font-semibold text-[#171719]">
                Active Term / Academic Session Badge (Optional)
              </label>
              <input
                id="academicTermLabel"
                type="text"
                maxLength={80}
                placeholder="e.g. Term 3 · 2026 or Semester 1"
                value={academicTermLabel}
                onChange={(e) => setAcademicTermLabel(e.target.value)}
                className="w-full h-9 px-3 text-xs border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
              />
              <p className="text-[11px] text-[#85858a]">Displayed on the school overview dashboard header when set.</p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="supportPhone" className="block text-xs font-semibold text-[#171719]">
                School Office / Bursar Contact Phone (Optional)
              </label>
              <input
                id="supportPhone"
                type="tel"
                maxLength={32}
                placeholder="+256 772 000 000"
                value={supportPhone}
                onChange={(e) => setSupportPhone(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="timeZoneSelect" className="block text-xs font-semibold text-[#171719]">
                School Time Zone (IANA)
              </label>
              <select
                id="timeZoneSelect"
                value={isCustomTimezone ? '__custom__' : timeZone}
                onChange={(e) => {
                  if (e.target.value !== '__custom__') {
                    setTimeZone(e.target.value);
                  }
                }}
                className="w-full h-9 px-3 text-xs border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
              >
                {COMMON_SCHOOL_TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
                {isCustomTimezone && <option value="__custom__">Custom IANA Zone ({timeZone})</option>}
              </select>
              <input
                type="text"
                aria-label="Custom IANA Time Zone"
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                placeholder="e.g. Africa/Kampala, Africa/Kigali, Africa/Lagos, America/New_York"
                className="w-full h-8 px-3 text-[11px] font-mono border border-[#e1e1e5] rounded-[8px] bg-[#fafafa] text-[#171719] focus:bg-white focus:outline-none focus:border-[#007aff]"
              />
            </div>
          </div>
        </div>
      )}

      {/* SECTION 2: ATTENDANCE CUTOFFS & SESSIONS */}
      {activeSection === 'attendance' && (
        <div className="bg-white border border-[#e7e7ea] rounded-[16px] p-6 shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-5">
          <div>
            <h2 className="text-sm font-bold text-[#171719]">Arrival Cutoffs, Grace Period & Scan Deduplication</h2>
            <p className="text-xs text-[#85858a] mt-0.5">
              Applied consistently across ADMS biometric terminals, the Gate Kiosk, classroom manual registers, and staff check-ins.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="studentLateCutoff" className="block text-xs font-semibold text-[#171719]">
                Student Morning Cutoff Time
              </label>
              <input
                id="studentLateCutoff"
                type="time"
                required
                value={studentLateCutoff}
                onChange={(e) => setStudentLateCutoff(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
              />
              <p className="text-[11px] text-[#85858a]"> Official reporting bell for students.</p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="studentGraceMinutes" className="block text-xs font-semibold text-[#171719]">
                Student Grace Buffer (Minutes)
              </label>
              <input
                id="studentGraceMinutes"
                type="number"
                min={0}
                max={60}
                value={studentGraceMinutes}
                onChange={(e) => setStudentGraceMinutes(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
              />
              <p className="text-[11px] text-[#2da94f] font-medium">
                On-time through {effectiveStudentCutoffLabel}; marked Late after.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="staffLateCutoff" className="block text-xs font-semibold text-[#171719]">
                Teachers & Staff Cutoff Time
              </label>
              <input
                id="staffLateCutoff"
                type="time"
                required
                value={staffLateCutoff}
                onChange={(e) => setStaffLateCutoff(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
              />
              <p className="text-[11px] text-[#85858a]">Applies across biometric terminals, Gate Kiosk, and dashboard.</p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="afternoonSwitchoverTime" className="block text-xs font-semibold text-[#171719]">
                Afternoon Check-Out Switchover
              </label>
              <input
                id="afternoonSwitchoverTime"
                type="time"
                required
                value={afternoonSwitchoverTime}
                onChange={(e) => setAfternoonSwitchoverTime(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
              />
              <p className="text-[11px] text-[#85858a]">
                Classroom registers default to Morning Check-In before this hour and Evening Check-Out after.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="duplicatePunchWindowSeconds" className="block text-xs font-semibold text-[#171719]">
                Biometric Double-Scan Cooldown (Seconds)
              </label>
              <input
                id="duplicatePunchWindowSeconds"
                type="number"
                min={0}
                max={3600}
                value={duplicatePunchWindowSeconds}
                onChange={(e) => setDuplicatePunchWindowSeconds(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
              />
              <p className="text-[11px] text-[#85858a]">
                Prevents a student holding their finger twice at the gate from logging a Check-In followed immediately by Check-Out.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 3: PARENT SMS & CUSTOM TEMPLATES */}
      {activeSection === 'sms' && (
        <div className="bg-white border border-[#e7e7ea] rounded-[16px] p-6 shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#f1f1f4]">
            <div>
              <h2 className="text-sm font-bold text-[#171719]">Parent SMS Automation, Active Hours & Custom Wording</h2>
              <p className="text-xs text-[#85858a] mt-0.5">
                Choose which attendance events trigger parent SMS messages, active hours, and exact message templates.
              </p>
            </div>

            <label className="inline-flex items-center gap-2.5 cursor-pointer bg-[#f7f7f9] px-3.5 py-2 rounded-[10px] border border-[#e7e7ea]">
              <input
                type="checkbox"
                checked={smsEnabled}
                onChange={(e) => setSmsEnabled(e.target.checked)}
                className="w-4 h-4 accent-[#007aff] rounded"
              />
              <span className="text-xs font-semibold text-[#171719]">Enable Automated Parent SMS</span>
            </label>
          </div>

          {/* Per-event SMS switches */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="p-3.5 border border-[#e7e7ea] rounded-[11px] flex items-start gap-2.5 cursor-pointer hover:bg-[#fafafa]">
              <input
                type="checkbox"
                checked={sendCheckInSms}
                onChange={(e) => setSendCheckInSms(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-[#007aff]"
              />
              <div>
                <div className="text-xs font-semibold text-[#171719]">On-Time Arrival SMS</div>
                <div className="text-[11px] text-[#85858a]">Notify guardian when child checks in on time.</div>
              </div>
            </label>

            <label className="p-3.5 border border-[#e7e7ea] rounded-[11px] flex items-start gap-2.5 cursor-pointer hover:bg-[#fafafa]">
              <input
                type="checkbox"
                checked={sendLateSms}
                onChange={(e) => setSendLateSms(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-[#007aff]"
              />
              <div>
                <div className="text-xs font-semibold text-[#171719]">Late Arrival SMS</div>
                <div className="text-[11px] text-[#85858a]">Notify guardian when child arrives past cutoff.</div>
              </div>
            </label>

            <label className="p-3.5 border border-[#e7e7ea] rounded-[11px] flex items-start gap-2.5 cursor-pointer hover:bg-[#fafafa]">
              <input
                type="checkbox"
                checked={sendCheckOutSms}
                onChange={(e) => setSendCheckOutSms(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-[#007aff]"
              />
              <div>
                <div className="text-xs font-semibold text-[#171719]">Dismissal Check-Out SMS</div>
                <div className="text-[11px] text-[#85858a]">Notify guardian when child leaves school.</div>
              </div>
            </label>
          </div>

          {/* Dispatch Time Windows */}
          <div className="p-4 bg-[#f7f7f9] border border-[#e7e7ea] rounded-[12px] space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold text-[#171719]">Allowed SMS Dispatch Time Windows</h3>
                <p className="text-[11px] text-[#85858a]">
                  Uncheck to permit 24/7 parent SMS notifications (useful for boarding schools, half-days, or weekend prep).
                </p>
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={restrictSmsWindows}
                  onChange={(e) => setRestrictSmsWindows(e.target.checked)}
                  className="w-4 h-4 accent-[#007aff]"
                />
                <span className="text-xs font-semibold text-[#171719]">Restrict SMS to Active Hours</span>
              </label>
            </div>

            {restrictSmsWindows && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-[#171719]">Check-In Window Start</label>
                  <input
                    type="time"
                    value={checkInSmsStart}
                    onChange={(e) => setCheckInSmsStart(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white border border-[#e1e1e5] rounded-[8px]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-[#171719]">Check-In Window End</label>
                  <input
                    type="time"
                    value={checkInSmsEnd}
                    onChange={(e) => setCheckInSmsEnd(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white border border-[#e1e1e5] rounded-[8px]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-[#171719]">Check-Out Window Start</label>
                  <input
                    type="time"
                    value={checkOutSmsStart}
                    onChange={(e) => setCheckOutSmsStart(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white border border-[#e1e1e5] rounded-[8px]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-[#171719]">Check-Out Window End</label>
                  <input
                    type="time"
                    value={checkOutSmsEnd}
                    onChange={(e) => setCheckOutSmsEnd(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white border border-[#e1e1e5] rounded-[8px]"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Message Templates + Live Previews */}
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#5e5e63]">
              <Sparkles className="w-3.5 h-3.5 text-[#f5a30a]" />
              <span>Available placeholders:</span>
              {['{student_name}', '{first_name}', '{school_name}', '{time}', '{class_name}', '{status}'].map((tok) => (
                <code key={tok} className="px-1.5 py-0.5 bg-[#f2f2f5] rounded font-mono text-[10px] text-[#171719]">
                  {tok}
                </code>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-[#171719]">On-Time Check-In Template</label>
                <textarea
                  rows={3}
                  maxLength={320}
                  value={smsTemplateCheckIn}
                  onChange={(e) => setSmsTemplateCheckIn(e.target.value)}
                  className="w-full p-2.5 text-xs border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
                />
                <div className="p-2.5 rounded-[8px] bg-[#edf9f0] border border-[#d2f4d9] text-[11px] text-[#171719]">
                  <strong className="block text-[10px] uppercase text-[#2da94f] mb-0.5">Live SMS Preview</strong>
                  {sampleCheckInSms}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-[#171719]">Late Arrival Template</label>
                <textarea
                  rows={3}
                  maxLength={320}
                  value={smsTemplateLate}
                  onChange={(e) => setSmsTemplateLate(e.target.value)}
                  className="w-full p-2.5 text-xs border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
                />
                <div className="p-2.5 rounded-[8px] bg-[#fff5e7] border border-[#ffe0b2] text-[11px] text-[#171719]">
                  <strong className="block text-[10px] uppercase text-[#f5a30a] mb-0.5">Live SMS Preview</strong>
                  {sampleLateSms}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-[#171719]">Dismissal Check-Out Template</label>
                <textarea
                  rows={3}
                  maxLength={320}
                  value={smsTemplateCheckOut}
                  onChange={(e) => setSmsTemplateCheckOut(e.target.value)}
                  className="w-full p-2.5 text-xs border border-[#e1e1e5] rounded-[9px] bg-white text-[#171719] focus:outline-none focus:border-[#007aff]"
                />
                <div className="p-2.5 rounded-[8px] bg-[#edf5ff] border border-[#d6e7ff] text-[11px] text-[#171719]">
                  <strong className="block text-[10px] uppercase text-[#007aff] mb-0.5">Live SMS Preview</strong>
                  {sampleCheckOutSms}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 4: CLASSES, PIN SECURITY & HARDWARE LCD */}
      {activeSection === 'hardware' && (
        <div className="bg-white border border-[#e7e7ea] rounded-[16px] p-6 shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-6">
          <div>
            <h2 className="text-sm font-bold text-[#171719]">Class Naming Rules, Teacher PIN Lockout & Terminal LCD Formatting</h2>
            <p className="text-xs text-[#85858a] mt-0.5">
              Adapt class naming conventions (Ugandan P1–S6 vs Grade/Year/Kindergarten), PIN lockout thresholds, biometric IDs, and LCD labels.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="p-4 border border-[#e7e7ea] rounded-[12px] flex items-start gap-3 cursor-pointer hover:bg-[#fafafa]">
              <input
                type="checkbox"
                checked={enforceStandardClassPrefix}
                onChange={(e) => setEnforceStandardClassPrefix(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-[#007aff]"
              />
              <div>
                <div className="text-xs font-bold text-[#171719]">
                  Require Capitalized P / S Class Prefix (e.g. P3, S4)
                </div>
                <div className="text-[11px] text-[#85858a] mt-0.5">
                  Turn off if your school uses free-form class names such as nursery/pre-school streams (e.g. primary-a, senior-1, Reception, Year 7).
                </div>
              </div>
            </label>

            <label className="p-4 border border-[#e7e7ea] rounded-[12px] flex items-start gap-3 cursor-pointer hover:bg-[#fafafa]">
              <input
                type="checkbox"
                checked={lcdShowStudentClass}
                onChange={(e) => setLcdShowStudentClass(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-[#007aff]"
              />
              <div>
                <div className="text-xs font-bold text-[#171719]">
                  Prepend Class Name on Student Terminal LCD
                </div>
                <div className="text-[11px] text-[#85858a] mt-0.5">
                  Displays e.g. <code>P6 Grace Namukasa</code> on the 24-character biometric terminal screen when scanning.
                </div>
              </div>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[#171719]">Max Failed Teacher PIN Attempts</label>
              <input
                type="number"
                min={3}
                max={15}
                value={maxPinFailures}
                onChange={(e) => setMaxPinFailures(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[#171719]">PIN Lockout Duration (Minutes)</label>
              <input
                type="number"
                min={1}
                max={120}
                value={pinLockoutMinutes}
                onChange={(e) => setPinLockoutMinutes(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[#171719]">Starting Auto-Assigned Biometric PIN</label>
              <input
                type="number"
                min={1}
                max={999999}
                value={startingBiometricPin}
                onChange={(e) => setStartingBiometricPin(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[#171719]">Teacher LCD Prefix</label>
              <input
                type="text"
                maxLength={8}
                value={lcdPrefixTeacher}
                onChange={(e) => setLcdPrefixTeacher(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[#171719]">Admin LCD Prefix</label>
              <input
                type="text"
                maxLength={8}
                value={lcdPrefixAdmin}
                onChange={(e) => setLcdPrefixAdmin(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[#171719]">Support Staff LCD Prefix</label>
              <input
                type="text"
                maxLength={8}
                value={lcdPrefixSupport}
                onChange={(e) => setLcdPrefixSupport(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px]"
              />
            </div>
          </div>

          <div className="p-4 bg-[#171719] text-white rounded-[12px] space-y-2.5">
            <div className="text-[10px] font-mono uppercase tracking-wider text-white/60">
              Live 24-Character Terminal LCD Preview
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              {lcdPreviewSamples.map((item) => (
                <div key={item.label} className="bg-white/10 rounded-[8px] px-3 py-2">
                  <div className="text-[10px] text-white/60">{item.label}</div>
                  <div className="font-mono text-xs text-[#6ee7b7] mt-0.5">{item.lcd}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SECTION 5: WALLET & TOP-UP DEFAULTS */}
      {activeSection === 'wallet' && (
        <div className="bg-white border border-[#e7e7ea] rounded-[16px] p-6 shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-[#171719]">SMS Wallet Presets & Low-Balance Alert Threshold</h2>
              <p className="text-xs text-[#85858a] mt-0.5">
                Customize quick Mobile Money top-up buttons and low-balance warning thresholds for your bursar.
              </p>
            </div>
            <div className="px-3.5 py-2 rounded-[10px] bg-[#f7f7f9] border border-[#e7e7ea] text-xs flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[#30b357]" />
              <span className="text-[#5e5e63]">Platform SMS Rate:</span>
              <strong className="font-mono text-[#171719]">{platformSmsRate.toLocaleString()} UGX / SMS</strong>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[#171719]">Default Top-Up Amount (UGX)</label>
              <input
                type="number"
                min={1000}
                max={10000000}
                step={500}
                value={defaultTopUpAmount}
                onChange={(e) => setDefaultTopUpAmount(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[#171719]">Quick Top-Up Buttons (Comma-Separated UGX)</label>
              <input
                type="text"
                value={topUpPresetsText}
                onChange={(e) => setTopUpPresetsText(e.target.value)}
                placeholder="10000, 20000, 50000, 100000, 200000, 500000"
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[#171719]">Low-Balance Warning Threshold (UGX)</label>
              <input
                type="number"
                min={0}
                max={1000000}
                step={500}
                value={lowBalanceThresholdUgx}
                onChange={(e) => setLowBalanceThresholdUgx(e.target.value)}
                className="w-full h-9 px-3 text-xs font-mono border border-[#e1e1e5] rounded-[9px]"
              />
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
