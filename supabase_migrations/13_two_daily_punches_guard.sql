-- =============================================================================
-- Migration 13: Strict 2-Write Daily Attendance Rule (1 Morning In + 1 Evening Out)
--
-- Enforces at the PostgreSQL database level that EVERY person can have AT MOST
-- TWO (`2`) attendance records per school day:
--   1. ONE (`1`) Morning Thumb-In record (`attendance_type = 'check_in'`)
--   2. ONE (`1`) Evening Thumb-Out record (`attendance_type = 'check_out'`)
--
-- How it works seamlessly with existing & historical data:
--   1. Creates `school.attendance_logs_duplicates_backup` (locked down behind RLS
--      with zero client grants) so any historical duplicate thumbs are archived
--      safely rather than lost.
--   2. Adds `attendance_date date` on `school.attendance_logs` and installs a
--      `BEFORE INSERT OR UPDATE` trigger (`school.set_attendance_daily_slot()`)
--      that automatically computes `NEW.attendance_date` in the school's own
--      configured timezone (`school.school_settings.time_zone`, defaulting to
--      `'Africa/Kampala'`) even when callers omit `attendance_date`.
--   3. Archives any pre-existing duplicate `(person_id, attendance_date, attendance_type)`
--      rows while preserving the earliest punch (`ORDER BY occurred_at ASC, id ASC`).
--   4. Enforces `CHECK (attendance_type IN ('check_in', 'check_out'))` plus
--      `UNIQUE INDEX attendance_logs_one_in_one_out_per_day (person_id, attendance_date, attendance_type)`.
--
-- 100% idempotent & standalone — safe to run once or re-run anytime in Supabase.
-- =============================================================================

BEGIN;

-- 1. Private backup archive for any historical extra thumbs -------------------
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
END $$;

-- 2. Add `attendance_date` column & safe local-date helper --------------------
ALTER TABLE school.attendance_logs
  ADD COLUMN IF NOT EXISTS attendance_date date;

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
  v_tz text := 'Africa/Kampala';
  v_ts timestamptz := coalesce(p_occurred_at, now());
BEGIN
  IF p_school_id IS NOT NULL AND to_regclass('school.school_settings') IS NOT NULL THEN
    SELECT coalesce(nullif(btrim(ss.time_zone), ''), 'Africa/Kampala')
      INTO v_tz
      FROM school.school_settings ss
     WHERE ss.school_id = p_school_id;
    v_tz := coalesce(v_tz, 'Africa/Kampala');
  END IF;

  BEGIN
    RETURN (v_ts AT TIME ZONE v_tz)::date;
  EXCEPTION WHEN OTHERS THEN
    RETURN (v_ts AT TIME ZONE 'Africa/Kampala')::date;
  END;
END;
$$;

REVOKE ALL ON FUNCTION school.resolve_attendance_local_date(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION school.resolve_attendance_local_date(uuid, timestamptz) TO service_role;

-- 3. Automatic trigger populating `attendance_date` & validating slot ---------
CREATE OR REPLACE FUNCTION school.set_attendance_daily_slot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, school
AS $$
DECLARE
  v_tz text := 'Africa/Kampala';
  v_switchover text := '13:00';
  v_local_hhmm text;
BEGIN
  NEW.occurred_at := coalesce(NEW.occurred_at, now());

  IF NEW.school_id IS NOT NULL AND to_regclass('school.school_settings') IS NOT NULL THEN
    SELECT
      coalesce(nullif(btrim(ss.time_zone), ''), 'Africa/Kampala'),
      coalesce(nullif(btrim(ss.afternoon_switchover_time), ''), '13:00')
    INTO v_tz, v_switchover
    FROM school.school_settings ss
    WHERE ss.school_id = NEW.school_id;

    v_tz := coalesce(v_tz, 'Africa/Kampala');
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

DROP TRIGGER IF EXISTS trg_attendance_logs_daily_slot ON school.attendance_logs;
CREATE TRIGGER trg_attendance_logs_daily_slot
  BEFORE INSERT OR UPDATE ON school.attendance_logs
  FOR EACH ROW
  EXECUTE FUNCTION school.set_attendance_daily_slot();

-- 4. Backfill existing rows cleanly before adding constraints -----------------
UPDATE school.attendance_logs
SET
  occurred_at = coalesce(occurred_at, created_at, now()),
  attendance_date = coalesce(
    attendance_date,
    school.resolve_attendance_local_date(school_id, coalesce(occurred_at, created_at, now()))
  ),
  attendance_type = CASE
    WHEN attendance_type IN ('check_in', 'check_out') THEN attendance_type
    WHEN to_char(coalesce(occurred_at, created_at, now()) AT TIME ZONE 'Africa/Kampala', 'HH24:MI') >= '13:00'
      THEN 'check_out'
    ELSE 'check_in'
  END
WHERE attendance_date IS NULL
   OR occurred_at IS NULL
   OR attendance_type IS NULL
   OR attendance_type NOT IN ('check_in', 'check_out');

-- Archive any pre-existing multiple check_in / multiple check_out rows per day,
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
