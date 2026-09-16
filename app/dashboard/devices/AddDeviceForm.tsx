'use client';

import { useState, useTransition, useEffect } from 'react';
import { addDeviceAction } from './actions';
import { Plus, HelpCircle, Key, RefreshCw, Copy, Check, ShieldCheck, Cpu } from 'lucide-react';
import { SUPPORTED_DEVICE_TYPES, DeviceTypeOption } from '@/lib/devices/registry';
import { DeviceType } from '@/lib/devices/types';

function createRandomSecret(): string {
  const chars = '0123456789abcdef';
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand += chars[Math.floor(Math.random() * chars.length)];
  }
  return `dev_sec_${rand}`;
}

export default function AddDeviceForm() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const [selectedType, setSelectedType] = useState<DeviceType>('zkteco_adms');
  const [deviceSecret, setDeviceSecret] = useState<string>(createRandomSecret);

  const generateSecret = () => {
    setDeviceSecret(createRandomSecret());
  };

  const handleCopySecret = () => {
    if (!deviceSecret) return;
    navigator.clipboard.writeText(deviceSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const currentTypeMeta = SUPPORTED_DEVICE_TYPES.find(t => t.type === selectedType) || SUPPORTED_DEVICE_TYPES[0];

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const form = e.currentTarget;
    const formData = new FormData(form);

    startTransition(async () => {
      try {
        const res = await addDeviceAction(formData);
        if (res && res.error) {
          setError(res.error);
        } else {
          setSuccess(true);
          form.reset();
          generateSecret();
          setTimeout(() => setSuccess(false), 4000);
        }
      } catch (err: any) {
        setError(err?.message || 'A network error occurred. Please try again.');
      }
    });
  };

  return (
    <div className="bg-meridian-panel border border-meridian-border rounded-xl p-6 h-fit sticky top-6 space-y-6">
      <div className="pb-3 border-b border-meridian-border">
        <h3 className="font-serif text-lg font-medium text-meridian-text-1 flex items-center gap-2">
          <Cpu className="w-5 h-5 text-meridian-gold" />
          Register Biometric Terminal
        </h3>
        <p className="text-[10px] font-mono uppercase tracking-wider text-meridian-text-3 mt-1">
          Multi-Vendor Hardware Provisioning
        </p>
      </div>

      {error && (
        <div className="p-3 text-xs font-mono text-meridian-loss bg-meridian-loss/15 rounded-lg border border-meridian-loss/30 animate-fade-in">
          {error}
        </div>
      )}

      {success && (
        <div className="p-3 text-xs font-mono text-meridian-gold bg-meridian-gold/15 rounded-lg border border-meridian-gold/30 animate-fade-in">
          Terminal registered successfully with assigned security credentials.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        
        {/* Device Protocol / Vendor Selection */}
        <div className="space-y-1.5">
          <label htmlFor="deviceType" className="text-xs font-mono uppercase tracking-wider text-meridian-text-2">
            Device Vendor / Protocol
          </label>
          <select
            id="deviceType"
            name="deviceType"
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as DeviceType)}
            disabled={isPending}
            className="w-full px-3 py-2 bg-meridian-panel-raised border border-meridian-border text-sm rounded-lg focus:outline-none focus:ring-1 focus:ring-meridian-gold focus:border-meridian-gold text-meridian-text-1"
          >
            {SUPPORTED_DEVICE_TYPES.map((opt) => (
              <option key={opt.type} value={opt.type}>
                {opt.label} ({opt.manufacturer})
              </option>
            ))}
          </select>
          <p className="text-[11px] text-meridian-text-3 font-mono leading-tight">
            {currentTypeMeta.description}
          </p>
        </div>

        {/* Serial Number */}
        <div className="space-y-1.5">
          <label htmlFor="serialNumber" className="text-xs font-mono uppercase tracking-wider text-meridian-text-2">
            Device Serial Number (Unique)
          </label>
          <input
            id="serialNumber"
            name="serialNumber"
            type="text"
            required
            placeholder="e.g. BAY5261000202 or DS-K1T671-001"
            disabled={isPending}
            className="w-full px-3 py-2 bg-meridian-panel-raised border border-meridian-border text-sm rounded-lg focus:outline-none focus:ring-1 focus:ring-meridian-gold focus:border-meridian-gold transition-colors disabled:opacity-50 text-meridian-text-1 placeholder-meridian-text-3/60 font-mono"
          />
        </div>

        {/* Placement Label */}
        <div className="space-y-1.5">
          <label htmlFor="label" className="text-xs font-mono uppercase tracking-wider text-meridian-text-2">
            Placement Label
          </label>
          <input
            id="label"
            name="label"
            type="text"
            placeholder="e.g. Main Gate North Entrance"
            disabled={isPending}
            className="w-full px-3 py-2 bg-meridian-panel-raised border border-meridian-border text-sm rounded-lg focus:outline-none focus:ring-1 focus:ring-meridian-gold focus:border-meridian-gold transition-colors disabled:opacity-50 text-meridian-text-1 placeholder-meridian-text-3/60"
          />
        </div>

        {/* Static IP / Host */}
        <div className="space-y-1.5">
          <label htmlFor="ipAddress" className="text-xs font-mono uppercase tracking-wider text-meridian-text-2">
            Static IP / Host (Optional)
          </label>
          <input
            id="ipAddress"
            name="ipAddress"
            type="text"
            placeholder="e.g. 192.168.1.150"
            disabled={isPending}
            className="w-full px-3 py-2 bg-meridian-panel-raised border border-meridian-border text-sm rounded-lg focus:outline-none focus:ring-1 focus:ring-meridian-gold focus:border-meridian-gold transition-colors disabled:opacity-50 text-meridian-text-1 placeholder-meridian-text-3/60 font-mono"
          />
        </div>

        {/* Per-Device Authentication Secret */}
        <div className="space-y-1.5">
          <div className="flex justify-between items-center">
            <label htmlFor="deviceSecret" className="text-xs font-mono uppercase tracking-wider text-meridian-text-2 flex items-center gap-1.5">
              <Key className="w-3 h-3 text-meridian-gold" />
              Per-Device Secret Token
            </label>
            <button
              type="button"
              onClick={generateSecret}
              title="Generate new secret token"
              className="text-[10px] font-mono text-meridian-gold hover:text-meridian-gold-dim flex items-center gap-1 transition"
            >
              <RefreshCw className="w-2.5 h-2.5" />
              Regenerate
            </button>
          </div>
          <div className="relative flex items-center">
            <input
              id="deviceSecret"
              name="deviceSecret"
              type="text"
              readOnly
              value={deviceSecret}
              className="w-full px-3 py-2 pr-10 bg-meridian-panel-raised border border-meridian-border text-xs rounded-lg font-mono text-meridian-gold select-all"
            />
            <button
              type="button"
              onClick={handleCopySecret}
              className="absolute right-2 p-1.5 text-meridian-text-3 hover:text-meridian-text-1 transition"
              title="Copy secret to clipboard"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
          <p className="text-[10px] font-mono text-meridian-text-3">
            Individual token for this unit. Authorizes HTTP push requests without exposing other terminals.
          </p>
        </div>

        {/* Business Rule Overrides: Late Cutoff & Timezone */}
        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-meridian-border/50">
          <div className="space-y-1">
            <label htmlFor="lateCutoff" className="text-[11px] font-mono uppercase tracking-wider text-meridian-text-2">
              Late Cutoff
            </label>
            <input
              id="lateCutoff"
              name="lateCutoff"
              type="time"
              defaultValue="08:00"
              className="w-full px-2 py-1.5 bg-meridian-panel-raised border border-meridian-border text-xs rounded font-mono text-meridian-text-1"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="timeZone" className="text-[11px] font-mono uppercase tracking-wider text-meridian-text-2">
              Timezone
            </label>
            <select
              id="timeZone"
              name="timeZone"
              defaultValue="Africa/Kampala"
              className="w-full px-2 py-1.5 bg-meridian-panel-raised border border-meridian-border text-xs rounded font-mono text-meridian-text-1"
            >
              <option value="Africa/Kampala">EAT (UTC+3, Kampala)</option>
              <option value="Africa/Nairobi">EAT (UTC+3, Nairobi)</option>
              <option value="Africa/Kigali">CAT (UTC+2, Kigali)</option>
              <option value="Africa/Dar_es_Salaam">EAT (UTC+3, Dar)</option>
              <option value="UTC">UTC / GMT</option>
            </select>
          </div>
        </div>

        <button
          type="submit"
          disabled={isPending}
          className="w-full mt-6 py-2 px-4 text-xs font-mono uppercase tracking-widest text-[#FBFAF3] bg-meridian-gold hover:bg-meridian-gold-dim border border-transparent rounded-lg transition duration-200 disabled:opacity-75 flex items-center justify-center gap-2 cursor-pointer shadow-sm"
        >
          <Plus className="w-3.5 h-3.5" />
          {isPending ? 'Provisioning Device...' : 'Register Terminal'}
        </button>
      </form>

      {/* Dynamic Hardware Connection Guide */}
      <div className="pt-4 border-t border-meridian-border text-[11px] font-mono text-meridian-text-3 space-y-3">
        <div className="flex items-center gap-1.5 text-meridian-text-2 font-medium">
          <HelpCircle className="w-3.5 h-3.5 text-meridian-gold" />
          <span>{currentTypeMeta.label} Setup Guide</span>
        </div>

        {selectedType === 'zkteco_adms' && (
          <div className="space-y-2">
            <p className="leading-relaxed">
              1. <strong>Comm. &gt; Ethernet:</strong> Ensure DHCP = ON and Ethernet cable is connected.
            </p>
            <p className="leading-relaxed">
              2. <strong>Comm. &gt; Cloud Server Setting:</strong>
              <br />• Enable Domain Name: <strong>ON</strong>
              <br />• Server Address: <code className="text-meridian-gold select-all">{typeof window !== 'undefined' ? window.location.hostname : 'your-cloud-domain.com'}</code>
              <br />• Server Port: <strong>443</strong> | HTTPS: <strong>ON</strong>
              <br />• Push Path: <code>/iclock/cdata</code>
            </p>
          </div>
        )}

        {selectedType === 'hikvision_isapi' && (
          <div className="space-y-2">
            <p className="leading-relaxed">
              1. Open MinMoe Web Config &gt; <strong>Network &gt; Advanced &gt; HTTP Listening / Alarm Linkage</strong>.
            </p>
            <p className="leading-relaxed">
              2. Set Destination URL to:
              <code className="block bg-meridian-deep p-1.5 my-1 rounded text-meridian-gold break-all select-all">
                {typeof window !== 'undefined' ? window.location.origin : 'https://your-domain.com'}/api/devices/push?sn=[SERIAL]
              </code>
              Header: <code>X-Device-Token: {deviceSecret}</code>
            </p>
          </div>
        )}

        {selectedType === 'suprema_biostar' && (
          <div className="space-y-2">
            <p className="leading-relaxed">
              1. In BioStar 2 &gt; <strong>Settings &gt; Server &gt; Event Webhook</strong>.
            </p>
            <p className="leading-relaxed">
              2. Target URL:
              <code className="block bg-meridian-deep p-1.5 my-1 rounded text-meridian-gold break-all select-all">
                {typeof window !== 'undefined' ? window.location.origin : 'https://your-domain.com'}/api/devices/push?sn=[SERIAL]
              </code>
              Auth Token: <code>{deviceSecret}</code>
            </p>
          </div>
        )}

        {selectedType === 'dahua_isapi' && (
          <div className="space-y-2">
            <p className="leading-relaxed">
              1. In Terminal Web GUI &gt; <strong>Event &gt; HTTP Push Notification</strong>.
            </p>
            <p className="leading-relaxed">
              2. Enter Server URL:
              <code className="block bg-meridian-deep p-1.5 my-1 rounded text-meridian-gold break-all select-all">
                {typeof window !== 'undefined' ? window.location.origin : 'https://your-domain.com'}/api/devices/push?sn=[SERIAL]
              </code>
            </p>
          </div>
        )}

        {selectedType === 'generic_webhook' && (
          <div className="space-y-2">
            <p className="leading-relaxed">
              Push standard JSON attendance events to:
              <code className="block bg-meridian-deep p-1.5 my-1 rounded text-meridian-gold break-all select-all">
                POST /api/devices/push?sn=[SERIAL]
              </code>
              Payload:
              <code className="block bg-meridian-deep p-1.5 my-1 rounded text-meridian-gold break-all select-all text-[10px]">
                {`{"events": [{"pin": "1001", "type": "check_in", "timestamp": "${new Date().toISOString()}"}]}`}
              </code>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
