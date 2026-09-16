-- =====================================================================
-- MERIDIAN / NAJIKI ATTENDANCE: MULTI-VENDOR BIOMETRIC DEVICE ADAPTERS
-- Execute in Supabase SQL Editor if upgrading existing 'school.devices' table
-- =====================================================================

-- 1. Add device_type column with default 'zkteco_adms'
ALTER TABLE school.devices 
ADD COLUMN IF NOT EXISTS device_type TEXT DEFAULT 'zkteco_adms';

-- 2. Add per-device secret token column for individual hardware credentialing
ALTER TABLE school.devices 
ADD COLUMN IF NOT EXISTS device_secret TEXT;

-- 3. Add custom status code mapping (e.g. {"0": "check_in", "1": "check_out"})
ALTER TABLE school.devices 
ADD COLUMN IF NOT EXISTS status_code_map JSONB DEFAULT '{"0": "check_in", "1": "check_out", "4": "check_in", "5": "check_out"}'::jsonb;

-- 4. Add device-specific or school-specific overrides (lateCutoffHour, timeZone, etc.)
ALTER TABLE school.devices 
ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{"lateCutoffHour": 8, "lateCutoffMinute": 0, "timeZone": "Africa/Kampala"}'::jsonb;

-- 5. Comment on columns for clear documentation
COMMENT ON COLUMN school.devices.device_type IS 'Hardware protocol: zkteco_adms, hikvision_isapi, suprema_biostar, dahua_isapi, generic_webhook';
COMMENT ON COLUMN school.devices.device_secret IS 'Unique per-device authentication secret token';
COMMENT ON COLUMN school.devices.status_code_map IS 'JSON mapping from vendor status codes to check_in or check_out';
COMMENT ON COLUMN school.devices.config IS 'Per-device runtime configurations such as lateCutoffHour and timeZone';
