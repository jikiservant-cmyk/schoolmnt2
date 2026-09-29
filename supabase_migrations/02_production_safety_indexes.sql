-- Production safety constraints for payment idempotency and attendance reads.
-- Before applying the unique index, resolve any existing duplicate references
-- with an approved data-reconciliation procedure. This migration intentionally
-- does not delete or rewrite application data.

CREATE UNIQUE INDEX IF NOT EXISTS transactions_reference_unique
  ON public.transactions (reference)
  WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS attendance_logs_school_person_time_idx
  ON school.attendance_logs (school_id, person_id, occurred_at);

CREATE INDEX IF NOT EXISTS device_logs_school_serial_time_idx
  ON school.device_logs (school_id, raw_serial_number, event_timestamp);
