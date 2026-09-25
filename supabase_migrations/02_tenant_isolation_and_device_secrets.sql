-- Tenant isolation hardening for the school schema.
-- Apply through the Supabase SQL editor/migrations before launch. The service-role
-- client bypasses RLS, so server actions and device routes must also keep their
-- explicit school_id checks (covered separately in the application code).

ALTER TABLE school.devices
  ADD COLUMN IF NOT EXISTS device_secret_hash TEXT;

COMMENT ON COLUMN school.devices.device_secret_hash IS
  'SHA-256 digest of the device-specific push token; raw token is shown once at provisioning.';

-- Durable teacher PIN lockout fields referenced by the manual attendance flow.
ALTER TABLE school.staff_users
  ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- A restrictive policy is intentional: it ANDs with any existing permissive
-- policies, preventing a broad legacy policy from exposing another school.
-- A matching permissive policy is also installed so authenticated tenant users
-- retain their normal access even when no prior permissive policy exists.
DO $$
DECLARE
  target_table TEXT;
  has_school_id BOOLEAN;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'devices',
    'device_commands',
    'device_logs',
    'people',
    'person_credentials',
    'classes',
    'academic_years',
    'attendance_logs',
    'notifications',
    'parents',
    'student_parents'
  ] LOOP
    IF to_regclass(format('school.%I', target_table)) IS NULL THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'school'
        AND information_schema.columns.table_name = target_table
        AND column_name = 'school_id'
    ) INTO has_school_id;

    IF has_school_id THEN
      EXECUTE format('ALTER TABLE school.%I ENABLE ROW LEVEL SECURITY', target_table);
      EXECUTE format('DROP POLICY IF EXISTS arena_school_scope_permissive ON school.%I', target_table);
      EXECUTE format('DROP POLICY IF EXISTS arena_school_scope_restrictive ON school.%I', target_table);
      EXECUTE format(
        'CREATE POLICY arena_school_scope_permissive ON school.%I AS PERMISSIVE FOR ALL TO authenticated USING (school_id = school.auth_school_id()) WITH CHECK (school_id = school.auth_school_id())',
        target_table
      );
      EXECUTE format(
        'CREATE POLICY arena_school_scope_restrictive ON school.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (school_id = school.auth_school_id()) WITH CHECK (school_id = school.auth_school_id())',
        target_table
      );
    END IF;
  END LOOP;

  -- A school row is keyed by id rather than school_id.
  IF to_regclass('school.schools') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'school' AND table_name = 'schools' AND column_name = 'id'
  ) THEN
    ALTER TABLE school.schools ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS arena_school_scope_permissive ON school.schools;
    DROP POLICY IF EXISTS arena_school_scope_restrictive ON school.schools;
    CREATE POLICY arena_school_scope_permissive ON school.schools
      AS PERMISSIVE FOR ALL TO authenticated
      USING (id = school.auth_school_id())
      WITH CHECK (id = school.auth_school_id());
    CREATE POLICY arena_school_scope_restrictive ON school.schools
      AS RESTRICTIVE FOR ALL TO anon, authenticated
      USING (id = school.auth_school_id())
      WITH CHECK (id = school.auth_school_id());
  END IF;

  -- Staff login rows contain PIN hashes and lockout state. Browser sessions may
  -- read only their own staff_users row; privileged server actions validate the
  -- teacher's school through school.people before using the service-role client.
  IF to_regclass('school.staff_users') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'school' AND table_name = 'staff_users' AND column_name = 'auth_user_id'
  ) THEN
    ALTER TABLE school.staff_users ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS arena_staff_self_select ON school.staff_users;
    DROP POLICY IF EXISTS arena_staff_self_restrictive ON school.staff_users;
    CREATE POLICY arena_staff_self_select ON school.staff_users
      AS PERMISSIVE FOR SELECT TO authenticated
      USING (auth_user_id = auth.uid());
    CREATE POLICY arena_staff_self_restrictive ON school.staff_users
      AS RESTRICTIVE FOR ALL TO anon, authenticated
      USING (auth_user_id = auth.uid())
      WITH CHECK (auth_user_id = auth.uid());
  END IF;

  -- student_parents has historically been represented as a link table without
  -- school_id. Scope it through both linked tenant-owned records when needed.
  IF to_regclass('school.student_parents') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'school' AND table_name = 'student_parents' AND column_name = 'school_id'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'school' AND table_name = 'student_parents' AND column_name = 'student_id'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'school' AND table_name = 'student_parents' AND column_name = 'parent_id'
     ) THEN
    ALTER TABLE school.student_parents ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS arena_school_scope_permissive ON school.student_parents;
    DROP POLICY IF EXISTS arena_school_scope_restrictive ON school.student_parents;
    CREATE POLICY arena_school_scope_permissive ON school.student_parents
      AS PERMISSIVE FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM school.people student
          WHERE student.id = student_parents.student_id
            AND student.school_id = school.auth_school_id()
        )
        AND EXISTS (
          SELECT 1 FROM school.parents parent
          WHERE parent.id = student_parents.parent_id
            AND parent.school_id = school.auth_school_id()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM school.people student
          WHERE student.id = student_parents.student_id
            AND student.school_id = school.auth_school_id()
        )
        AND EXISTS (
          SELECT 1 FROM school.parents parent
          WHERE parent.id = student_parents.parent_id
            AND parent.school_id = school.auth_school_id()
        )
      );
    CREATE POLICY arena_school_scope_restrictive ON school.student_parents
      AS RESTRICTIVE FOR ALL TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM school.people student
          WHERE student.id = student_parents.student_id
            AND student.school_id = school.auth_school_id()
        )
        AND EXISTS (
          SELECT 1 FROM school.parents parent
          WHERE parent.id = student_parents.parent_id
            AND parent.school_id = school.auth_school_id()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM school.people student
          WHERE student.id = student_parents.student_id
            AND student.school_id = school.auth_school_id()
        )
        AND EXISTS (
          SELECT 1 FROM school.parents parent
          WHERE parent.id = student_parents.parent_id
            AND parent.school_id = school.auth_school_id()
        )
      );
  END IF;
END $$;

-- Composite foreign keys stop privileged server writes from pairing a school A
-- record with a school B person, class, or device. NOT VALID leaves existing
-- data untouched while enforcing the constraints on all new/updated rows.
DO $$
BEGIN
  IF to_regclass('school.people') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='people' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='people' AND column_name='id') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS people_school_id_id_tenant_uq ON school.people (school_id, id);
  END IF;

  IF to_regclass('school.classes') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='classes' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='classes' AND column_name='id') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS classes_school_id_id_tenant_uq ON school.classes (school_id, id);
  END IF;

  IF to_regclass('school.devices') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='devices' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='devices' AND column_name='id') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS devices_school_id_id_tenant_uq ON school.devices (school_id, id);
  END IF;

  IF to_regclass('school.people') IS NOT NULL
     AND to_regclass('school.classes') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='people' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='people' AND column_name='class_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='classes' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='classes' AND column_name='id')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_class_school_fk' AND conrelid = to_regclass('school.people')) THEN
    ALTER TABLE school.people
      ADD CONSTRAINT people_class_school_fk
      FOREIGN KEY (school_id, class_id)
      REFERENCES school.classes (school_id, id)
      NOT VALID;
  END IF;

  IF to_regclass('school.person_credentials') IS NOT NULL
     AND to_regclass('school.people') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='person_credentials' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='person_credentials' AND column_name='person_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='people' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='people' AND column_name='id')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_credentials_person_school_fk' AND conrelid = to_regclass('school.person_credentials')) THEN
    ALTER TABLE school.person_credentials
      ADD CONSTRAINT person_credentials_person_school_fk
      FOREIGN KEY (school_id, person_id)
      REFERENCES school.people (school_id, id)
      NOT VALID;
  END IF;

  IF to_regclass('school.attendance_logs') IS NOT NULL
     AND to_regclass('school.people') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='attendance_logs' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='attendance_logs' AND column_name='person_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='people' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='people' AND column_name='id')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_logs_person_school_fk' AND conrelid = to_regclass('school.attendance_logs')) THEN
    ALTER TABLE school.attendance_logs
      ADD CONSTRAINT attendance_logs_person_school_fk
      FOREIGN KEY (school_id, person_id)
      REFERENCES school.people (school_id, id)
      NOT VALID;
  END IF;

  IF to_regclass('school.devices') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='devices' AND column_name='school_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='devices' AND column_name='id') THEN
    IF to_regclass('school.device_logs') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='device_logs' AND column_name='school_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='device_logs' AND column_name='device_id')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_logs_device_school_fk' AND conrelid = to_regclass('school.device_logs')) THEN
      ALTER TABLE school.device_logs
        ADD CONSTRAINT device_logs_device_school_fk
        FOREIGN KEY (school_id, device_id)
        REFERENCES school.devices (school_id, id)
        NOT VALID;
    END IF;

    IF to_regclass('school.device_commands') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='device_commands' AND column_name='school_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='device_commands' AND column_name='device_id')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_commands_device_school_fk' AND conrelid = to_regclass('school.device_commands')) THEN
      ALTER TABLE school.device_commands
        ADD CONSTRAINT device_commands_device_school_fk
        FOREIGN KEY (school_id, device_id)
        REFERENCES school.devices (school_id, id)
        NOT VALID;
    END IF;

    IF to_regclass('school.attendance_logs') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='attendance_logs' AND column_name='school_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='school' AND table_name='attendance_logs' AND column_name='device_id')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_logs_device_school_fk' AND conrelid = to_regclass('school.attendance_logs')) THEN
      ALTER TABLE school.attendance_logs
        ADD CONSTRAINT attendance_logs_device_school_fk
        FOREIGN KEY (school_id, device_id)
        REFERENCES school.devices (school_id, id)
        NOT VALID;
    END IF;
  END IF;
END $$;

-- Device serials are the external identity used by hardware protocols before
-- their per-device token is checked. They must be globally unique after
-- normalization or two tenants could claim the same terminal.
DO $$
BEGIN
  IF to_regclass('school.devices') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'school' AND table_name = 'devices' AND column_name = 'serial_number'
     ) THEN
    IF EXISTS (
      SELECT 1
      FROM school.devices
      WHERE serial_number IS NOT NULL AND btrim(serial_number::TEXT) <> ''
      GROUP BY upper(btrim(serial_number::TEXT))
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'Duplicate normalized device serial numbers exist; reconcile them before applying migration 02.';
    END IF;

    UPDATE school.devices
    SET serial_number = upper(btrim(serial_number::TEXT))
    WHERE serial_number IS NOT NULL
      AND serial_number::TEXT IS DISTINCT FROM upper(btrim(serial_number::TEXT));

    CREATE UNIQUE INDEX IF NOT EXISTS devices_serial_number_normalized_uq
      ON school.devices (upper(btrim(serial_number::TEXT)))
      WHERE serial_number IS NOT NULL AND btrim(serial_number::TEXT) <> '';
  END IF;
END $$;

-- Authenticated school users may view device configuration, but device tokens
-- and legacy packed firmware metadata are server-only. Remove broad table grants
-- and grant only the non-sensitive columns actually used by browser queries.
DO $$
DECLARE
  safe_select_columns TEXT;
BEGIN
  IF to_regclass('school.devices') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE school.devices FROM PUBLIC, anon, authenticated;
    GRANT ALL PRIVILEGES ON TABLE school.devices TO service_role;

    SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
    INTO safe_select_columns
    FROM information_schema.columns
    WHERE table_schema = 'school'
      AND table_name = 'devices'
      AND column_name = ANY (ARRAY[
        'id', 'school_id', 'serial_number', 'label', 'location_label', 'ip_address',
        'device_type', 'status_code_map', 'config', 'is_active', 'last_seen_at',
        'created_at', 'updated_at'
      ]);

    IF safe_select_columns IS NULL THEN
      RAISE EXCEPTION 'No safe device columns were found for authenticated reads.';
    END IF;

    EXECUTE format('GRANT SELECT (%s) ON TABLE school.devices TO authenticated', safe_select_columns);
  END IF;
END $$;

-- Staff PIN hashes and lockout internals must not be readable by a browser
-- session, even for the authenticated user's own staff row. App code accesses
-- those sensitive columns through the service-role client only.
DO $$
DECLARE
  safe_select_columns TEXT;
BEGIN
  IF to_regclass('school.staff_users') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE school.staff_users FROM PUBLIC, anon, authenticated;
    GRANT ALL PRIVILEGES ON TABLE school.staff_users TO service_role;

    SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
    INTO safe_select_columns
    FROM information_schema.columns
    WHERE table_schema = 'school'
      AND table_name = 'staff_users'
      AND column_name = ANY (ARRAY['id', 'auth_user_id', 'person_id', 'staff_role']);

    IF safe_select_columns IS NULL THEN
      RAISE EXCEPTION 'No safe staff_users columns were found for authenticated reads.';
    END IF;

    EXECUTE format('GRANT SELECT (%s) ON TABLE school.staff_users TO authenticated', safe_select_columns);
  END IF;
END $$;
