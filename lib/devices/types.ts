export type DeviceType = 
  | 'zkteco_adms'
  | 'hikvision_isapi'
  | 'suprema_biostar'
  | 'dahua_isapi'
  | 'generic_webhook';

export interface DeviceConfig {
  lateCutoffHour?: number;
  lateCutoffMinute?: number;
  timeZone?: string;
  autoApproveCheckOut?: boolean;
  [key: string]: any;
}

export interface DeviceRecord {
  id: string;
  school_id: string;
  serial_number: string;
  label: string | null;
  ip_address: string | null;
  firmware_version: string | null;
  is_active: boolean;
  last_seen_at: string | null;
  created_at?: string | null;
  
  // Multi-vendor abstractions
  device_type: DeviceType;
  device_secret: string | null;
  device_secret_hash?: string | null;
  location_label?: string | null;
  status_code_map: Record<string, 'check_in' | 'check_out'>;
  config: DeviceConfig;
  schools?: { id?: string; name?: string } | null;
}

export interface AttendanceEvent {
  school_id: string;
  device_id: string;
  raw_serial_number: string;
  person_external_id: string; // PIN, card UID, or employee ID
  timestamp: Date;
  event_type: 'check_in' | 'check_out';
  verify_type?: string;
  raw_payload?: Record<string, any>;
}

export interface EnrollPersonInput {
  pin: string;
  fullName: string;
  role: 'student' | 'teacher' | 'support_staff' | 'admin' | string;
  className?: string | null;
}

export interface EnrollCommandResult {
  command: string;
  transportType: 'adms_command' | 'rest_api' | 'none';
  payload?: any;
}

export interface HandshakeResponse {
  body: string | object;
  contentType: string;
  status?: number;
  headers?: Record<string, string>;
}

export interface DeviceAdapter {
  readonly deviceType: DeviceType;
  readonly displayName: string;
  readonly protocolFamily: string;
  readonly defaultEndpoint: string;

  /**
   * Validates authentication from the incoming request for this device
   */
  buildAuthCheck(req: Request, device: DeviceRecord): boolean | Promise<boolean>;

  /**
   * Builds the vendor-specific initial handshake / configuration response
   */
  buildHandshakeResponse(device: DeviceRecord): HandshakeResponse;

  /**
   * Parses raw incoming push payload into normalized AttendanceEvent array
   */
  parseIncomingPush(
    rawBody: string,
    headers: Headers,
    url: URL,
    device: DeviceRecord
  ): AttendanceEvent[] | Promise<AttendanceEvent[]>;

  /**
   * Builds vendor-specific user enrollment command (name, PIN, privileges)
   */
  buildEnrollCommand(
    person: EnrollPersonInput,
    device?: DeviceRecord
  ): EnrollCommandResult;
}
