import { DeviceAdapter, DeviceRecord, AttendanceEvent, EnrollPersonInput, EnrollCommandResult, HandshakeResponse } from '../types';
import { isAuthorizedToken } from '../metadata';

export class HikvisionIsapiAdapter implements DeviceAdapter {
  readonly deviceType = 'hikvision_isapi';
  readonly displayName = 'Hikvision ISAPI (MinMoe / Face Terminals)';
  readonly protocolFamily = 'ISAPI REST / JSON';
  readonly defaultEndpoint = '/api/devices/push';

  buildAuthCheck(req: Request, device: DeviceRecord): boolean {
    const url = new URL(req.url);
    const authHeader = req.headers.get('authorization') || '';
    const tokenHeader = req.headers.get('x-device-token') || '';
    
    let providedToken = tokenHeader || url.searchParams.get('token') || url.searchParams.get('key');
    
    if (!providedToken && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.replace(/^Bearer\s+/i, '');
    } else if (!providedToken && authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.replace(/^Basic\s+/i, ''), 'base64').toString('utf-8');
        // Basic auth format usually user:password
        const parts = decoded.split(':');
        providedToken = parts[1] || parts[0];
      } catch {
        // ignore
      }
    }

    return isAuthorizedToken(providedToken, device.device_secret);
  }

  buildHandshakeResponse(device: DeviceRecord): HandshakeResponse {
    return {
      body: JSON.stringify({
        statusCode: 1,
        statusString: 'OK',
        subStatusCode: 'ok',
        description: `Hikvision ISAPI endpoint active for serial ${device.serial_number}`,
        time: new Date().toISOString()
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

    let jsonPayload: any = null;

    // Handle standard JSON or multipart containing JSON
    try {
      if (rawBody.trim().startsWith('{') || rawBody.trim().startsWith('[')) {
        jsonPayload = JSON.parse(rawBody);
      } else if (rawBody.includes('{') && rawBody.includes('}')) {
        // Extract JSON from multipart boundary
        const start = rawBody.indexOf('{');
        const end = rawBody.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          jsonPayload = JSON.parse(rawBody.substring(start, end + 1));
        }
      }
    } catch (err) {
      console.warn('[Hikvision ISAPI] Failed to parse JSON payload:', err);
      return events;
    }

    if (!jsonPayload) return events;

    // Normalize multiple formats
    const items = Array.isArray(jsonPayload) 
      ? jsonPayload 
      : (jsonPayload.events || jsonPayload.AccessControllerEventList || [jsonPayload]);

    for (const item of items) {
      const eventObj = item.AccessControllerEvent || item.event || item;
      
      const pin = eventObj.employeeNoString || eventObj.employeeNo || eventObj.cardNo || eventObj.user_id || eventObj.pin;
      if (!pin) continue;

      const timeStr = eventObj.time || eventObj.dateTime || eventObj.timestamp || new Date().toISOString();
      const timestamp = new Date(timeStr);

      // Determine check_in or check_out
      // Hikvision subEventType: 75 = Authenticated (Entry), 76 = Authenticated (Exit)
      // Or direction property: 'in' | 'out'
      const subType = Number(eventObj.subEventType || 0);
      const direction = String(eventObj.direction || '').toLowerCase();
      
      let eventType: 'check_in' | 'check_out' = 'check_in';
      if (direction === 'out' || subType === 76) {
        eventType = 'check_out';
      } else if (direction === 'in' || subType === 75) {
        eventType = 'check_in';
      } else if (device.status_code_map?.[String(subType)]) {
        eventType = device.status_code_map[String(subType)];
      }

      events.push({
        school_id: device.school_id,
        device_id: device.id,
        raw_serial_number: device.serial_number,
        person_external_id: String(pin).trim().toLowerCase(),
        timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp,
        event_type: eventType,
        verify_type: eventObj.currentVerifyMode || eventObj.verifyType || 'face',
        raw_payload: eventObj
      });
    }

    return events;
  }

  buildEnrollCommand(
    person: EnrollPersonInput,
    device?: DeviceRecord
  ): EnrollCommandResult {
    const isTeacher = person.role === 'teacher' || person.role === 'admin';
    const cleanPin = person.pin.trim();

    const isapiPayload = {
      UserInfo: {
        employeeNo: cleanPin,
        name: person.fullName.trim(),
        userType: isTeacher ? 'admin' : 'normal',
        closeDelayEnabled: false,
        Valid: {
          enable: true,
          beginTime: '2020-01-01T00:00:00',
          endTime: '2035-12-31T23:59:59',
          timeType: 'local'
        },
        doorRight: '1',
        RightPlan: [{ doorNo: 1, planTemplateNo: '1' }]
      }
    };

    return {
      command: `ISAPI /ISAPI/AccessControl/UserInfo/Record PUT ${JSON.stringify(isapiPayload)}`,
      transportType: 'rest_api',
      payload: isapiPayload
    };
  }
}
