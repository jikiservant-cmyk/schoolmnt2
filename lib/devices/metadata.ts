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
 * Packs device metadata into a string if columns are not yet present in Supabase table.
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
    config: metadata.config
  });
  return `${base}|META:${payload}`;
}

/**
 * Resolves a raw database record into a fully-typed DeviceRecord,
 * gracefully supporting both first-class table columns AND packed metadata.
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

  // 2. Packed metadata fallback in firmware_version or label
  const fw = String(device.firmware_version || '');
  if (fw.includes('|META:')) {
    try {
      const jsonStr = fw.split('|META:')[1];
      const parsed = JSON.parse(jsonStr);
      if (parsed.type) deviceType = parsed.type;
      if (parsed.secret) deviceSecret = parsed.secret;
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
    }
  };
}

/**
 * Checks if a provided token matches the device's per-device secret hash,
 * the legacy cleartext secret, or the legacy global environment secret.
 */
export function isAuthorizedToken(
  providedToken: string | null,
  deviceSecretOrHash: string | null,
  globalSecret: string | undefined = process.env.ZKTECO_DEVICE_SECRET
): boolean {
  if (!providedToken || !providedToken.trim()) {
    return false; // Fail-closed: Never permit anonymous device pushes
  }

  const cleanProvided = providedToken.trim();
  const target = deviceSecretOrHash?.trim() || globalSecret?.trim();

  if (!target) {
    return false; // Fail-closed if no secret configured on server
  }

  // 1. Check if stored target is a SHA-256 hash (64 hex characters)
  if (/^[0-9a-fA-F]{64}$/.test(target)) {
    const computedHash = hashDeviceSecret(cleanProvided);
    try {
      return crypto.timingSafeEqual(
        Buffer.from(computedHash, 'utf8'),
        Buffer.from(target.toLowerCase(), 'utf8')
      );
    } catch {
      return computedHash.toLowerCase() === target.toLowerCase();
    }
  }

  // 2. Direct timing-safe comparison for unhashed legacy secret
  try {
    // Pad or truncate to ensure equal length for timingSafeEqual if needed, 
    // but easiest is to check length first to prevent Buffer throw.
    if (cleanProvided.length !== target.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(cleanProvided, 'utf8'),
      Buffer.from(target, 'utf8')
    );
  } catch {
    return cleanProvided === target;
  }
}
