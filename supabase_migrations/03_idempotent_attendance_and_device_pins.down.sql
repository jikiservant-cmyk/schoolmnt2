-- Safe rollback for migration 03 after deploying application code that no longer
-- relies on its uniqueness guarantees. Keep idempotency_key values for audit and
-- reconciliation; dropping the column would discard useful operational data.
DROP INDEX IF EXISTS school.person_credentials_school_type_normalized_uq;
DROP INDEX IF EXISTS school.person_credentials_school_type_identifier_uq;
DROP INDEX IF EXISTS school.notifications_school_related_channel_uq;
DROP INDEX IF EXISTS school.attendance_logs_school_idempotency_key_uq;
DROP INDEX IF EXISTS school.people_school_device_user_id_uq;
