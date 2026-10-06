-- Keep device attendance idempotent under retransmits and concurrent uploads.
-- Exact historical duplicates are archived; punches at different instants and
-- manual attendance are deliberately left untouched.
BEGIN;

CREATE TABLE IF NOT EXISTS school.attendance_logs_duplicates_backup
  (LIKE school.attendance_logs INCLUDING DEFAULTS);
ALTER TABLE school.attendance_logs_duplicates_backup
  ADD COLUMN IF NOT EXISTS removed_at timestamptz DEFAULT now();
ALTER TABLE school.attendance_logs_duplicates_backup ENABLE ROW LEVEL SECURITY;

-- The archive must remain private even in projects with broad default grants.
-- Remove any policies left by a prior/manual setup so RLS has no allow rules.
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
END
$$;
REVOKE ALL ON TABLE school.attendance_logs_duplicates_backup FROM PUBLIC;
DO $$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE school.attendance_logs_duplicates_backup FROM anon';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE school.attendance_logs_duplicates_backup FROM authenticated';
  END IF;
END
$$;

-- Retain the first device row for each exact person/time pair. This statement
-- deletes and archives together, so a failed migration cannot lose history.
DO $$
DECLARE moved_count bigint;
BEGIN
  WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY person_id, occurred_at ORDER BY id) AS rn
    FROM school.attendance_logs
    WHERE source = 'device'
      AND person_id IS NOT NULL
      AND occurred_at IS NOT NULL
  ), moved AS (
    DELETE FROM school.attendance_logs AS attendance
    USING ranked
    WHERE attendance.id = ranked.id
      AND ranked.rn > 1
    RETURNING attendance.*
  ), archived AS (
    INSERT INTO school.attendance_logs_duplicates_backup
    SELECT moved.*, now()
    FROM moved
    RETURNING 1
  )
  SELECT count(*) INTO moved_count FROM archived;

  RAISE NOTICE 'Moved % exact duplicate device attendance row(s) to school.attendance_logs_duplicates_backup', moved_count;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_logs_device_punch_once
  ON school.attendance_logs (person_id, occurred_at)
  WHERE source = 'device' AND person_id IS NOT NULL;

COMMIT;
