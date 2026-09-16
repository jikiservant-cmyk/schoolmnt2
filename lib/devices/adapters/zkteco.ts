import { DeviceAdapter, DeviceRecord, AttendanceEvent, EnrollPersonInput, EnrollCommandResult, HandshakeResponse } from '../types';
import { isAuthorizedToken } from '../metadata';
import { formatZKTecoDisplayName } from '@/utils/zkteco/formatter';

export class ZKTecoAdmsAdapter implements DeviceAdapter {
  readonly deviceType = 'zkteco_adms';
  readonly displayName = 'ZKTeco ADMS (Push SDK / iClock)';
  readonly protocolFamily = 'ADMS Line Protocol';
  readonly defaultEndpoint = '/iclock/cdata';

  buildAuthCheck(req: Request, device: DeviceRecord): boolean {
    const url = new URL(req.url);
    const providedToken = 
      req.headers.get('x-device-token') ||
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token') ||
      url.searchParams.get('push_token') ||
      url.searchParams.get('PushToken');

    return isAuthorizedToken(providedToken, device.device_secret, process.env.ZKTECO_DEVICE_SECRET);
  }

  buildHandshakeResponse(device: DeviceRecord): HandshakeResponse {
    // Dynamic Timezone calculation (e.g. Africa/Kampala UTC+3 is +180 minutes)
    let tzMinutes = 180;
    try {
      const tz = device.config?.timeZone || 'Africa/Kampala';
      // Calculate offset for current date in minutes
      const now = new Date();
      const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
      const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      tzMinutes = Math.round((tzDate.getTime() - utcDate.getTime()) / 60000);
    } catch {
      tzMinutes = 180;
    }

    const responseText = [
      `GET OPTION FROM: ${device.serial_number}`,
      `Stamp=9999`,
      `OpStamp=9999`,
      `ErrorDelay=60`,
      `Delay=10`,
      `TransTimes=00:00;14:00`,
      `TransInterval=1`,
      `TransFlag=1111000000`,
      `TimeZone=${tzMinutes}`,
      `Realtime=1`,
      `Encrypt=0`
    ].join('\n');

    return {
      body: responseText,
      contentType: 'text/plain',
      status: 200
    };
  }

  parseIncomingPush(
    rawBody: string,
    headers: Headers,
    url: URL,
    device: DeviceRecord
  ): AttendanceEvent[] {
    const lines = rawBody.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);
    const events: AttendanceEvent[] = [];

    for (const line of lines) {
      let pin = '';
      let datetimeStr = '';
      let statusNum = '0';
      let verifyType = '1';

      if (line.includes('\t')) {
        const parts = line.split('\t').map(s => s.trim());
        pin = parts[0];
        datetimeStr = parts[1];
        statusNum = parts[2] || '0';
        verifyType = parts[3] || '1';
      } else if (line.includes(',')) {
        const parts = line.split(',').map(s => s.trim());
        pin = parts[0];
        datetimeStr = parts[1];
        statusNum = parts[2] || '0';
        verifyType = parts[3] || '1';
      } else {
        const match = line.match(/^(\S+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\s+(\d+))?(?:\s+(\d+))?/);
        if (match) {
          pin = match[1];
          datetimeStr = match[2];
          statusNum = match[3] || '0';
          verifyType = match[4] || '1';
        } else {
          const parts = line.split(/\s+/);
          if (parts.length >= 3) {
            pin = parts[0];
            datetimeStr = `${parts[1]} ${parts[2]}`;
            statusNum = parts[3] || '0';
          }
        }
      }

      if (!pin || !datetimeStr) continue;

      const cleanPin = pin.trim().toLowerCase();
      
      let logDate: Date;
      try {
        if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(datetimeStr.trim())) {
          logDate = new Date(datetimeStr.trim().replace(' ', 'T') + '+03:00');
        } else {
          logDate = new Date(datetimeStr);
        }
      } catch {
        logDate = new Date();
      }

      // Check max variance: skip records older than 60 days to protect against corrupt RTCs
      if (Math.abs(logDate.getTime() - Date.now()) > 60 * 24 * 60 * 60 * 1000) {
        continue;
      }

      // Map status from device config status_code_map (fallback: 0 -> check_in, 1 -> check_out)
      const mappedType = device.status_code_map?.[statusNum] || (statusNum === '1' ? 'check_out' : 'check_in');

      events.push({
        school_id: device.school_id,
        device_id: device.id,
        raw_serial_number: device.serial_number,
        person_external_id: cleanPin,
        timestamp: logDate,
        event_type: mappedType,
        verify_type: verifyType,
        raw_payload: {
          raw_line: line,
          status_num: statusNum,
          verify_type: verifyType
        }
      });
    }

    return events;
  }

  buildEnrollCommand(
    person: EnrollPersonInput,
    device?: DeviceRecord
  ): EnrollCommandResult {
    const displayName = formatZKTecoDisplayName({
      full_name: person.fullName,
      role: person.role as any,
      classes: person.className ? { name: person.className } : null
    });

    const pri = person.role === 'admin' ? 14 : 0;
    const cleanPin = person.pin.trim();
    const command = `DATA UPDATE userinfo PIN=${cleanPin}\tName=${displayName}\tPri=${pri}`;

    return {
      command,
      transportType: 'adms_command',
      payload: {
        pin: cleanPin,
        name: displayName,
        pri
      }
    };
  }
}
