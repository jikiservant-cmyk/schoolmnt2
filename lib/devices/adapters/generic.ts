import { DeviceAdapter, DeviceRecord, AttendanceEvent, EnrollPersonInput, EnrollCommandResult, HandshakeResponse } from '../types';
import { isAuthorizedToken } from '../metadata';

export class GenericWebhookAdapter implements DeviceAdapter {
  readonly deviceType = 'generic_webhook';
  readonly displayName = 'Generic Webhook (Custom IoT / REST Gateway)';
  readonly protocolFamily = 'Universal JSON Webhook';
  readonly defaultEndpoint = '/api/devices/push';

  buildAuthCheck(req: Request, device: DeviceRecord): boolean {
    const url = new URL(req.url);
    const providedToken = 
      req.headers.get('x-device-token') ||
      req.headers.get('x-api-key') ||
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token') ||
      url.searchParams.get('api_key');

    return isAuthorizedToken(providedToken, device.device_secret);
  }

  buildHandshakeResponse(device: DeviceRecord): HandshakeResponse {
    return {
      body: JSON.stringify({
        success: true,
        protocol: 'generic_webhook',
        serialNumber: device.serial_number,
        message: 'Endpoint active and ready for JSON attendance events',
        timestamp: new Date().toISOString()
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
      console.warn('[Generic Webhook] Non-JSON payload received:', err);
      return events;
    }

    const items = Array.isArray(parsed) 
      ? parsed 
      : (parsed.events || parsed.punches || parsed.records || [parsed]);

    for (const item of items) {
      const pin = item.pin || item.user_id || item.employee_id || item.card_id || item.person_external_id;
      if (!pin) continue;

      const rawTime = item.timestamp || item.time || item.occurred_at || item.datetime;
      const timestamp = rawTime ? new Date(rawTime) : new Date();

      const rawType = String(item.event_type || item.type || item.status || 'check_in').toLowerCase();
      let eventType: 'check_in' | 'check_out' = 'check_in';

      if (device.status_code_map?.[rawType]) {
        eventType = device.status_code_map[rawType];
      } else if (rawType.includes('out') || rawType === '1' || rawType === 'exit') {
        eventType = 'check_out';
      }

      events.push({
        school_id: device.school_id,
        device_id: device.id,
        raw_serial_number: device.serial_number,
        person_external_id: String(pin).trim().toLowerCase(),
        timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp,
        event_type: eventType,
        verify_type: item.verify_type || 'generic_scan',
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
    const payload = {
      action: 'sync_member',
      pin: cleanPin,
      full_name: person.fullName.trim(),
      role: person.role,
      class_name: person.className || null,
      synced_at: new Date().toISOString()
    };

    return {
      command: `SYNC_MEMBER ${JSON.stringify(payload)}`,
      transportType: 'none',
      payload
    };
  }
}
