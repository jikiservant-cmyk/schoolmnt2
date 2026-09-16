import { DeviceAdapter, DeviceRecord, AttendanceEvent, EnrollPersonInput, EnrollCommandResult, HandshakeResponse } from '../types';
import { isAuthorizedToken } from '../metadata';

export class DahuaIsapiAdapter implements DeviceAdapter {
  readonly deviceType = 'dahua_isapi';
  readonly displayName = 'Dahua ISAPI / Access Terminal';
  readonly protocolFamily = 'Dahua HTTP Event';
  readonly defaultEndpoint = '/api/devices/push';

  buildAuthCheck(req: Request, device: DeviceRecord): boolean {
    const url = new URL(req.url);
    const providedToken = 
      req.headers.get('x-device-token') ||
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token');

    return isAuthorizedToken(providedToken, device.device_secret);
  }

  buildHandshakeResponse(device: DeviceRecord): HandshakeResponse {
    return {
      body: JSON.stringify({
        result: true,
        message: 'Dahua terminal linked',
        serialNumber: device.serial_number,
        timestamp: Math.floor(Date.now() / 1000)
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
      console.warn('[Dahua ISAPI] Non-JSON payload received:', err);
      return events;
    }

    const items = Array.isArray(parsed) 
      ? parsed 
      : (parsed.events || parsed.AccessControlList || [parsed]);

    for (const item of items) {
      const data = item.AccessControl || item.record || item;
      const pin = data.UserID || data.CardNo || data.UserIDString || data.user_id;
      if (!pin) continue;

      let timestamp = new Date();
      if (data.UTC) {
        timestamp = new Date(Number(data.UTC) * 1000);
      } else if (data.Time) {
        timestamp = new Date(data.Time);
      }

      // Dahua Status: 1 = Normal In, 2 = Normal Out, or Action field
      const statusVal = String(data.Status || data.Action || '1');
      let eventType: 'check_in' | 'check_out' = 'check_in';

      if (device.status_code_map?.[statusVal]) {
        eventType = device.status_code_map[statusVal];
      } else if (statusVal === '2' || statusVal === 'PulseOut' || statusVal === 'Exit') {
        eventType = 'check_out';
      }

      events.push({
        school_id: device.school_id,
        device_id: device.id,
        raw_serial_number: device.serial_number,
        person_external_id: String(pin).trim().toLowerCase(),
        timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp,
        event_type: eventType,
        verify_type: data.Method || 'face',
        raw_payload: data
      });
    }

    return events;
  }

  buildEnrollCommand(
    person: EnrollPersonInput,
    device?: DeviceRecord
  ): EnrollCommandResult {
    const cleanPin = person.pin.trim();
    const dahuaPayload = {
      method: 'AccessUser.add',
      params: {
        UserID: cleanPin,
        UserName: person.fullName.trim(),
        UserType: person.role === 'teacher' ? 1 : 0
      }
    };

    return {
      command: `DAHUA ${JSON.stringify(dahuaPayload)}`,
      transportType: 'rest_api',
      payload: dahuaPayload
    };
  }
}
