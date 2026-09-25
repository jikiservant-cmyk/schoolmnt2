import { DeviceAdapter, DeviceRecord, AttendanceEvent, EnrollPersonInput, EnrollCommandResult, HandshakeResponse } from '../types';
import { isAuthorizedToken } from '../metadata';

export class SupremaBiostarAdapter implements DeviceAdapter {
  readonly deviceType = 'suprema_biostar';
  readonly displayName = 'Suprema BioStar (BioStation / FaceStation)';
  readonly protocolFamily = 'BioStar Webhook / JSON';
  readonly defaultEndpoint = '/api/devices/push';

  buildAuthCheck(req: Request, device: DeviceRecord): boolean {
    const url = new URL(req.url);
    const providedToken = 
      req.headers.get('bs-session-id') ||
      req.headers.get('x-device-token') ||
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token');

    return isAuthorizedToken(providedToken, device.device_secret_hash || device.device_secret);
  }

  buildHandshakeResponse(device: DeviceRecord): HandshakeResponse {
    return {
      body: JSON.stringify({
        Response: {
          code: '0',
          message: 'Success',
          terminal_id: device.serial_number,
          server_time: new Date().toISOString()
        }
      }),
      contentType: 'application/json',
      status: 200
    };
  }

  parseIncomingPush(
    rawBody: string,
    headers: Headers,
    url: URL,
    device: DeviceRecord
  ): AttendanceEvent[] {
    const events: AttendanceEvent[] = [];
    if (!rawBody || !rawBody.trim()) return events;

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch (err) {
      console.warn('[Suprema BioStar] Non-JSON payload received:', err);
      return events;
    }

    const logList = Array.isArray(parsed)
      ? parsed
      : (parsed.events || parsed.event_list || parsed.Event || [parsed]);

    for (const item of logList) {
      const pin = item.user_id || item.userId || item.pin || item.user_external_id;
      if (!pin) continue;

      let timestamp: Date;
      if (typeof item.timestamp === 'number') {
        timestamp = new Date(item.timestamp * 1000); // Unix epoch
      } else if (item.datetime || item.timestamp) {
        timestamp = new Date(item.datetime || item.timestamp);
      } else {
        timestamp = new Date();
      }

      // Suprema event_type_id mapping or tna_key
      // 0 or 1 usually check_in / check_out
      const tnaKey = String(item.tna_key || item.event_code || '0');
      let eventType: 'check_in' | 'check_out' = 'check_in';
      
      if (device.status_code_map?.[tnaKey]) {
        eventType = device.status_code_map[tnaKey];
      } else if (tnaKey === '1' || tnaKey === 'OUT' || item.direction === 'out') {
        eventType = 'check_out';
      }

      events.push({
        school_id: device.school_id,
        device_id: device.id,
        raw_serial_number: device.serial_number,
        person_external_id: String(pin).trim().toLowerCase(),
        timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp,
        event_type: eventType,
        verify_type: item.sub_type || 'fingerprint',
        raw_payload: item
      });
    }

    return events;
  }

  buildEnrollCommand(
    person: EnrollPersonInput,
    device?: DeviceRecord
  ): EnrollCommandResult {
    const cleanPin = person.pin.trim();
    const supremaPayload = {
      User: {
        user_id: cleanPin,
        name: person.fullName.trim(),
        user_group_id: { id: person.role === 'teacher' ? '2' : '1' },
        start_datetime: '2020-01-01T00:00:00Z',
        expiry_datetime: '2035-12-31T23:59:59Z'
      }
    };

    return {
      command: `BIOSTAR /api/users POST ${JSON.stringify(supremaPayload)}`,
      transportType: 'rest_api',
      payload: supremaPayload
    };
  }
}
