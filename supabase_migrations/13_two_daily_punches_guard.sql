-- =============================================================================
-- Migration 13: Strict 2-Write Daily Attendance Rule (1 Morning In + 1 Evening Out)
--
-- Enforces at the PostgreSQL database level that EVERY person has AT MOST TWO (`2`)
-- attendance records per school day:
--   1. ONE (`1`) Morning Thumb-In record (`attendance_type = 'check_in'`)
--   2. ONE (`1`) Evening Thumb-Out record (`attendance_type = 'check_out'`)
--
-- Key production guarantees:
--   - Archives any historical same-day duplicate `(person_id, attendance_date, attendance_type)`
--     rows into `school.attendance_logs_duplicates_backup` (`service_role` access only;
--     zero grants to `PUBLIC`, `anon`, or `authenticated`), keeping earliest punch.
--   - Preserves historical `attendance_type` values on existing rows (e.g. historical
--     after-cutoff `late` `check_in` punches are NOT rewritten to `check_out`).
--   - Removes column default on `attendance_type` so new inserts omitting `attendance_type`
--     are classified automatically against the school's cutoff in local time.
--   - Resolves school timezone via:
--       `school.school_settings.time_zone` -> `school.schools.timezone` -> `'Africa/Kampala'`.
--   - Enforces `CHECK (attendance_type IN ('check_in', 'check_out'))` and
--     `UNIQUE INDEX attendance_logs_one_in_one_out_per_day (person_id, attendance_date, attendance_type)`.
--
-- 100% idempotent & standalone — safe to run once or re-run anytime in Supabase.
-- =============================================================================

BEGIN;

-- 1. Private backup archive for historical duplicate punches ------------------
CREATE TABLE IF NOT EXISTS school.attendance_logs_duplicates_backup
  (LIKE school.attendance_logs INCLUDING DEFAULTS);

ALTER TABLE school.attendance_logs_duplicates_backup
  ADD COLUMN IF NOT EXISTS attendance_date date;
ALTER TABLE school.attendance_logs_duplicates_backup
  ADD COLUMN IF NOT EXISTS removed_at timestamptz DEFAULT now();
ALTER TABLE school.attendance_logs_duplicates_backup
  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE policy_name text;
BEGIN
  FOR policy_name IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'school'
      AND tablename = 'attendance_logs_duplicates_backup'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON school.attendance_logs_duplicates_backup', policy_name);
  END LOOP;
END $$;

REVOKE ALL ON TABLE school.attendance_logs_duplicates_backup FROM PUBLIC;
DO $$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE school.attendance_logs_duplicates_backup FROM anon';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE school.attendance_logs_duplicates_backup FROM authenticated';
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE school.attendance_logs_duplicates_backup TO service_role';
  END IF;
END $$;

-- 2. Add `attendance_date`, drop default on `attendance_type` & add helpers ---
ALTER TABLE school.attendance_logs
  ADD COLUMN IF NOT EXISTS attendance_date date;

ALTER TABLE school.attendance_logs
  ALTER COLUMN attendance_type DROP DEFAULT;

-- Resolves a school's IANA timezone:
--   1. `school.school_settings.time_zone`
--   2. `school.schools.timezone` (if column exists on `school.schools`)
--   3. `'Africa/Kampala'`
CREATE OR REPLACE FUNCTION school.resolve_school_timezone(p_school_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, school
AS $$
DECLARE
  v_tz text;
BEGIN
  IF p_school_id IS NOT NULL AND to_regclass('school.school_settings') IS NOT NULL THEN
    SELECT nullif(btrim(ss.time_zone), '')
      INTO v_tz
      FROM school.school_settings ss
     WHERE ss.school_id = p_school_id;
  END IF;

  IF v_tz IS NULL AND p_school_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'school'
       AND table_name = 'schools'
       AND column_name = 'timezone'
  ) THEN
    EXECUTE 'SELECT nullif(btrim(timezone::text), '''') FROM school.schools WHERE id = $1'
       INTO v_tz
      USING p_school_id;
  END IF;

  RETURN coalesce(v_tz, 'Africa/Kampala');
END;
$$;

REVOKE ALL ON FUNCTION school.resolve_school_timezone(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION school.resolve_school_timezone(uuid) TO service_role;

CREATE OR REPLACE FUNCTION school.resolve_attendance_local_date(
  p_school_id uuid,
  p_occurred_at timestamptz
) RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, school
AS $$
DECLARE
  v_tz text := school.resolve_school_timezone(p_school_id);
  v_ts timestamptz := coalesce(p_occurred_at, now());
BEGIN
  BEGIN
    RETURN (v_ts AT TIME ZONE v_tz)::date;
  EXCEPTION WHEN OTHERS THEN
    RETURN (v_ts AT TIME ZONE 'Africa/Kampala')::date;
  END;
END;
$$;

REVOKE ALL ON FUNCTION school.resolve_attendance_local_date(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION school.resolve_attendance_local_date(uuid, timestamptz) TO service_role;

-- 3. Backfill historical rows BEFORE attaching trigger so existing after-cutoff
--    `late` `check_in` punches keep their recorded `attendance_type` intact!
DROP TRIGGER IF EXISTS trg_attendance_logs_daily_slot ON school.attendance_logs;

UPDATE school.attendance_logs
SET
  occurred_at = coalesce(occurred_at, created_at, now()),
  attendance_date = school.resolve_attendance_local_date(
    school_id,
    coalesce(occurred_at, created_at, now())
  ),
  attendance_type = CASE
    WHEN attendance_type IN ('check_in', 'check_out') THEN attendance_type
    WHEN to_char(
      coalesce(occurred_at, created_at, now()) AT TIME ZONE school.resolve_school_timezone(school_id),
      'HH24:MI'
    ) >= '13:00'
      THEN 'check_out'
    ELSE 'check_in'
  END
WHERE attendance_date IS NULL
   OR occurred_at IS NULL
   OR attendance_type IS NULL
   OR attendance_type NOT IN ('check_in', 'check_out');

-- Archive any pre-existing duplicate `(person_id, attendance_date, attendance_type)` rows,
-- keeping the earliest punch (`ORDER BY occurred_at ASC, id ASC`).
DO $$
DECLARE
  common_cols text;
  moved_count bigint;
BEGIN
  SELECT string_agg(quote_ident(a.column_name), ', ' ORDER BY a.ordinal_position)
    INTO common_cols
    FROM information_schema.columns a
    JOIN information_schema.columns b
      ON b.table_schema = 'school'
     AND b.table_name = 'attendance_logs_duplicates_backup'
     AND b.column_name = a.column_name
   WHERE a.table_schema = 'school'
     AND a.table_name = 'attendance_logs';

  EXECUTE format(
    $q$
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY person_id, attendance_date, attendance_type
                 ORDER BY occurred_at ASC, id ASC
               ) AS rn
        FROM school.attendance_logs
        WHERE person_id IS NOT NULL
      ), moved AS (
        DELETE FROM school.attendance_logs AS att
        USING ranked
        WHERE att.id = ranked.id
          AND ranked.rn > 1
        RETURNING att.*
      ), archived AS (
        INSERT INTO school.attendance_logs_duplicates_backup (%s, removed_at)
        SELECT %s, now()
        FROM moved
        RETURNING 1
      )
      SELECT count(*) FROM archived
    $q$,
    common_cols,
    common_cols
  ) INTO moved_count;

  RAISE NOTICE 'Archived % duplicate daily attendance row(s) into school.attendance_logs_duplicates_backup', moved_count;
END $$;

-- 4. Install automatic daily-slot trigger for all new inserts & time/type/school updates
CREATE OR REPLACE FUNCTION school.set_attendance_daily_slot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, school
AS $$
DECLARE
  v_tz text := school.resolve_school_timezone(NEW.school_id);
  v_switchover text := '13:00';
  v_local_hhmm text;
BEGIN
  NEW.occurred_at := coalesce(NEW.occurred_at, now());

  IF NEW.school_id IS NOT NULL AND to_regclass('school.school_settings') IS NOT NULL THEN
    SELECT coalesce(nullif(btrim(ss.afternoon_switchover_time), ''), '13:00')
      INTO v_switchover
      FROM school.school_settings ss
     WHERE ss.school_id = NEW.school_id;
    v_switchover := coalesce(v_switchover, '13:00');
  END IF;

  BEGIN
    NEW.attendance_date := (NEW.occurred_at AT TIME ZONE v_tz)::date;
    v_local_hhmm := to_char(NEW.occurred_at AT TIME ZONE v_tz, 'HH24:MI');
  EXCEPTION WHEN OTHERS THEN
    NEW.attendance_date := (NEW.occurred_at AT TIME ZONE 'Africa/Kampala')::date;
    v_local_hhmm := to_char(NEW.occurred_at AT TIME ZONE 'Africa/Kampala', 'HH24:MI');
  END;

  IF NEW.attendance_type IS NULL THEN
    NEW.attendance_type := CASE
      WHEN v_local_hhmm >= v_switchover THEN 'check_out'
      ELSE 'check_in'
    END;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION school.set_attendance_daily_slot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION school.set_attendance_daily_slot() TO service_role;

CREATE TRIGGER trg_attendance_logs_daily_slot
  BEFORE INSERT OR UPDATE OF occurred_at, attendance_type, school_id, attendance_date
  ON school.attendance_logs
  FOR EACH ROW
  EXECUTE FUNCTION school.set_attendance_daily_slot();

-- 5. Hard PostgreSQL constraints: MAX 2 ROWS / DAY (1 `check_in` + 1 `check_out`)
ALTER TABLE school.attendance_logs
  ALTER COLUMN attendance_date SET NOT NULL;

ALTER TABLE school.attendance_logs
  DROP CONSTRAINT IF EXISTS attendance_logs_valid_type_chk;

ALTER TABLE school.attendance_logs
  ADD CONSTRAINT attendance_logs_valid_type_chk
  CHECK (attendance_type IN ('check_in', 'check_out'));

CREATE UNIQUE INDEX IF NOT EXISTS attendance_logs_one_in_one_out_per_day
  ON school.attendance_logs (person_id, attendance_date, attendance_type)
  WHERE person_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
