DROP SCHEMA IF EXISTS school CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA school;

CREATE TABLE school.schools(id uuid primary key default gen_random_uuid(), name text, settings jsonb default '{}'::jsonb, created_at timestamptz default now());
CREATE TABLE school.academic_years(id uuid primary key default gen_random_uuid(), school_id uuid references school.schools, name text, is_current boolean default true);
CREATE TABLE school.classes(id uuid primary key default gen_random_uuid(), school_id uuid references school.schools, name text, teacher_id uuid, academic_year_id uuid references school.academic_years, created_at timestamptz default now());
CREATE TABLE school.people(id uuid primary key default gen_random_uuid(), school_id uuid references school.schools, full_name text, role text, class_id uuid references school.classes,
  device_user_id text, phone text, email text, is_active boolean default true, pin_hash text, failed_attempts int default 0, locked_until timestamptz, created_at timestamptz default now(), updated_at timestamptz,
  UNIQUE (school_id, device_user_id));
ALTER TABLE school.classes ADD CONSTRAINT classes_teacher_fk FOREIGN KEY (teacher_id) REFERENCES school.people;
CREATE TABLE school.staff_users(id uuid primary key default gen_random_uuid(), school_id uuid references school.schools, auth_user_id uuid, person_id uuid references school.people, staff_role text, role text, pin_hash text, failed_attempts int default 0, locked_until timestamptz);
CREATE TABLE school.devices(id uuid primary key default gen_random_uuid(), school_id uuid references school.schools, serial_number text, label text, location_label text, ip_address text, firmware_version text,
  device_type text default 'zkteco', config jsonb default '{}'::jsonb, last_seen_at timestamptz, is_active boolean default true, created_at timestamptz default now(), device_secret text, device_secret_hash text, updated_at timestamptz);
CREATE TABLE school.device_commands(id uuid primary key default gen_random_uuid(), school_id uuid, device_id uuid references school.devices, target_serial text, raw_command text, payload jsonb, command_type text,
  status text default 'pending', created_at timestamptz default now(), sent_at timestamptz, completed_at timestamptz, result text, attempts int default 0);
CREATE TABLE school.device_logs(id uuid primary key default gen_random_uuid(), school_id uuid, device_id uuid references school.devices, serial_number text, payload jsonb, log_type text, raw_data text, created_at timestamptz default now());
CREATE TABLE school.attendance_logs(id uuid primary key default gen_random_uuid(), school_id uuid references school.schools, person_id uuid references school.people, device_id uuid references school.devices, class_id uuid references school.classes,
  status text, attendance_type text, occurred_at timestamptz default now(), source text, created_at timestamptz default now(), recorded_by uuid, notes text, verify_mode text, raw_payload jsonb);
CREATE TABLE school.parents(id uuid primary key default gen_random_uuid(), school_id uuid references school.schools, full_name text, phone text);
CREATE TABLE school.student_parents(id uuid primary key default gen_random_uuid(), student_id uuid references school.people, parent_id uuid references school.parents, is_primary_contact boolean default true, relationship text);
CREATE TABLE school.person_credentials(id uuid primary key default gen_random_uuid(), school_id uuid, person_id uuid references school.people, identifier_value text, identifier_type text, device_id uuid);
CREATE TABLE school.notifications(id uuid primary key default gen_random_uuid(), school_id uuid, recipient_type text, recipient_id uuid, recipient_phone_snapshot text, channel text, notification_type text,
  related_table text, related_id uuid, message text, status text, created_at timestamptz default now());

CREATE TABLE public.admin_profiles(id uuid primary key, role text, app_type text, school_id uuid, email text, full_name text, created_at timestamptz default now());
CREATE TABLE public.wallets(id uuid primary key default gen_random_uuid(), tenant_id uuid, school_id uuid, balance numeric default 0, currency text default 'UGX', updated_at timestamptz);
CREATE TABLE public.transactions(id uuid primary key default gen_random_uuid(), wallet_id uuid, amount numeric, type text, reference text, status text, description text, created_at timestamptz default now());
CREATE TABLE public.tenants(id uuid primary key, code text, name text);
CREATE TABLE public.profiles(id uuid primary key default gen_random_uuid(), user_id uuid, school_id uuid, code text);
