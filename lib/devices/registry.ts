import { DeviceAdapter, DeviceType } from './types';
import { ZKTecoAdmsAdapter } from './adapters/zkteco';
import { HikvisionIsapiAdapter } from './adapters/hikvision';
import { SupremaBiostarAdapter } from './adapters/suprema';
import { DahuaIsapiAdapter } from './adapters/dahua';
import { GenericWebhookAdapter } from './adapters/generic';

const adapterInstances: Record<DeviceType, DeviceAdapter> = {
  zkteco_adms: new ZKTecoAdmsAdapter(),
  hikvision_isapi: new HikvisionIsapiAdapter(),
  suprema_biostar: new SupremaBiostarAdapter(),
  dahua_isapi: new DahuaIsapiAdapter(),
  generic_webhook: new GenericWebhookAdapter(),
};

/**
 * Returns the matching adapter for the given device type,
 * defaulting to ZKTeco ADMS for backward-compatibility.
 */
export function getDeviceAdapter(deviceType?: string | null): DeviceAdapter {
  if (!deviceType) {
    return adapterInstances.zkteco_adms;
  }

  const normalized = deviceType.toLowerCase().trim() as DeviceType;
  return adapterInstances[normalized] || adapterInstances.zkteco_adms;
}

export interface DeviceTypeOption {
  type: DeviceType;
  label: string;
  manufacturer: string;
  protocolFamily: string;
  defaultEndpoint: string;
  description: string;
  sampleModels: string;
}

export const SUPPORTED_DEVICE_TYPES: DeviceTypeOption[] = [
  {
    type: 'zkteco_adms',
    label: 'ZKTeco ADMS (Push SDK)',
    manufacturer: 'ZKTeco / OEM Clones',
    protocolFamily: 'ADMS Line Protocol (HTTP/1.1)',
    defaultEndpoint: '/iclock/cdata',
    description: 'Hardware push protocol supported by ZKTeco F18, K40, UA series, MB series, and ZK-compatible clones.',
    sampleModels: 'F18, K40, MB360, SilkBio-101TC'
  },
  {
    type: 'hikvision_isapi',
    label: 'Hikvision ISAPI',
    manufacturer: 'Hikvision',
    protocolFamily: 'ISAPI REST / JSON / Multipart',
    defaultEndpoint: '/api/devices/push',
    description: 'Cloud push event protocol for Hikvision MinMoe facial recognition terminals and access controllers.',
    sampleModels: 'DS-K1T341, DS-K1T671, DS-K2600'
  },
  {
    type: 'suprema_biostar',
    label: 'Suprema BioStar',
    manufacturer: 'Suprema',
    protocolFamily: 'BioStar Cloud / REST Webhook',
    defaultEndpoint: '/api/devices/push',
    description: 'High-speed biometric push protocol for Suprema optical fingerprint and multi-modal facial devices.',
    sampleModels: 'BioStation 2, FaceStation F2, BioLite N2'
  },
  {
    type: 'dahua_isapi',
    label: 'Dahua Access Protocol',
    manufacturer: 'Dahua Technology',
    protocolFamily: 'Dahua HTTP Event Notification',
    defaultEndpoint: '/api/devices/push',
    description: 'Real-time HTTP push protocol for Dahua standalone time-attendance and access control terminals.',
    sampleModels: 'ASI7213X, ASA1222E, ASC2204B'
  },
  {
    type: 'generic_webhook',
    label: 'Generic Webhook (Custom IoT)',
    manufacturer: 'Universal / Edge Gateway',
    protocolFamily: 'Standard JSON REST Webhook',
    defaultEndpoint: '/api/devices/push',
    description: 'Simple JSON format for custom Raspberry Pi readers, barcode/NFC gates, or local Python bridge proxies.',
    sampleModels: 'Custom RFID scanner, ESP32, Mobile bridge'
  }
];
