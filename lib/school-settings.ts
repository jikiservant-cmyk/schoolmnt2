/**
 * Centralized Per-School Configurable Policies & Operational Settings.
 *
 * Replaces hardcoded cutoffs, SMS windows, templates, class naming rules,
 * PIN lockout rules, biometric PIN start ranges, LCD prefixes, and top-up
 * defaults across the entire application so each school configures its own
 * rules in PostgreSQL (`school.school_settings` + `school.schools.settings.policy`
 * fallback for pre-migration-12 deployments).
 */

export const HHMM_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export const COMMON_SCHOOL_TIMEZONES = [
  { value: 'Africa/Kampala', label: 'East Africa Time — Kampala (UTC+3)' },
  { value: 'Africa/Nairobi', label: 'East Africa Time — Nairobi (UTC+3)' },
  { value: 'Africa/Dar_es_Salaam', label: 'East Africa Time — Dar es Salaam (UTC+3)' },
  { value: 'Africa/Juba', label: 'Central Africa Time — Juba (UTC+2)' },
  { value: 'Africa/Kigali', label: 'Central Africa Time — Kigali (UTC+2)' },
  { value: 'Africa/Bujumbura', label: 'Central Africa Time — Bujumbura (UTC+2)' },
  { value: 'Africa/Lubumbashi', label: 'Central Africa Time — Lubumbashi / Goma (UTC+2)' },
  { value: 'Africa/Kinshasa', label: 'West Africa Time — Kinshasa (UTC+1)' },
  { value: 'Africa/Lagos', label: 'West Africa Time — Lagos (UTC+1)' },
  { value: 'Africa/Johannesburg', label: 'South Africa Standard Time (UTC+2)' },
  { value: 'Africa/Addis_Ababa', label: 'East Africa Time — Addis Ababa (UTC+3)' },
  { value: 'Africa/Cairo', label: 'Eastern European Time — Cairo' },
  { value: 'Europe/London', label: 'United Kingdom — London (GMT/BST)' },
  { value: 'UTC', label: 'Coordinated Universal Time (UTC)' },
] as const;

export interface SchoolPolicySettings {
  academicTermLabel: string;
  supportPhone: string;
  timeZone: string;
  studentLateCutoff: string;
  studentGraceMinutes: number;
  staffLateCutoff: string;
  afternoonSwitchoverTime: string;
  duplicatePunchWindowSeconds: number;
  smsEnabled: boolean;
  sendCheckInSms: boolean;
  sendLateSms: boolean;
  sendCheckOutSms: boolean;
  restrictSmsWindows: boolean;
  checkInSmsStart: string;
  checkInSmsEnd: string;
  checkOutSmsStart: string;
  checkOutSmsEnd: string;
  smsTemplateCheckIn: string;
  smsTemplateLate: string;
  smsTemplateCheckOut: string;
  enforceStandardClassPrefix: boolean;
  maxPinFailures: number;
  pinLockoutMinutes: number;
  startingBiometricPin: number;
  lcdPrefixTeacher: string;
  lcdPrefixAdmin: string;
  lcdPrefixSupport: string;
  lcdShowStudentClass: boolean;
  defaultTopUpAmount: number;
  topUpPresets: number[];
  lowBalanceThresholdUgx: number;
}

export interface ResolvedSchoolConfiguration extends SchoolPolicySettings {
  schoolId: string;
  schoolName: string;
  platformSmsUnitCostUgx: number;
}

export const DEFAULT_SCHOOL_POLICY_SETTINGS: SchoolPolicySettings = {
  academicTermLabel: '',
  supportPhone: '',
  timeZone: 'Africa/Kampala',
  studentLateCutoff: '08:00',
  studentGraceMinutes: 0,
  staffLateCutoff: '08:30',
  afternoonSwitchoverTime: '13:00',
  duplicatePunchWindowSeconds: 120,
  smsEnabled: true,
  sendCheckInSms: true,
  sendLateSms: true,
  sendCheckOutSms: true,
  restrictSmsWindows: true,
  checkInSmsStart: '05:00',
  checkInSmsEnd: '09:00',
  checkOutSmsStart: '16:00',
  checkOutSmsEnd: '22:00',
  smsTemplateCheckIn:
    'Dear Parent, your child {student_name} checked in safely at {school_name} at {time}.',
  smsTemplateLate:
    'Dear Parent, your child {student_name} arrived LATE at {school_name} at {time}.',
  smsTemplateCheckOut:
    'Dear Parent, your child {student_name} checked OUT of {school_name} safely at {time}.',
  enforceStandardClassPrefix: true,
  maxPinFailures: 5,
  pinLockoutMinutes: 10,
  startingBiometricPin: 101,
  lcdPrefixTeacher: 'Tr. ',
  lcdPrefixAdmin: 'Adm. ',
  lcdPrefixSupport: 'Stf. ',
  lcdShowStudentClass: true,
  defaultTopUpAmount: 50000,
  topUpPresets: [10000, 20000, 50000, 100000, 200000, 500000],
  lowBalanceThresholdUgx: 5000,
};

/**
 * Server-controlled SMS unit price in UGX (`SMS_UNIT_COST_UGX` env var, default 50).
 * Never client-writable so tenants cannot lower their own per-SMS charge.
 */
export function getPlatformSmsUnitCostUgx(): number {
  const raw = process.env.SMS_UNIT_COST_UGX;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 100_000) {
      return n;
    }
  }
  return 50;
}

export function isValidIanaTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function parseHhMmToMinutes(hhmm: string, fallbackMinutes: number): number {
  const m = HHMM_RE.exec((hhmm || '').trim());
  if (!m) return fallbackMinutes;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function formatHhMm12Hour(hhmm: string): string {
  const m = HHMM_RE.exec((hhmm || '').trim());
  if (!m) return hhmm;
  const h24 = parseInt(m[1], 10);
  const mins = m[2];
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 || 12;
  return `${String(h12).padStart(2, '0')}:${mins} ${suffix}`;
}

function cleanText(raw: unknown, maxLen: number, fallback: string, trimTrailing = true): string {
  if (typeof raw !== 'string') return fallback;
  const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, ' ');
  const cleaned = trimTrailing ? stripped.trim() : stripped;
  return cleaned.slice(0, maxLen);
}

function cleanHhMm(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return HHMM_RE.test(trimmed) ? trimmed : fallback;
}

function cleanInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.trunc(n);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function cleanBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

function cleanTopUpPresets(raw: unknown): number[] {
  let list: unknown[] | null = null;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!list) return [...DEFAULT_SCHOOL_POLICY_SETTINGS.topUpPresets];
  const nums = Array.from(
    new Set(
      list
        .map((v) => (typeof v === 'number' ? Math.trunc(v) : parseInt(String(v).replace(/[^0-9-]/g, ''), 10)))
        .filter((n) => Number.isFinite(n) && n >= 500 && n <= 10_000_000)
    )
  ).sort((a, b) => a - b);
  return nums.length >= 1 ? nums.slice(0, 6) : [...DEFAULT_SCHOOL_POLICY_SETTINGS.topUpPresets];
}

/**
 * Normalizes a database row from `school.school_settings` OR JSONB `policy` object
 * into a fully typed, bounds-checked `SchoolPolicySettings` object.
 */
export function normalizeSchoolPolicySettings(
  raw?: Record<string, unknown> | null
): SchoolPolicySettings {
  const s = raw || {};
  const d = DEFAULT_SCHOOL_POLICY_SETTINGS;

  return {
    academicTermLabel: cleanText(s.academicTermLabel ?? s.academic_term_label, 80, d.academicTermLabel),
    supportPhone: cleanText(s.supportPhone ?? s.support_phone, 32, d.supportPhone),
    timeZone: isValidIanaTimeZone(s.timeZone ?? s.time_zone)
      ? String(s.timeZone ?? s.time_zone).trim()
      : d.timeZone,
    studentLateCutoff: cleanHhMm(s.studentLateCutoff ?? s.student_late_cutoff, d.studentLateCutoff),
    studentGraceMinutes: cleanInt(s.studentGraceMinutes ?? s.student_grace_minutes, 0, 60, d.studentGraceMinutes),
    staffLateCutoff: cleanHhMm(s.staffLateCutoff ?? s.staff_late_cutoff, d.staffLateCutoff),
    afternoonSwitchoverTime: cleanHhMm(
      s.afternoonSwitchoverTime ?? s.afternoon_switchover_time,
      d.afternoonSwitchoverTime
    ),
    duplicatePunchWindowSeconds: cleanInt(
      s.duplicatePunchWindowSeconds ?? s.duplicate_punch_window_seconds,
      0,
      3600,
      d.duplicatePunchWindowSeconds
    ),
    smsEnabled: cleanBool(s.smsEnabled ?? s.sms_enabled, d.smsEnabled),
    sendCheckInSms: cleanBool(s.sendCheckInSms ?? s.send_check_in_sms, d.sendCheckInSms),
    sendLateSms: cleanBool(s.sendLateSms ?? s.send_late_sms, d.sendLateSms),
    sendCheckOutSms: cleanBool(s.sendCheckOutSms ?? s.send_check_out_sms, d.sendCheckOutSms),
    restrictSmsWindows: cleanBool(s.restrictSmsWindows ?? s.restrict_sms_windows, d.restrictSmsWindows),
    checkInSmsStart: cleanHhMm(s.checkInSmsStart ?? s.check_in_sms_start, d.checkInSmsStart),
    checkInSmsEnd: cleanHhMm(s.checkInSmsEnd ?? s.check_in_sms_end, d.checkInSmsEnd),
    checkOutSmsStart: cleanHhMm(s.checkOutSmsStart ?? s.check_out_sms_start, d.checkOutSmsStart),
    checkOutSmsEnd: cleanHhMm(s.checkOutSmsEnd ?? s.check_out_sms_end, d.checkOutSmsEnd),
    smsTemplateCheckIn:
      cleanText(s.smsTemplateCheckIn ?? s.sms_template_check_in, 320, '') || d.smsTemplateCheckIn,
    smsTemplateLate:
      cleanText(s.smsTemplateLate ?? s.sms_template_late, 320, '') || d.smsTemplateLate,
    smsTemplateCheckOut:
      cleanText(s.smsTemplateCheckOut ?? s.sms_template_check_out, 320, '') || d.smsTemplateCheckOut,
    enforceStandardClassPrefix: cleanBool(
      s.enforceStandardClassPrefix ?? s.enforce_standard_class_prefix,
      d.enforceStandardClassPrefix
    ),
    maxPinFailures: cleanInt(s.maxPinFailures ?? s.max_pin_failures, 3, 15, d.maxPinFailures),
    pinLockoutMinutes: cleanInt(s.pinLockoutMinutes ?? s.pin_lockout_minutes, 1, 120, d.pinLockoutMinutes),
    startingBiometricPin: cleanInt(
      s.startingBiometricPin ?? s.starting_biometric_pin,
      1,
      999_999,
      d.startingBiometricPin
    ),
    lcdPrefixTeacher:
      s.lcdPrefixTeacher !== undefined || s.lcd_prefix_teacher !== undefined
        ? cleanText(s.lcdPrefixTeacher ?? s.lcd_prefix_teacher, 8, d.lcdPrefixTeacher, false)
        : d.lcdPrefixTeacher,
    lcdPrefixAdmin:
      s.lcdPrefixAdmin !== undefined || s.lcd_prefix_admin !== undefined
        ? cleanText(s.lcdPrefixAdmin ?? s.lcd_prefix_admin, 8, d.lcdPrefixAdmin, false)
        : d.lcdPrefixAdmin,
    lcdPrefixSupport:
      s.lcdPrefixSupport !== undefined || s.lcd_prefix_support !== undefined
        ? cleanText(s.lcdPrefixSupport ?? s.lcd_prefix_support, 8, d.lcdPrefixSupport, false)
        : d.lcdPrefixSupport,
    lcdShowStudentClass: cleanBool(
      s.lcdShowStudentClass ?? s.lcd_show_student_class,
      d.lcdShowStudentClass
    ),
    defaultTopUpAmount: cleanInt(
      s.defaultTopUpAmount ?? s.default_topup_amount,
      1000,
      10_000_000,
      d.defaultTopUpAmount
    ),
    topUpPresets: cleanTopUpPresets(s.topUpPresets ?? s.topup_presets),
    lowBalanceThresholdUgx: cleanInt(
      s.lowBalanceThresholdUgx ?? s.low_balance_threshold_ugx,
      0,
      1_000_000,
      d.lowBalanceThresholdUgx
    ),
  };
}

/**
 * Strictly validates user-submitted settings so invalid times or out-of-range
 * numbers return clear human-friendly errors instead of silently ignoring typos.
 */
export function validateSchoolSettingsInput(
  input: Record<string, unknown>
): { ok: true; schoolName?: string; policy: SchoolPolicySettings } | { ok: false; error: string } {
  let schoolName: string | undefined;
  if (input.schoolName !== undefined) {
    if (typeof input.schoolName !== 'string') {
      return { ok: false, error: 'School name must be valid text.' };
    }
    const cleanName = input.schoolName.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (cleanName.length < 2 || cleanName.length > 120) {
      return { ok: false, error: 'School name must be between 2 and 120 characters.' };
    }
    schoolName = cleanName;
  }

  if (input.timeZone !== undefined && !isValidIanaTimeZone(input.timeZone)) {
    return { ok: false, error: 'Please select a valid IANA time zone (e.g. Africa/Kampala).' };
  }

  const timeFields: [string, string][] = [
    ['studentLateCutoff', 'Student Late Cutoff'],
    ['staffLateCutoff', 'Staff Late Cutoff'],
    ['afternoonSwitchoverTime', 'Afternoon Switchover Time'],
    ['checkInSmsStart', 'Morning Check-In SMS Start'],
    ['checkInSmsEnd', 'Morning Check-In SMS End'],
    ['checkOutSmsStart', 'Dismissal Check-Out SMS Start'],
    ['checkOutSmsEnd', 'Dismissal Check-Out SMS End'],
  ];
  for (const [key, label] of timeFields) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !HHMM_RE.test(input[key].trim()))) {
      return { ok: false, error: `${label} must use 24-hour HH:MM format (e.g. 08:00 or 16:30).` };
    }
  }

  const rangeChecks: [string, string, number, number][] = [
    ['studentGraceMinutes', 'Student grace minutes', 0, 60],
    ['duplicatePunchWindowSeconds', 'Duplicate scan cooldown (seconds)', 0, 3600],
    ['maxPinFailures', 'Maximum Teacher PIN attempts', 3, 15],
    ['pinLockoutMinutes', 'Teacher PIN lockout duration (minutes)', 1, 120],
    ['startingBiometricPin', 'Starting Biometric PIN', 1, 999_999],
    ['defaultTopUpAmount', 'Default Top-Up amount', 1000, 10_000_000],
    ['lowBalanceThresholdUgx', 'Low balance alert threshold', 0, 1_000_000],
  ];
  for (const [key, label, min, max] of rangeChecks) {
    if (input[key] !== undefined && input[key] !== '') {
      const n = Number(input[key]);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
        return { ok: false, error: `${label} must be a whole number between ${min.toLocaleString()} and ${max.toLocaleString()}.` };
      }
    }
  }

  const policy = normalizeSchoolPolicySettings(input);

  if (policy.restrictSmsWindows) {
    if (parseHhMmToMinutes(policy.checkInSmsStart, 300) > parseHhMmToMinutes(policy.checkInSmsEnd, 540)) {
      return { ok: false, error: 'Morning Check-In SMS start time must be earlier than end time.' };
    }
    if (parseHhMmToMinutes(policy.checkOutSmsStart, 960) > parseHhMmToMinutes(policy.checkOutSmsEnd, 1320)) {
      return { ok: false, error: 'Dismissal Check-Out SMS start time must be earlier than end time.' };
    }
  }

  return { ok: true, schoolName, policy };
}

export interface AttendanceSmsTemplateVars {
  studentName: string;
  schoolName?: string | null;
  time: string;
  className?: string | null;
  status?: 'present' | 'late';
}

/**
 * Renders a school's custom SMS template safely with clean variable substitution.
 */
export function renderAttendanceSmsMessage(
  settings: SchoolPolicySettings,
  attendanceType: 'check_in' | 'check_out',
  vars: AttendanceSmsTemplateVars
): string {
  const safeStudent = (vars.studentName || 'Student').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  const firstName = safeStudent.split(/\s+/)[0] || safeStudent;
  const safeSchool = (vars.schoolName || 'school').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  const safeClass = (vars.className || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  const statusLabel = vars.status === 'late' ? 'late' : 'on time';

  const template =
    attendanceType === 'check_out'
      ? settings.smsTemplateCheckOut
      : vars.status === 'late'
        ? settings.smsTemplateLate
        : settings.smsTemplateCheckIn;

  return template
    .replace(/\{student_name\}/gi, safeStudent)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{school_name\}/gi, safeSchool)
    .replace(/\{time\}/gi, vars.time)
    .replace(/\{class_name\}/gi, safeClass || 'school')
    .replace(/\{status\}/gi, statusLabel)
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 320);
}

/**
 * Checks whether outbound parent SMS should be sent for this attendance event
 * based on the school's event toggles (`smsEnabled`, `sendCheckInSms`, `sendLateSms`, `sendCheckOutSms`).
 */
export function isParentSmsEnabledForEvent(
  settings: SchoolPolicySettings,
  attendanceType: 'check_in' | 'check_out',
  status: 'present' | 'late'
): boolean {
  if (!settings.smsEnabled) return false;
  if (attendanceType === 'check_out') return settings.sendCheckOutSms;
  if (status === 'late') return settings.sendLateSms;
  return settings.sendCheckInSms;
}

function isMissingSchoolSettingsRelation(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === '42P01' || err.code === 'PGRST205' || err.code === 'PGRST202' || err.code === '42883') {
    return true;
  }
  return /school_settings|save_school_settings|could not find the table|could not find the function/i.test(
    err.message || ''
  );
}

/**
 * Loads the complete resolved configuration for a school from `school.school_settings`
 * with automatic fallback to `school.schools.settings.policy` when migration 12
 * has not yet been applied.
 */
export async function getSchoolSettings(
  adminClient: any,
  schoolId: string
): Promise<ResolvedSchoolConfiguration> {
  const [{ data: schoolRow }, settingsRes] = await Promise.all([
    adminClient.from('schools').select('id, name, settings').eq('id', schoolId).maybeSingle(),
    adminClient.from('school_settings').select('*').eq('school_id', schoolId).maybeSingle(),
  ]);

  const schoolName = schoolRow?.name || 'School';
  let rawPolicy: Record<string, unknown> | null = null;

  if (!settingsRes.error && settingsRes.data) {
    rawPolicy = settingsRes.data;
  } else if (schoolRow?.settings && typeof schoolRow.settings.policy === 'object') {
    rawPolicy = schoolRow.settings.policy;
  }

  return {
    schoolId,
    schoolName,
    platformSmsUnitCostUgx: getPlatformSmsUnitCostUgx(),
    ...normalizeSchoolPolicySettings(rawPolicy),
  };
}

/**
 * Persists validated per-school settings via `school.save_school_settings(...)`
 * with safe `MIG12=0` fallback that preserves `settings.balance` and `settings.wallet_migrated`.
 */
export async function persistSchoolSettings(
  adminClient: any,
  schoolId: string,
  policy: SchoolPolicySettings,
  options?: { schoolName?: string; updatedBy?: string | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rpcRes = await adminClient.rpc('save_school_settings', {
    p_school_id: schoolId,
    p_school_name: options?.schoolName ?? null,
    p_policy: policy,
    p_updated_by: options?.updatedBy ?? null,
  });

  if (!rpcRes.error) {
    return { ok: true };
  }

  if (!isMissingSchoolSettingsRelation(rpcRes.error)) {
    console.error('[School Settings] save_school_settings RPC error:', rpcRes.error);
    return { ok: false, error: 'Failed to save school settings.' };
  }

  // Graceful fallback when migration 12 has not been applied yet (`MIG12=0`).
  const { data: currentSchool, error: readErr } = await adminClient
    .from('schools')
    .select('name, settings')
    .eq('id', schoolId)
    .maybeSingle();

  if (readErr || !currentSchool) {
    return { ok: false, error: 'School record not found.' };
  }

  const nextSettings = {
    ...(typeof currentSchool.settings === 'object' && currentSchool.settings !== null
      ? currentSchool.settings
      : {}),
    policy,
  };

  const updatePayload: Record<string, unknown> = { settings: nextSettings };
  if (options?.schoolName && options.schoolName.trim().length >= 2) {
    updatePayload.name = options.schoolName.trim();
  }

  const { error: updErr } = await adminClient
    .from('schools')
    .update(updatePayload)
    .eq('id', schoolId);

  if (updErr) {
    console.error('[School Settings] Fallback update error:', updErr);
    return { ok: false, error: 'Failed to save school settings.' };
  }

  return { ok: true };
}
