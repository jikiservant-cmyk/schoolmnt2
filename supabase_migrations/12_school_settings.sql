-- =============================================================================
-- Migration 12: Per-School Operational Settings + Strict Financial Lockdown
--
-- 1. Stores STRICTLY NON-FINANCIAL per-school operational settings in
--    `school.school_settings` (timezone, attendance cutoffs & grace minutes,
--    SMS delivery windows & single-segment ASCII templates, class naming rules,
--    Teacher PIN lockout rules, biometric PIN start range, terminal LCD labels).
-- 2. ZERO financial / SMS price / wallet / billing columns exist in
--    `school.school_settings`, and `school.save_school_settings(...)` NEVER
--    reads or modifies `school.schools.settings` (where legacy balance metadata
--    lives) AND explicitly rejects any payload containing financial keys.
-- 3. Enforces hard PostgreSQL privilege + RLS lockdown on all financial tables
--    and RPCs (`public.wallets`, `public.transactions`, `public.tenants`,
--    `school.schools`, `school.payment_intents`, `school.payment_events`,
--    `school.notifications`, and all wallet/payment/SMS/pricing functions) so no
--    school admin, teacher, or browser token can ever alter SMS pricing,
--    balances, or ledger entries.
--
-- 100% idempotent & standalone (safe to run once or re-run anytime in Supabase).
-- =============================================================================

BEGIN;

-- 1. Ensure tenant resolver `school.auth_school_id()` exists & is safe ---------
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

-- 2. Non-financial per-school operational settings table -----------------------
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
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid
);

-- Drop any legacy wallet/billing UI columns if an earlier revision existed, and
-- strip any stale `policy` key from `school.schools.settings` so `schools.settings`
-- stays strictly reserved for platform-only data.
ALTER TABLE school.school_settings DROP CONSTRAINT IF EXISTS school_settings_hhmm_chk;
ALTER TABLE school.school_settings DROP CONSTRAINT IF EXISTS school_settings_ranges_chk;
ALTER TABLE school.school_settings DROP COLUMN IF EXISTS default_topup_amount;
ALTER TABLE school.school_settings DROP COLUMN IF EXISTS topup_presets;
ALTER TABLE school.school_settings DROP COLUMN IF EXISTS low_balance_threshold_ugx;

UPDATE school.schools
SET settings = settings - 'policy'
WHERE settings IS NOT NULL AND settings ? 'policy';

-- Re-normalize any over-long or non-ASCII template rows before adding constraints
UPDATE school.school_settings
SET
  sms_template_check_in  = left(regexp_replace(sms_template_check_in,  '[^\x20-\x7E]', '', 'g'), 160),
  sms_template_late      = left(regexp_replace(sms_template_late,      '[^\x20-\x7E]', '', 'g'), 160),
  sms_template_check_out = left(regexp_replace(sms_template_check_out, '[^\x20-\x7E]', '', 'g'), 160);

ALTER TABLE school.school_settings
  ADD CONSTRAINT school_settings_hhmm_chk CHECK (
    student_late_cutoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    staff_late_cutoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    afternoon_switchover_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    check_in_sms_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    check_in_sms_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    check_out_sms_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
    check_out_sms_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  ADD CONSTRAINT school_settings_ranges_chk CHECK (
    student_grace_minutes BETWEEN 0 AND 60 AND
    duplicate_punch_window_seconds BETWEEN 0 AND 3600 AND
    max_pin_failures BETWEEN 3 AND 15 AND
    pin_lockout_minutes BETWEEN 1 AND 120 AND
    starting_biometric_pin BETWEEN 1 AND 999999 AND
    char_length(sms_template_check_in) BETWEEN 10 AND 160 AND
    sms_template_check_in ~ '^[\x20-\x7E]+$' AND
    char_length(sms_template_late) BETWEEN 10 AND 160 AND
    sms_template_late ~ '^[\x20-\x7E]+$' AND
    char_length(sms_template_check_out) BETWEEN 10 AND 160 AND
    sms_template_check_out ~ '^[\x20-\x7E]+$' AND
    char_length(lcd_prefix_teacher) <= 8 AND
    char_length(lcd_prefix_admin) <= 8 AND
    char_length(lcd_prefix_support) <= 8
  );

-- 3. Strictly enforce multi-tenant RLS on `school.school_settings` -------------
ALTER TABLE school.school_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE school.school_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_guard ON school.school_settings;
CREATE POLICY tenant_guard ON school.school_settings
  FOR SELECT TO authenticated
  USING (school_id = school.auth_school_id());

REVOKE ALL ON TABLE school.school_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE school.school_settings TO authenticated;
GRANT ALL ON TABLE school.school_settings TO service_role;

-- 4. Server-only RPC for non-financial settings (ZERO financial touch) ---------
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
  v_bad_key text;
BEGIN
  IF p_school_id IS NULL OR p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' THEN
    RAISE EXCEPTION 'Invalid school settings payload';
  END IF;

  -- HARD DATABASE GUARD: Reject any financial, SMS rate, pricing, or wallet keys.
  SELECT k INTO v_bad_key
  FROM jsonb_object_keys(p_policy) AS k
  WHERE k ~* '(price|pricing|rate|tariff|fee|cost|balance|wallet|credit|debit|topup|top_up|currency|ugx|ledger|payment|threshold)'
  LIMIT 1;

  IF v_bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'Forbidden financial parameter in school settings payload: %', v_bad_key
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM school.schools WHERE id = p_school_id) THEN
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
    updated_at                      = now(),
    updated_by                      = EXCLUDED.updated_by;

  -- Update ONLY `school.schools.name` if changed — NEVER touch `school.schools.settings`!
  IF p_school_name IS NOT NULL AND char_length(btrim(p_school_name)) >= 2 THEN
    UPDATE school.schools
    SET name = btrim(p_school_name)
    WHERE id = p_school_id
      AND name IS DISTINCT FROM btrim(p_school_name);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION school.save_school_settings(uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION school.save_school_settings(uuid, text, jsonb, uuid) TO service_role;

-- 5. Mandatory financial integrity & pricing/wallet table & RPC lockdown -------
-- Guarantees NO school user (`anon` or `authenticated`) can write balances,
-- edit `school.schools.settings`, insert fake ledger rows, alter tenant routing,
-- or call any wallet / credit / debit / payment / SMS / pricing RPC directly.
DO $$
DECLARE
  f record;
  t text;
  wcond text := NULL;
  tcond text := NULL;
  has_sr boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  -- 5a. Lock down `school.schools` against all client writes (protects `settings->'balance'`)
  IF to_regclass('school.schools') IS NOT NULL THEN
    ALTER TABLE school.schools ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_access ON school.schools;
    DROP POLICY IF EXISTS tenant_guard ON school.schools;
    CREATE POLICY tenant_access ON school.schools AS PERMISSIVE FOR SELECT TO authenticated
      USING (id = school.auth_school_id());
    CREATE POLICY tenant_guard ON school.schools AS RESTRICTIVE FOR ALL TO authenticated
      USING (id = school.auth_school_id()) WITH CHECK (id = school.auth_school_id());
    REVOKE ALL ON school.schools FROM PUBLIC, anon;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON school.schools FROM authenticated;
    GRANT SELECT ON school.schools TO authenticated;
  END IF;

  -- 5b. Lock down `public.wallets`, `public.transactions`, `public.tenants`
  IF to_regclass('public.wallets') IS NOT NULL THEN
    SELECT string_agg(format('%I::text = school.auth_school_id()::text', column_name), ' OR ')
      INTO wcond FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'wallets' AND column_name IN ('tenant_id', 'school_id');
    SELECT string_agg(format('w.%I::text = school.auth_school_id()::text', column_name), ' OR ')
      INTO tcond FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'wallets' AND column_name IN ('tenant_id', 'school_id');
    ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS school_wallet_read ON public.wallets;
    IF wcond IS NOT NULL THEN
      EXECUTE 'CREATE POLICY school_wallet_read ON public.wallets FOR SELECT TO authenticated USING (' || wcond || ')';
    END IF;
    REVOKE ALL ON public.wallets FROM PUBLIC, anon;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.wallets FROM authenticated;
    GRANT SELECT ON public.wallets TO authenticated;
  END IF;

  IF to_regclass('public.transactions') IS NOT NULL THEN
    ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS school_tx_read ON public.transactions;
    IF wcond IS NOT NULL AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'wallet_id'
    ) THEN
      EXECUTE 'CREATE POLICY school_tx_read ON public.transactions FOR SELECT TO authenticated USING ('
           || 'EXISTS (SELECT 1 FROM public.wallets w WHERE w.id = wallet_id AND (' || tcond || ')))';
    END IF;
    REVOKE ALL ON public.transactions FROM PUBLIC, anon;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.transactions FROM authenticated;
    GRANT SELECT ON public.transactions TO authenticated;
  END IF;

  IF to_regclass('public.tenants') IS NOT NULL THEN
    ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS own_tenant_read ON public.tenants;
    CREATE POLICY own_tenant_read ON public.tenants FOR SELECT TO authenticated
      USING (id::text = school.auth_school_id()::text);
    REVOKE ALL ON public.tenants FROM PUBLIC, anon;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.tenants FROM authenticated;
    GRANT SELECT ON public.tenants TO authenticated;
  END IF;

  -- 5c. Lock down `school.notifications`, `school.payment_intents`, `school.payment_events`
  FOREACH t IN ARRAY ARRAY['notifications', 'payment_intents', 'payment_events'] LOOP
    IF to_regclass('school.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON school.%I FROM anon, authenticated', t);
  END LOOP;

  -- 5d. Revoke client EXECUTE on every money, SMS, pricing, rate, tariff, or billing RPC
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'school')
      AND p.prokind = 'f'
      AND p.proname ~* '(wallet|credit|debit|balance|payment|topup|top_up|charge|refund|deduct|ledger|sms|price|pricing|rate|tariff|billing)'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f.sig);
    END IF;
    IF has_sr THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
