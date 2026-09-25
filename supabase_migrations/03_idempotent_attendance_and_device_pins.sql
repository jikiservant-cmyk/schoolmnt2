-- Release gate: apply after reviewing/cleaning any duplicate device PINs,
-- optional secondary credentials, and attendance notification rows. This must be tested against
-- the production schema in staging before it is applied to production.

DO $$
BEGIN
  IF to_regclass('school.people') IS NULL THEN
    RAISE EXCEPTION 'Required table school.people is missing.';
  END IF;
  IF to_regclass('school.attendance_logs') IS NULL THEN
    RAISE EXCEPTION 'Required table school.attendance_logs is missing.';
  END IF;
  IF to_regclass('school.notifications') IS NULL THEN
    RAISE EXCEPTION 'Required table school.notifications is missing.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM school.people
    WHERE school_id IS NOT NULL
      AND device_user_id IS NOT NULL
      AND btrim(device_user_id::text) <> ''
    GROUP BY school_id, lower(btrim(device_user_id::text))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate device_user_id values exist within a school; clean them before applying migration 03.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM school.notifications
    WHERE school_id IS NOT NULL
      AND notification_type IS NOT NULL
      AND related_id IS NOT NULL
      AND channel IS NOT NULL
    GROUP BY school_id, notification_type, related_id, channel
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate related notification rows exist; reconcile them before applying migration 03.';
  END IF;
END $$;

-- person_credentials is optional for deployments that use people.device_user_id
-- only. When present, provide the exact unique target used by the app's upsert
-- and prevent case/whitespace variants from mapping ambiguously within a school.
DO $$
DECLARE
  has_required_columns BOOLEAN;
  has_duplicate_exact_credentials BOOLEAN;
  has_duplicate_active_credentials BOOLEAN;
BEGIN
  IF to_regclass('school.person_credentials') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(DISTINCT column_name) = 4
  INTO has_required_columns
  FROM information_schema.columns
  WHERE table_schema = 'school'
    AND table_name = 'person_credentials'
    AND column_name IN ('school_id', 'credential_type', 'identifier_value', 'is_active');

  IF NOT COALESCE(has_required_columns, FALSE) THEN
    RETURN;
  END IF;

  EXECUTE $query$
    SELECT EXISTS (
      SELECT 1
      FROM school.person_credentials
      WHERE identifier_value IS NOT NULL
      GROUP BY school_id, credential_type, identifier_value
      HAVING count(*) > 1
    )
  $query$ INTO has_duplicate_exact_credentials;

  IF has_duplicate_exact_credentials THEN
    RAISE EXCEPTION 'Duplicate person_credentials values exist within a school; clean them before applying migration 03.';
  END IF;

  EXECUTE $query$
    SELECT EXISTS (
      SELECT 1
      FROM school.person_credentials
      WHERE is_active = true AND identifier_value IS NOT NULL
      GROUP BY school_id, credential_type, lower(btrim(identifier_value::text))
      HAVING count(*) > 1
    )
  $query$ INTO has_duplicate_active_credentials;

  IF has_duplicate_active_credentials THEN
    RAISE EXCEPTION 'Duplicate active normalized person_credentials values exist within a school; clean them before applying migration 03.';
  END IF;

  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS person_credentials_school_type_identifier_uq
    ON school.person_credentials (school_id, credential_type, identifier_value)';
  EXECUTE $ddl$
    CREATE UNIQUE INDEX IF NOT EXISTS person_credentials_school_type_normalized_uq
      ON school.person_credentials (school_id, credential_type, lower(btrim(identifier_value::text)))
      WHERE is_active = true AND identifier_value IS NOT NULL AND btrim(identifier_value::text) <> ''
  $ddl$;
END $$;

-- Case/whitespace-insensitive uniqueness prevents concurrent PIN assignment
-- from allocating the same terminal user ID to two people in one school.
CREATE UNIQUE INDEX IF NOT EXISTS people_school_device_user_id_uq
  ON school.people (school_id, lower(btrim(device_user_id::text)))
  WHERE device_user_id IS NOT NULL AND btrim(device_user_id::text) <> '';

-- The app generates a stable per-school/person/type/EAT-day key for each mark.
-- NULL values from historical rows remain allowed and do not conflict.
ALTER TABLE school.attendance_logs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_logs_school_idempotency_key_uq
  ON school.attendance_logs (school_id, idempotency_key);

-- A single attendance event can enqueue at most one row per channel. This makes
-- provider retries safe while preserving unrelated notifications with NULL IDs.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_school_related_channel_uq
  ON school.notifications (school_id, notification_type, related_id, channel);

COMMENT ON COLUMN school.attendance_logs.idempotency_key IS
  'Stable school/person/attendance-type/EAT-day key used to make attendance writes idempotent.';

-- Increment failed PIN attempts atomically. A read/modify/write sequence in the
-- application is vulnerable to concurrent guesses that overwrite each other's
-- counters and bypass the lockout threshold.
CREATE OR REPLACE FUNCTION school.record_teacher_pin_failure(
  p_staff_user_id TEXT,
  p_person_id TEXT
)
RETURNS TABLE(failed_attempts INTEGER, locked_until TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  UPDATE school.staff_users AS staff
  SET failed_attempts = COALESCE(staff.failed_attempts, 0) + 1,
      locked_until = CASE
        WHEN COALESCE(staff.failed_attempts, 0) + 1 >= 5
          THEN clock_timestamp() + INTERVAL '10 minutes'
        ELSE staff.locked_until
      END
  WHERE staff.id::TEXT = p_staff_user_id
    AND staff.person_id::TEXT = p_person_id
    AND (staff.locked_until IS NULL OR staff.locked_until <= clock_timestamp())
  RETURNING staff.failed_attempts, staff.locked_until;
$function$;

REVOKE ALL ON FUNCTION school.record_teacher_pin_failure(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION school.record_teacher_pin_failure(TEXT, TEXT) TO service_role;
