-- =============================================================================
-- Migration 12: Per-School Configurable Policies & Settings (Round 14)
--
-- Eliminates hardcoded operational rules across devices, Gate Kiosk, Classroom
-- Registers, SMS notifications, class naming, Teacher PIN lockouts, biometric
-- PIN ranges, LCD formatting, and wallet UI defaults — letting every school
-- configure its own rules in PostgreSQL with full Row-Level Security.
--
-- Fully idempotent (safe to re-run on any existing database).
-- =============================================================================

BEGIN;

-- Ensure school.auth_school_id() exists even if 04_rls_tenant_isolation.sql
-- has not been run yet on this Supabase project.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'school' AND p.proname = 'auth_school_id' AND p.pronargs = 0
  ) THEN
    EXECUTE $f$
      CREATE FUNCTION school.auth_school_id() RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, school, public
      AS 'SELECT su.school_id FROM school.staff_users su WHERE su.auth_user_id = auth.uid() LIMIT 1'
    $f$;
  END IF;
END $$;

GRANT USAGE ON SCHEMA school TO authenticated, service_role;
REVOKE ALL ON FUNCTION school.auth_school_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION school.auth_school_id() TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS school.school_settings (
  school_id                       uuid PRIMARY KEY REFERENCES school.schools(id) ON DELETE CASCADE,
  academic_term_label             text NOT NULL DEFAULT '',
  support_phone                   text NOT NULL DEFAULT '',
  time_zone                       text NOT NULL DEFAULT 'Africa/Kampala',
  student_late_cutoff             text NOT NULL DEFAULT '08:00',
  student_grace_minutes           integer NOT NULL DEFAULT 0,
  staff_late_cutoff               text NOT NULL DEFAULT '08:30',
  afternoon_switchover_time       text NOT NULL DEFAULT '13:00',
  duplicate_punch_window_seconds  integer NOT NULL DEFAULT 120,
  sms_enabled                     boolean NOT NULL DEFAULT true,
  send_check_in_sms               boolean NOT NULL DEFAULT true,
  send_late_sms                   boolean NOT NULL DEFAULT true,
  send_check_out_sms              boolean NOT NULL DEFAULT true,
  restrict_sms_windows            boolean NOT NULL DEFAULT true,
  check_in_sms_start              text NOT NULL DEFAULT '05:00',
  check_in_sms_end                text NOT NULL DEFAULT '09:00',
  check_out_sms_start             text NOT NULL DEFAULT '16:00',
  check_out_sms_end               text NOT NULL DEFAULT '22:00',
  sms_template_check_in           text NOT NULL DEFAULT 'Dear Parent, your child {student_name} checked in safely at {school_name} at {time}.',
  sms_template_late               text NOT NULL DEFAULT 'Dear Parent, your child {student_name} arrived LATE at {school_name} at {time}.',
  sms_template_check_out          text NOT NULL DEFAULT 'Dear Parent, your child {student_name} checked OUT of {school_name} safely at {time}.',
  enforce_standard_class_prefix   boolean NOT NULL DEFAULT true,
  max_pin_failures                integer NOT NULL DEFAULT 5,
  pin_lockout_minutes             integer NOT NULL DEFAULT 10,
  starting_biometric_pin          integer NOT NULL DEFAULT 101,
  lcd_prefix_teacher              text NOT NULL DEFAULT 'Tr. ',
  lcd_prefix_admin                text NOT NULL DEFAULT 'Adm. ',
  lcd_prefix_support              text NOT NULL DEFAULT 'Stf. ',
  lcd_show_student_class          boolean NOT NULL DEFAULT true,
  default_topup_amount            integer NOT NULL DEFAULT 50000,
  topup_presets                   jsonb NOT NULL DEFAULT '[10000, 20000, 50000, 100000, 200000, 500000]'::jsonb,
  low_balance_threshold_ugx       integer NOT NULL DEFAULT 5000,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid,

  CONSTRAINT school_settings_hhmm_chk CHECK (
    student_late_cutoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    staff_late_cutoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    afternoon_switchover_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    check_in_sms_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    check_in_sms_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    check_out_sms_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    check_out_sms_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  CONSTRAINT school_settings_ranges_chk CHECK (
    student_grace_minutes BETWEEN 0 AND 60 AND
    duplicate_punch_window_seconds BETWEEN 0 AND 3600 AND
    max_pin_failures BETWEEN 3 AND 15 AND
    pin_lockout_minutes BETWEEN 1 AND 120 AND
    starting_biometric_pin BETWEEN 1 AND 999999 AND
    default_topup_amount BETWEEN 1000 AND 10000000 AND
    low_balance_threshold_ugx BETWEEN 0 AND 1000000 AND
    char_length(sms_template_check_in) <= 320 AND
    char_length(sms_template_late) <= 320 AND
    char_length(sms_template_check_out) <= 320 AND
    char_length(lcd_prefix_teacher) <= 8 AND
    char_length(lcd_prefix_admin) <= 8 AND
    char_length(lcd_prefix_support) <= 8
  )
);

-- Strictly enforce multi-tenant RLS on school.school_settings.
ALTER TABLE school.school_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE school.school_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_guard ON school.school_settings;
CREATE POLICY tenant_guard ON school.school_settings
  FOR SELECT TO authenticated
  USING (school_id = school.auth_school_id());

REVOKE ALL ON TABLE school.school_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE school.school_settings TO authenticated;
GRANT ALL ON TABLE school.school_settings TO service_role;

-- Atomic server-side settings save RPC:
--   1. Upserts normalized columns into `school.school_settings`.
--   2. Optionally updates `school.schools.name` under row lock.
--   3. Mirrors normalized policy JSON into `school.schools.settings->'policy'`
--      WITHOUT ever touching `settings->'balance'` or `settings->'wallet_migrated'`,
--      so concurrent Mobile Money webhook credits and settings edits can NEVER
--      clobber each other's JSONB keys.
CREATE OR REPLACE FUNCTION school.save_school_settings(
  p_school_id uuid,
  p_school_name text,
  p_policy jsonb,
  p_updated_by uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_school_exists boolean;
BEGIN
  IF p_school_id IS NULL OR p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' THEN
    RAISE EXCEPTION 'Invalid school settings payload';
  END IF;

  -- Lock the school row briefly so concurrent updates to `school.schools.settings`
  -- (`apply_payment` mirroring `balance` vs `save_school_settings` mirroring `policy`)
  -- serialize cleanly with zero lost updates.
  SELECT true INTO v_school_exists
  FROM school.schools
  WHERE id = p_school_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'School not found';
  END IF;

  INSERT INTO school.school_settings (
    school_id,
    academic_term_label,
    support_phone,
    time_zone,
    student_late_cutoff,
    student_grace_minutes,
    staff_late_cutoff,
    afternoon_switchover_time,
    duplicate_punch_window_seconds,
    sms_enabled,
    send_check_in_sms,
    send_late_sms,
    send_check_out_sms,
    restrict_sms_windows,
    check_in_sms_start,
    check_in_sms_end,
    check_out_sms_start,
    check_out_sms_end,
    sms_template_check_in,
    sms_template_late,
    sms_template_check_out,
    enforce_standard_class_prefix,
    max_pin_failures,
    pin_lockout_minutes,
    starting_biometric_pin,
    lcd_prefix_teacher,
    lcd_prefix_admin,
    lcd_prefix_support,
    lcd_show_student_class,
    default_topup_amount,
    topup_presets,
    low_balance_threshold_ugx,
    updated_at,
    updated_by
  ) VALUES (
    p_school_id,
    coalesce(p_policy->>'academicTermLabel', ''),
    coalesce(p_policy->>'supportPhone', ''),
    coalesce(p_policy->>'timeZone', 'Africa/Kampala'),
    coalesce(p_policy->>'studentLateCutoff', '08:00'),
    coalesce((p_policy->>'studentGraceMinutes')::integer, 0),
    coalesce(p_policy->>'staffLateCutoff', '08:30'),
    coalesce(p_policy->>'afternoonSwitchoverTime', '13:00'),
    coalesce((p_policy->>'duplicatePunchWindowSeconds')::integer, 120),
    coalesce((p_policy->>'smsEnabled')::boolean, true),
    coalesce((p_policy->>'sendCheckInSms')::boolean, true),
    coalesce((p_policy->>'sendLateSms')::boolean, true),
    coalesce((p_policy->>'sendCheckOutSms')::boolean, true),
    coalesce((p_policy->>'restrictSmsWindows')::boolean, true),
    coalesce(p_policy->>'checkInSmsStart', '05:00'),
    coalesce(p_policy->>'checkInSmsEnd', '09:00'),
    coalesce(p_policy->>'checkOutSmsStart', '16:00'),
    coalesce(p_policy->>'checkOutSmsEnd', '22:00'),
    coalesce(p_policy->>'smsTemplateCheckIn', 'Dear Parent, your child {student_name} checked in safely at {school_name} at {time}.'),
    coalesce(p_policy->>'smsTemplateLate', 'Dear Parent, your child {student_name} arrived LATE at {school_name} at {time}.'),
    coalesce(p_policy->>'smsTemplateCheckOut', 'Dear Parent, your child {student_name} checked OUT of {school_name} safely at {time}.'),
    coalesce((p_policy->>'enforceStandardClassPrefix')::boolean, true),
    coalesce((p_policy->>'maxPinFailures')::integer, 5),
    coalesce((p_policy->>'pinLockoutMinutes')::integer, 10),
    coalesce((p_policy->>'startingBiometricPin')::integer, 101),
    coalesce(p_policy->>'lcdPrefixTeacher', 'Tr. '),
    coalesce(p_policy->>'lcdPrefixAdmin', 'Adm. '),
    coalesce(p_policy->>'lcdPrefixSupport', 'Stf. '),
    coalesce((p_policy->>'lcdShowStudentClass')::boolean, true),
    coalesce((p_policy->>'defaultTopUpAmount')::integer, 50000),
    coalesce(p_policy->'topUpPresets', '[10000, 20000, 50000, 100000, 200000, 500000]'::jsonb),
    coalesce((p_policy->>'lowBalanceThresholdUgx')::integer, 5000),
    now(),
    p_updated_by
  )
  ON CONFLICT (school_id) DO UPDATE SET
    academic_term_label             = EXCLUDED.academic_term_label,
    support_phone                   = EXCLUDED.support_phone,
    time_zone                       = EXCLUDED.time_zone,
    student_late_cutoff             = EXCLUDED.student_late_cutoff,
    student_grace_minutes           = EXCLUDED.student_grace_minutes,
    staff_late_cutoff               = EXCLUDED.staff_late_cutoff,
    afternoon_switchover_time       = EXCLUDED.afternoon_switchover_time,
    duplicate_punch_window_seconds  = EXCLUDED.duplicate_punch_window_seconds,
    sms_enabled                     = EXCLUDED.sms_enabled,
    send_check_in_sms               = EXCLUDED.send_check_in_sms,
    send_late_sms                   = EXCLUDED.send_late_sms,
    send_check_out_sms              = EXCLUDED.send_check_out_sms,
    restrict_sms_windows            = EXCLUDED.restrict_sms_windows,
    check_in_sms_start              = EXCLUDED.check_in_sms_start,
    check_in_sms_end                = EXCLUDED.check_in_sms_end,
    check_out_sms_start             = EXCLUDED.check_out_sms_start,
    check_out_sms_end               = EXCLUDED.check_out_sms_end,
    sms_template_check_in           = EXCLUDED.sms_template_check_in,
    sms_template_late               = EXCLUDED.sms_template_late,
    sms_template_check_out          = EXCLUDED.sms_template_check_out,
    enforce_standard_class_prefix   = EXCLUDED.enforce_standard_class_prefix,
    max_pin_failures                = EXCLUDED.max_pin_failures,
    pin_lockout_minutes             = EXCLUDED.pin_lockout_minutes,
    starting_biometric_pin          = EXCLUDED.starting_biometric_pin,
    lcd_prefix_teacher              = EXCLUDED.lcd_prefix_teacher,
    lcd_prefix_admin                = EXCLUDED.lcd_prefix_admin,
    lcd_prefix_support              = EXCLUDED.lcd_prefix_support,
    lcd_show_student_class          = EXCLUDED.lcd_show_student_class,
    default_topup_amount            = EXCLUDED.default_topup_amount,
    topup_presets                   = EXCLUDED.topup_presets,
    low_balance_threshold_ugx       = EXCLUDED.low_balance_threshold_ugx,
    updated_at                      = now(),
    updated_by                      = EXCLUDED.updated_by;

  UPDATE school.schools
  SET
    name = CASE
      WHEN p_school_name IS NOT NULL AND char_length(btrim(p_school_name)) >= 2
      THEN btrim(p_school_name)
      ELSE name
    END,
    settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{policy}', p_policy, true)
  WHERE id = p_school_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION school.save_school_settings(uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION school.save_school_settings(uuid, text, jsonb, uuid) TO service_role;

-- Reload Supabase PostgREST schema cache immediately so `school_settings`
-- and `save_school_settings` are live the instant this query finishes.
NOTIFY pgrst, 'reload schema';

COMMIT;
