-- =============================================================================
-- 03_tenant_integrity.sql
--
-- Database-level multi-tenant integrity (defence in depth).
--
-- The application now validates tenant ownership for every foreign reference
-- (see lib/tenant.ts). These triggers make the database itself refuse any row
-- that links data across schools, so that a future code bug, a service-role
-- script, or a misconfigured RLS policy can't create cross-tenant links such as:
--   * a student placed in another school's class
--   * a class whose teacher belongs to another school
--   * an attendance log pointing at another school's person or device
--   * a device command queued against another school's device
--   * a guardian from school B linked to a student in school A
--
-- The migration is idempotent and SCHEMA-TOLERANT: each trigger is created only
-- if the table and columns it needs exist. Run it in the Supabase SQL editor.
-- It is safe to re-run.
--
-- BEFORE RUNNING IN PRODUCTION: run the audit query at the bottom first. Rows
-- that already violate the rule are NOT changed by this migration. They are
-- only rejected the next time they are UPDATEd.
-- =============================================================================

-- Generic checker. Trigger arguments:
--   TG_ARGV[0] = FK column on NEW (e.g. 'class_id')
--   TG_ARGV[1] = referenced table, schema-qualified (e.g. 'school.classes')
--   TG_ARGV[2] = tenant column on NEW (default 'school_id')
--   TG_ARGV[3] = tenant column on referenced table (default 'school_id')
CREATE OR REPLACE FUNCTION school.enforce_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, school, public
AS $$
DECLARE
  fk_col      text := TG_ARGV[0];
  ref_table   text := TG_ARGV[1];
  own_col     text := COALESCE(NULLIF(TG_ARGV[2], ''), 'school_id');
  ref_col     text := COALESCE(NULLIF(TG_ARGV[3], ''), 'school_id');
  row_json    jsonb := to_jsonb(NEW);
  fk_val      text := row_json ->> fk_col;
  own_tenant  text := row_json ->> own_col;
  ref_tenant  text;
  found_row   boolean;
BEGIN
  IF fk_val IS NULL THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, skip the lookup when neither the FK nor the tenant changed.
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) ->> fk_col) IS NOT DISTINCT FROM fk_val
       AND (to_jsonb(OLD) ->> own_col) IS NOT DISTINCT FROM own_tenant THEN
      RETURN NEW;
    END IF;
  END IF;

  EXECUTE format('SELECT true, (%I)::text FROM %s WHERE id::text = $1', ref_col, ref_table)
    INTO found_row, ref_tenant
    USING fk_val;

  -- A missing referenced row is the FK constraint's job (if one exists).
  IF found_row IS NULL THEN
    RETURN NEW;
  END IF;

  IF own_tenant IS DISTINCT FROM ref_tenant THEN
    RAISE EXCEPTION 'cross-tenant reference rejected: %.% -> % belongs to a different school',
      TG_TABLE_NAME, fk_col, ref_table
      USING ERRCODE = '23514';  -- check_violation
  END IF;

  RETURN NEW;
END;
$$;

-- student_parents usually has no school_id column of its own, so compare the
-- student's school with the guardian's school directly.
CREATE OR REPLACE FUNCTION school.enforce_student_parent_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, school, public
AS $$
DECLARE
  student_school text;
  parent_school  text;
BEGIN
  SELECT school_id::text INTO student_school FROM school.people  WHERE id = NEW.student_id;
  SELECT school_id::text INTO parent_school  FROM school.parents WHERE id = NEW.parent_id;
  IF student_school IS NOT NULL AND parent_school IS NOT NULL
     AND student_school IS DISTINCT FROM parent_school THEN
    RAISE EXCEPTION 'cross-tenant reference rejected: student and guardian belong to different schools'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Moving a tenant-owned row to another school would silently orphan every
-- child row that points at it (and bypass the checks above), so block it.
CREATE OR REPLACE FUNCTION school.forbid_school_id_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, school, public
AS $$
BEGIN
  IF NEW.school_id IS DISTINCT FROM OLD.school_id THEN
    RAISE EXCEPTION 'changing school_id on %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Install triggers only where the schema supports them.
DO $$
DECLARE
  spec record;
  has_cols boolean;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- table              fk column      referenced table          trigger name
      ('people',            'class_id',    'school.classes',         'trg_people_class_same_tenant'),
      ('classes',           'teacher_id',  'school.people',          'trg_classes_teacher_same_tenant'),
      ('attendance_logs',   'person_id',   'school.people',          'trg_attlogs_person_same_tenant'),
      ('attendance_logs',   'device_id',   'school.devices',         'trg_attlogs_device_same_tenant'),
      ('device_commands',   'device_id',   'school.devices',         'trg_devcmds_device_same_tenant'),
      ('device_logs',       'device_id',   'school.devices',         'trg_devlogs_device_same_tenant'),
      ('person_credentials','person_id',   'school.people',          'trg_personcreds_person_same_tenant'),
      ('notifications',     'related_id',  'school.attendance_logs', 'trg_notifications_related_same_tenant'),
      ('class_teachers',    'class_id',    'school.classes',         'trg_class_teachers_class_same_tenant'),
      ('class_teachers',    'teacher_id',  'school.people',          'trg_class_teachers_teacher_same_tenant'),
      ('teacher_classes',   'class_id',    'school.classes',         'trg_teacher_classes_class_same_tenant'),
      ('teacher_classes',   'teacher_id',  'school.people',          'trg_teacher_classes_teacher_same_tenant')
    ) AS t(tbl, fk, ref, trg)
  LOOP
    SELECT
      to_regclass('school.' || spec.tbl) IS NOT NULL
      AND to_regclass(spec.ref) IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'school' AND table_name = spec.tbl AND column_name = spec.fk)
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'school' AND table_name = spec.tbl AND column_name = 'school_id')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = split_part(spec.ref, '.', 1)
                    AND table_name = split_part(spec.ref, '.', 2) AND column_name = 'school_id')
    INTO has_cols;

    -- notifications.related_id is polymorphic: only check attendance rows.
    IF has_cols THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON school.%I', spec.trg, spec.tbl);
      IF spec.tbl = 'notifications' THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'school' AND table_name = 'notifications' AND column_name = 'related_table') THEN
          EXECUTE format(
            'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON school.%I FOR EACH ROW '
            'WHEN (NEW.related_table = ''attendance_logs'') '
            'EXECUTE FUNCTION school.enforce_same_tenant(%L, %L)',
            spec.trg, spec.tbl, spec.fk, spec.ref);
          RAISE NOTICE 'installed %', spec.trg;
        END IF;
      ELSE
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON school.%I FOR EACH ROW '
          'EXECUTE FUNCTION school.enforce_same_tenant(%L, %L)',
          spec.trg, spec.tbl, spec.fk, spec.ref);
        RAISE NOTICE 'installed %', spec.trg;
      END IF;
    ELSE
      RAISE NOTICE 'skipped % (table/columns not present)', spec.trg;
    END IF;
  END LOOP;

  -- student_parents (student <-> guardian)
  IF to_regclass('school.student_parents') IS NOT NULL
     AND to_regclass('school.parents') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'school' AND table_name = 'parents' AND column_name = 'school_id') THEN
    DROP TRIGGER IF EXISTS trg_student_parents_same_tenant ON school.student_parents;
    CREATE TRIGGER trg_student_parents_same_tenant
      BEFORE INSERT OR UPDATE ON school.student_parents
      FOR EACH ROW EXECUTE FUNCTION school.enforce_student_parent_same_tenant();
    RAISE NOTICE 'installed trg_student_parents_same_tenant';
  END IF;

  -- Immutable school_id on core tenant-owned tables.
  FOR spec IN SELECT unnest(ARRAY['people','classes','devices','parents','attendance_logs','person_credentials']) AS tbl
  LOOP
    IF to_regclass('school.' || spec.tbl) IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'school' AND table_name = spec.tbl AND column_name = 'school_id') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON school.%I', 'trg_' || spec.tbl || '_school_immutable', spec.tbl);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OF school_id ON school.%I FOR EACH ROW '
        'EXECUTE FUNCTION school.forbid_school_id_change()',
        'trg_' || spec.tbl || '_school_immutable', spec.tbl);
    END IF;
  END LOOP;
END;
$$;

-- Unique device serials (case-insensitive) so one serial can never resolve
-- to two schools. Skipped with a NOTICE if duplicates already exist. Resolve
-- those manually, then re-run.
DO $$
BEGIN
  IF to_regclass('school.devices') IS NOT NULL THEN
    IF EXISTS (SELECT upper(serial_number) FROM school.devices
               GROUP BY upper(serial_number) HAVING count(*) > 1) THEN
      RAISE NOTICE 'NOT creating unique serial index: duplicate device serials exist. Run: SELECT upper(serial_number), array_agg(school_id) FROM school.devices GROUP BY 1 HAVING count(*) > 1;';
    ELSE
      CREATE UNIQUE INDEX IF NOT EXISTS devices_serial_upper_uniq ON school.devices (upper(serial_number));
    END IF;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- AUDIT: find existing cross-tenant rows (run manually and review):
--
-- SELECT 'people.class_id' AS link, p.id FROM school.people p
--   JOIN school.classes c ON c.id = p.class_id WHERE c.school_id <> p.school_id
-- UNION ALL
-- SELECT 'classes.teacher_id', c.id FROM school.classes c
--   JOIN school.people t ON t.id = c.teacher_id WHERE t.school_id <> c.school_id
-- UNION ALL
-- SELECT 'attendance_logs.person_id', a.id FROM school.attendance_logs a
--   JOIN school.people p ON p.id = a.person_id WHERE p.school_id <> a.school_id
-- UNION ALL
-- SELECT 'student_parents', sp.student_id FROM school.student_parents sp
--   JOIN school.people s ON s.id = sp.student_id
--   JOIN school.parents g ON g.id = sp.parent_id WHERE s.school_id <> g.school_id;
-- -----------------------------------------------------------------------------
