import { DeviceRecord, DeviceType, DeviceConfig } from './types';
import crypto from 'crypto';

/**
 * Computes a SHA-256 hash for a device secret token to ensure credentials
 * are never stored in plaintext in the database.
 */
export function hashDeviceSecret(secret: string): string {
  if (!secret || !secret.trim()) return '';
  return crypto.createHash('sha256').update(secret.trim()).digest('hex');
}

/**
 * Generates a secure, cryptographically random per-device authentication token.
 * Example: dev_sec_9f4e2b810d7a31c5
 */
export function generateDeviceSecret(): string {
  return `dev_sec_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Packs non-secret device metadata into a string for databases that predate
 * first-class device metadata columns. Authentication material must never be
 * packed here: firmware_version is routinely selected for dashboard rendering.
 */
export function packDeviceMetadata(
  baseFirmware: string | null,
  metadata: {
    type?: DeviceType;
    statusCodeMap?: Record<string, 'check_in' | 'check_out'>;
    config?: DeviceConfig;
  }
): string {
  const base = (baseFirmware || 'Ver 2.0.1-20170210').split('|META:')[0].trim();
  const payload = JSON.stringify({
    type: metadata.type || 'zkteco_adms',
    statusCodeMap: metadata.statusCodeMap,
    config: metadata.config,
  });
  return `${base}|META:${payload}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Only these terminal settings are meaningful to dashboard rendering. Device
 * config is otherwise an arbitrary JSON column, so copying it wholesale would
 * recreate the same browser leak if a legacy integrator stored an API key,
 * password, or vendor token in it.
 */
export function toPublicDeviceConfig(value: unknown): DeviceConfig {
  const config = isPlainObject(value) ? value : {};
  const safe: DeviceConfig = {};
  const hour = config.lateCutoffHour;
  const minute = config.lateCutoffMinute;
  const timeZone = config.timeZone;

  if (typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23) {
    safe.lateCutoffHour = hour;
  }
  if (typeof minute === 'number' && Number.isInteger(minute) && minute >= 0 && minute <= 59) {
    safe.lateCutoffMinute = minute;
  }
  if (typeof timeZone === 'string' && timeZone.length <= 64) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone });
      safe.timeZone = timeZone;
    } catch {
      // Ignore invalid IANA zone names.
    }
  }
  if (typeof config.autoApproveCheckOut === 'boolean') {
    safe.autoApproveCheckOut = config.autoApproveCheckOut;
  }
  return safe;
}

/**
 * Legacy installs sometimes packed a plaintext `secret` in firmware_version.
 * Keep reading it on the server until the device is rotated, but make it
 * impossible for that historic secret (or arbitrary legacy metadata) to reach
 * a React Server Component prop or browser response.
 */
export function sanitizeFirmwareMetadataForClient(value: unknown): string | null {
  if (typeof value !== 'string') return value == null ? null : String(value);
  if (!value.includes('|META:')) return value;

  const base = value.split('|META:')[0].trim();
  try {
    const raw = value.slice(value.indexOf('|META:') + '|META:'.length);
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return base || null;

    const type = typeof parsed.type === 'string' ? parsed.type as DeviceType : undefined;
    const statusCodeMap = isPlainObject(parsed.statusCodeMap)
      ? toPublicStatusCodeMap(parsed.statusCodeMap)
      : undefined;
    const config = isPlainObject(parsed.config) ? toPublicDeviceConfig(parsed.config) : undefined;

    // Preserve only the known, non-sensitive compatibility fields.
    if (!type && !statusCodeMap && !config) return base || null;
    return packDeviceMetadata(base || null, { type, statusCodeMap, config });
  } catch {
    // A malformed packed payload can contain a secret too; show the firmware
    // prefix only rather than reflecting untrusted opaque data to the browser.
    return base || null;
  }
}

/**
 * Resolves a raw database record into a fully-typed DeviceRecord,
 * gracefully supporting both first-class table columns AND packed metadata.
 * This function is server-only whenever legacy plaintext authentication data
 * may exist. Use toPublicDeviceMetadata() for values passed to clients.
 */
export function parseDeviceMetadata(device: any): DeviceRecord {
  if (!device) {
    throw new Error('Device record is null or undefined');
  }

  let deviceType: DeviceType = 'zkteco_adms';
  let deviceSecret: string | null = null;
  let deviceSecretHash: string | null = null;
  let locationLabel: string | null = null;
  let statusCodeMap: Record<string, 'check_in' | 'check_out'> = {
    '0': 'check_in',
    '1': 'check_out',
    '4': 'check_in',
    '5': 'check_out',
  };
  let config: DeviceConfig = {
    lateCutoffHour: 8,
    lateCutoffMinute: 0,
    timeZone: 'Africa/Kampala',
  };

  // 1. Direct columns if present
  if (device.device_type) {
    deviceType = device.device_type as DeviceType;
  }
  if (device.device_secret) {
    deviceSecret = device.device_secret;
  }
  if (device.device_secret_hash) {
    deviceSecretHash = device.device_secret_hash;
  }
  if (device.location_label) {
    locationLabel = device.location_label;
  }
  if (device.status_code_map) {
    try {
      statusCodeMap = typeof device.status_code_map === 'string'
        ? JSON.parse(device.status_code_map)
        : device.status_code_map;
    } catch {
      // Keep default
    }
  }
  if (device.config) {
    try {
      const parsedCfg = typeof device.config === 'string'
        ? JSON.parse(device.config)
        : device.config;
      config = { ...config, ...parsedCfg };
    } catch {
      // Keep default
    }
  }

  // 2. Packed metadata fallback in firmware_version. `secret` is supported
  // only to authenticate and rotate old devices; it is stripped before any
  // client serialization by toPublicDeviceMetadata().
  const fw = String(device.firmware_version || '');
  if (fw.includes('|META:')) {
    try {
      const jsonStr = fw.slice(fw.indexOf('|META:') + '|META:'.length);
      const parsed = JSON.parse(jsonStr);
      if (parsed.type) deviceType = parsed.type;
      if (typeof parsed.secret === 'string' && parsed.secret.trim()) deviceSecret = parsed.secret;
      if (parsed.statusCodeMap) statusCodeMap = { ...statusCodeMap, ...parsed.statusCodeMap };
      if (parsed.config) config = { ...config, ...parsed.config };
    } catch {
      // Ignore parse failure
    }
  }

  // 3. Fallback check on label tags, e.g. "Main Gate [hikvision_isapi]"
  const labelStr = String(device.label || '').toLowerCase();
  if (labelStr.includes('hikvision') || labelStr.includes('isapi')) {
    if (!device.device_type && !fw.includes('|META:')) deviceType = 'hikvision_isapi';
  } else if (labelStr.includes('suprema') || labelStr.includes('biostar')) {
    if (!device.device_type && !fw.includes('|META:')) deviceType = 'suprema_biostar';
  } else if (labelStr.includes('dahua')) {
    if (!device.device_type && !fw.includes('|META:')) deviceType = 'dahua_isapi';
  } else if (labelStr.includes('webhook') || labelStr.includes('generic')) {
    if (!device.device_type && !fw.includes('|META:')) deviceType = 'generic_webhook';
  }

  return {
    ...device,
    device_type: deviceType,
    device_secret: deviceSecret,
    device_secret_hash: deviceSecretHash,
    location_label: locationLabel || device.label || null,
    status_code_map: statusCodeMap,
    config: {
      lateCutoffHour: config.lateCutoffHour ?? 8,
      lateCutoffMinute: config.lateCutoffMinute ?? 0,
      timeZone: config.timeZone || 'Africa/Kampala',
      ...config,
    },
  };
}

export type PublicDeviceRecord = Omit<DeviceRecord, 'device_secret' | 'device_secret_hash'>;

function toPublicStatusCodeMap(value: unknown): Record<string, 'check_in' | 'check_out'> {
  if (!isPlainObject(value)) return {};
  const safe: Record<string, 'check_in' | 'check_out'> = {};
  for (const [key, mapped] of Object.entries(value)) {
    // This is displayed/configured as an attendance map, not a metadata bag.
    if (Object.keys(safe).length >= 32) break;
    if (/^[A-Za-z0-9_-]{1,24}$/.test(key) && (mapped === 'check_in' || mapped === 'check_out')) {
      safe[key] = mapped;
    }
  }
  return safe;
}

/**
 * Return a deliberately constructed device DTO safe for a Client Component.
 * Do not spread the database row here: columns added by vendor integrations
 * commonly contain API passwords/tokens and should default to server-only.
 */
export function toPublicDeviceMetadata(device: unknown): PublicDeviceRecord {
  const parsed = parseDeviceMetadata(device);
  return {
    id: parsed.id,
    school_id: parsed.school_id,
    serial_number: parsed.serial_number,
    label: parsed.label,
    ip_address: parsed.ip_address,
    firmware_version: sanitizeFirmwareMetadataForClient(parsed.firmware_version),
    is_active: parsed.is_active,
    last_seen_at: parsed.last_seen_at,
    created_at: parsed.created_at ?? null,
    device_type: parsed.device_type,
    location_label: parsed.location_label ?? null,
    status_code_map: toPublicStatusCodeMap(parsed.status_code_map),
    config: toPublicDeviceConfig(parsed.config),
    schools: parsed.schools && typeof parsed.schools === 'object'
      ? { id: parsed.schools.id, name: parsed.schools.name }
      : null,
  };
}

function matchesSecret(provided: string, stored: string): boolean {
  const target = stored.trim();
  if (!target) return false;
  if (/^[0-9a-fA-F]{64}$/.test(target)) {
    const computed = Buffer.from(hashDeviceSecret(provided), 'utf8');
    const expected = Buffer.from(target.toLowerCase(), 'utf8');
    return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
  }

  // Hash both legacy plaintext values to fixed 32-byte buffers before comparing.
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(target).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Compatibility helper for callers that only have one per-device value. A
 * shared global secret is deliberately disabled by default; it is a migration
 * aid, not an authentication mode for normal operation.
 */
export function isAuthorizedToken(
  providedToken: string | null,
  deviceSecretOrHash: string | null,
  globalSecret: string | undefined = process.env.ZKTECO_DEVICE_SECRET,
): boolean {
  if (!providedToken || !providedToken.trim()) return false;
  const provided = providedToken.trim();
  if (deviceSecretOrHash?.trim()) return matchesSecret(provided, deviceSecretOrHash);

  const globalFallbackEnabled = process.env.ZKTECO_ALLOW_LEGACY_GLOBAL_SECRET === 'true' ||
    process.env.ZKTECO_GLOBAL_SECRET_FALLBACK === 'true';
  return globalFallbackEnabled && !!globalSecret?.trim() && matchesSecret(provided, globalSecret);
}

/**
 * Multi-tenant safe device authentication.
 *
 * Every normal device must use its own secret (hash preferred, legacy plaintext
 * tolerated only until rotation). A shared global secret can authenticate only
 * a device that has no per-device credential, and only with an explicit,
 * temporary opt-in. The old default accepted the shared secret for every
 * device, making disclosure of one global value a cross-school impersonation.
 */
export function isAuthorizedDevice(
  providedToken: string | null | undefined,
  device: Pick<DeviceRecord, 'serial_number' | 'school_id'> & { device_secret?: string | null; device_secret_hash?: string | null },
  globalSecret?: string,
): boolean {
  if (!providedToken || !providedToken.trim()) return false;
  const provided = providedToken.trim();

  const perDevice = [device.device_secret_hash, device.device_secret].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  for (const stored of perDevice) {
    if (matchesSecret(provided, stored)) return true;
  }

  // Never let a global credential bypass a properly provisioned device.
  if (perDevice.length > 0) return false;

  const globalFallbackEnabled = process.env.ZKTECO_ALLOW_LEGACY_GLOBAL_SECRET === 'true' ||
    process.env.ZKTECO_GLOBAL_SECRET_FALLBACK === 'true';
  const global = globalSecret?.trim();
  if (!globalFallbackEnabled || !global || !matchesSecret(provided, global)) return false;

  console.warn(
    `[Device Auth] Device ${device.serial_number} (school ${device.school_id}) authenticated with the legacy SHARED global secret. ` +
    'Rotate this device to a per-device secret and remove ZKTECO_ALLOW_LEGACY_GLOBAL_SECRET.',
  );
  return true;
}
