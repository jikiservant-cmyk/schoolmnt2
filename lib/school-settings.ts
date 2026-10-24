/**
 * Centralized Per-School Operational Settings (STRICTLY NON-FINANCIAL).
 *
 * Schools configure ONLY operational parameters in `school.school_settings`:
 *   - School display identity, academic term label, support phone & IANA timezone
 *   - Student/staff arrival cutoffs, grace minutes, afternoon switchover & scan cooldown
 *   - Parent SMS toggles, delivery hours & single-segment ASCII message templates
 *   - Class naming convention, Teacher PIN lockout thresholds, biometric PIN start & LCD labels
 *
 * SECURITY INVARIANT — ZERO FINANCIAL AUTHORITY FOR TENANTS:
 *   - Schools NEVER have authority to view-as-editable or modify SMS pricing,
 *     carrier rates, wallet balances, top-up amounts/presets, or billing flags.
 *   - Any request containing financial/pricing/wallet keys is explicitly rejected.
 *   - `getSchoolSettings` and `persistSchoolSettings` NEVER read or write
 *     `school.schools.settings` (where legacy financial balance mirrors live).
 */

export const HHMM_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
export const MAX_SMS_TEMPLATE_LENGTH = 160;
export const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;

/**
 * Explicit allowlist of non-financial operational keys a school admin may submit.
 * Any key outside this set — especially any financial/pricing/wallet field — is rejected.
 */
export const ALLOWED_SCHOOL_SETTING_KEYS = new Set<string>([
  'schoolName',
  'academicTermLabel',
  'supportPhone',
  'timeZone',
  'studentLateCutoff',
  'studentGraceMinutes',
  'staffLateCutoff',
  'afternoonSwitchoverTime',
  'duplicatePunchWindowSeconds',
  'smsEnabled',
  'sendCheckInSms',
  'sendLateSms',
  'sendCheckOutSms',
  'restrictSmsWindows',
  'checkInSmsStart',
  'checkInSmsEnd',
  'checkOutSmsStart',
  'checkOutSmsEnd',
  'smsTemplateCheckIn',
  'smsTemplateLate',
  'smsTemplateCheckOut',
  'enforceStandardClassPrefix',
  'maxPinFailures',
  'pinLockoutMinutes',
  'startingBiometricPin',
  'lcdPrefixTeacher',
  'lcdPrefixAdmin',
  'lcdPrefixSupport',
  'lcdShowStudentClass',
]);

const FORBIDDEN_FINANCIAL_KEY_RE =
  /(price|pricing|rate|tariff|fee|cost|balance|wallet|credit|debit|topup|top_up|currency|ugx|ledger|payment|threshold)/i;

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
}

export interface ResolvedSchoolConfiguration extends SchoolPolicySettings {
  schoolId: string;
  schoolName: string;
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
};

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

/**
 * Normalizes smart punctuation copied from Word/WhatsApp to plain GSM-7 ASCII.
 */
export function normalizeGsmAsciiPunctuation(raw: string): string {
  return raw
    .replace(/[\u2018\u2019\u201B`]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ');
}

function cleanText(raw: unknown, maxLen: number, fallback: string, trimTrailing = true): string {
  if (typeof raw !== 'string') return fallback;
  const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, ' ');
  const cleaned = trimTrailing ? stripped.trim() : stripped;
  return cleaned.slice(0, maxLen);
}

function cleanSmsTemplate(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const normalized = normalizeGsmAsciiPunctuation(raw)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_SMS_TEMPLATE_LENGTH);
  return normalized.length >= 10 ? normalized : fallback;
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

/**
 * Normalizes a database row from `school.school_settings` into a strictly typed,
 * bounds-checked `SchoolPolicySettings` object (100% non-financial).
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
    smsTemplateCheckIn: cleanSmsTemplate(
      s.smsTemplateCheckIn ?? s.sms_template_check_in,
      d.smsTemplateCheckIn
    ),
    smsTemplateLate: cleanSmsTemplate(
      s.smsTemplateLate ?? s.sms_template_late,
      d.smsTemplateLate
    ),
    smsTemplateCheckOut: cleanSmsTemplate(
      s.smsTemplateCheckOut ?? s.sms_template_check_out,
      d.smsTemplateCheckOut
    ),
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
  };
}

/**
 * Strictly validates user-submitted settings:
 *   1. Explicitly blocks any financial, SMS pricing, rate, or wallet parameter.
 *   2. Rejects any unknown field outside the non-financial operational allowlist.
 *   3. Enforces valid 24h HH:MM times, safe integer ranges, and single-segment
 *      10–160 ASCII SMS templates (preventing multi-segment carrier billing abuse).
 */
export function validateSchoolSettingsInput(
  input: Record<string, unknown>
): { ok: true; schoolName?: string; policy: SchoolPolicySettings } | { ok: false; error: string } {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_FINANCIAL_KEY_RE.test(key)) {
      return {
        ok: false,
        error: 'Security error: Financial, SMS pricing, and wallet parameters cannot be modified by schools.',
      };
    }
    if (key === 'schoolId' || key === 'school_id') {
      continue;
    }
    if (!ALLOWED_SCHOOL_SETTING_KEYS.has(key)) {
      return {
        ok: false,
        error: `Unsupported settings parameter "${key}". Only operational school policies can be edited.`,
      };
    }
  }

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
  ];
  for (const [key, label, min, max] of rangeChecks) {
    if (input[key] !== undefined && input[key] !== '') {
      const n = Number(input[key]);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
        return {
          ok: false,
          error: `${label} must be a whole number between ${min.toLocaleString()} and ${max.toLocaleString()}.`,
        };
      }
    }
  }

  const templateFields: [string, string][] = [
    ['smsTemplateCheckIn', 'On-Time Check-In SMS Template'],
    ['smsTemplateLate', 'Late Arrival SMS Template'],
    ['smsTemplateCheckOut', 'Dismissal Check-Out SMS Template'],
  ];
  for (const [key, label] of templateFields) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') {
        return { ok: false, error: `${label} must be plain text.` };
      }
      const norm = normalizeGsmAsciiPunctuation(input[key]).replace(/\s{2,}/g, ' ').trim();
      if (norm.length < 10 || norm.length > MAX_SMS_TEMPLATE_LENGTH) {
        return {
          ok: false,
          error: `${label} must be between 10 and ${MAX_SMS_TEMPLATE_LENGTH} characters (single SMS limit).`,
        };
      }
      if (!PRINTABLE_ASCII_RE.test(norm)) {
        return {
          ok: false,
          error: `${label} must contain standard ASCII text only (no emojis or special symbols) so every message stays 1 single SMS.`,
        };
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
 * Renders a school's custom SMS template safely into a single-segment GSM-7 ASCII
 * message (`<= 160` characters, zero UCS-2 emojis/control characters) so a school
 * can never trigger multi-part carrier charges while paying for a single SMS.
 */
export function renderAttendanceSmsMessage(
  settings: SchoolPolicySettings,
  attendanceType: 'check_in' | 'check_out',
  vars: AttendanceSmsTemplateVars
): string {
  const safeStudent = normalizeGsmAsciiPunctuation(vars.studentName || 'Student')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  const firstName = safeStudent.split(/\s+/)[0] || safeStudent || 'Student';
  const safeSchool = normalizeGsmAsciiPunctuation(vars.schoolName || 'school')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  const safeClass = normalizeGsmAsciiPunctuation(vars.className || '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  const statusLabel = vars.status === 'late' ? 'late' : 'on time';

  const template =
    attendanceType === 'check_out'
      ? settings.smsTemplateCheckOut
      : vars.status === 'late'
        ? settings.smsTemplateLate
        : settings.smsTemplateCheckIn;

  return normalizeGsmAsciiPunctuation(template)
    .replace(/\{student_name\}/gi, safeStudent || 'Student')
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{school_name\}/gi, safeSchool || 'school')
    .replace(/\{time\}/gi, vars.time)
    .replace(/\{class_name\}/gi, safeClass || 'school')
    .replace(/\{status\}/gi, statusLabel)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_SMS_TEMPLATE_LENGTH);
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
 * Loads the resolved operational settings for a school strictly from
 * `school.school_settings` + `school.schools(id, name[, timezone])`.
 * Matches PostgreSQL timezone fallback order (`school.school_settings.time_zone`
 * -> `school.schools.timezone` -> `'Africa/Kampala'`) while NEVER reading or
 * touching `school.schools.settings` (which holds legacy financial state).
 */
export async function getSchoolSettings(
  adminClient: any,
  schoolId: string
): Promise<ResolvedSchoolConfiguration> {
  const [schoolRes, settingsRes] = await Promise.all([
    adminClient.from('schools').select('id, name, timezone').eq('id', schoolId).maybeSingle(),
    adminClient.from('school_settings').select('*').eq('school_id', schoolId).maybeSingle(),
  ]);

  let schoolRow = schoolRes.data;
  if (schoolRes.error) {
    const fallbackSchool = await adminClient.from('schools').select('id, name').eq('id', schoolId).maybeSingle();
    schoolRow = fallbackSchool.data;
  }

  const schoolName = schoolRow?.name || 'School';
  const rawPolicy: Record<string, unknown> | null =
    !settingsRes.error && settingsRes.data
      ? settingsRes.data
      : schoolRow?.timezone
        ? { time_zone: schoolRow.timezone }
        : null;

  return {
    schoolId,
    schoolName,
    ...normalizeSchoolPolicySettings(rawPolicy),
  };
}

/**
 * Persists validated non-financial settings exclusively via `school.save_school_settings(...)`.
 * NEVER writes to `school.schools.settings` JSONB under any circumstance so financial
 * state (`balance`, `wallet_migrated`, platform billing metadata) can never be touched.
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

  if (isMissingSchoolSettingsRelation(rpcRes.error)) {
    return {
      ok: false,
      error:
        'Database migration 12_school_settings.sql has not been applied in Supabase yet. Run supabase_migrations/12_school_settings.sql in Supabase SQL Editor first.',
    };
  }

  console.error('[School Settings] save_school_settings RPC error:', rpcRes.error);
  return { ok: false, error: 'Failed to save school settings.' };
}
