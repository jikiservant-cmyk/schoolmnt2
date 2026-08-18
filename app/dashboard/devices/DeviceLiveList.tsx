'use client';

import { useState, useEffect } from 'react';
import { Cpu, Wifi, WifiOff, Clock, Activity, Send, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { pushAllUsersToDeviceAction } from './actions';

interface DeviceItem {
  id: string;
  serial_number: string;
  label: string | null;
  ip_address: string | null;
  firmware_version: string | null;
  last_seen_at: string | null;
  created_at: string | null;
  is_active: boolean | null;
}

interface Props {
  devices: DeviceItem[];
}

export default function DeviceLiveList({ devices }: Props) {
  const router = useRouter();
  const [now, setNow] = useState<number | null>(null);
  const [syncingSn, setSyncingSn] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ msg: string; isError?: boolean } | null>(null);

  // Periodically refresh the server data and clock every 5 seconds to show accurate live status
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const interval = setInterval(() => {
      setNow(Date.now());
      router.refresh();
    }, 5000);
    return () => clearInterval(interval);
  }, [router]);

  async function handleSyncNames(sn: string) {
    setSyncingSn(sn);
    setSyncStatus(null);
    try {
      const res = await pushAllUsersToDeviceAction(sn);
      if (res.error) {
        setSyncStatus({ msg: res.error, isError: true });
      } else {
        setSyncStatus({ msg: res.message || 'Queued name sync to terminal!' });
      }
    } catch (err: any) {
      setSyncStatus({ msg: err.message || 'Failed to sync', isError: true });
    } finally {
      setSyncingSn(null);
      setTimeout(() => setSyncStatus(null), 6000);
    }
  }

  if (!now) {
    return null; // Avoid hydration mismatch on initial render
  }

  if (devices.length === 0) {
    return (
      <div className="text-center py-10 px-4 bg-meridian-panel-raised/30 border border-dashed border-meridian-border rounded-xl">
        <WifiOff className="w-8 h-8 text-meridian-text-3 mx-auto mb-2.5 opacity-50" />
        <p className="text-sm text-meridian-text-2 font-medium">No biometric terminals registered yet</p>
        <p className="text-xs text-meridian-text-3 mt-1">Use the registration form on the right to link your physical ADMS terminal.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {syncStatus && (
        <div
          className={`p-3 rounded-lg border text-xs font-mono flex items-center gap-2 animate-fade-in ${
            syncStatus.isError
              ? 'bg-rose-950/40 border-rose-500/40 text-rose-300'
              : 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
          }`}
        >
          {syncStatus.isError ? (
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          )}
          <span>{syncStatus.msg}</span>
        </div>
      )}

      {devices.map((dev) => {
        // A device is considered ONLINE only if it sent a heartbeat/ADMS ping within the last 90 seconds
        let isOnline = false;
        let diffMinutes = 0;
        let timeAgoText = 'Never contacted server';

        if (dev.last_seen_at) {
          const lastSeenTime = new Date(dev.last_seen_at).getTime();
          const diffSeconds = Math.max(0, Math.floor((now - lastSeenTime) / 1000));
          diffMinutes = Math.floor(diffSeconds / 60);

          if (diffSeconds < 90) {
            isOnline = true;
            timeAgoText = diffSeconds < 10 ? 'Just now' : `${diffSeconds}s ago`;
          } else if (diffMinutes < 60) {
            timeAgoText = `${diffMinutes}m ago`;
          } else {
            const hours = Math.floor(diffMinutes / 60);
            timeAgoText = `${hours}h ago`;
          }
        }

        return (
          <div
            key={dev.id}
            id={`device-card-${dev.id}`}
            className={`p-5 rounded-xl border transition duration-200 flex flex-col justify-between gap-4 ${
              isOnline
                ? 'bg-meridian-panel-raised/80 border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.08)]'
                : 'bg-meridian-panel-raised/40 border-meridian-border'
            }`}
          >
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
              <div className="flex items-start gap-3.5">
                <div
                  className={`p-2.5 rounded-lg border transition ${
                    isOnline
                      ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-400'
                      : 'bg-meridian-deep border-meridian-border text-meridian-text-3'
                  }`}
                >
                  <Cpu className="w-5 h-5" />
                </div>

                <div>
                  <div className="flex items-center gap-2.5">
                    <h4 className="font-serif text-base font-semibold text-meridian-text-1">
                      {dev.label || 'Biometric Terminal'}
                    </h4>
                    {isOnline && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <Activity className="w-2.5 h-2.5 animate-pulse" />
                        LIVE SYNC
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono text-meridian-text-3 mt-1.5">
                    <span>
                      SN: <span className="text-meridian-text-2 font-medium">{dev.serial_number}</span>
                    </span>
                    <span className="text-meridian-border">•</span>
                    <span>
                      IP: <span className="text-meridian-text-2">{dev.ip_address || '192.168.0.100'}</span>
                    </span>
                    <span className="text-meridian-border">•</span>
                    <span>
                      Firmware: <span className="text-meridian-text-2">{dev.firmware_version || 'v8.1.0'}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-row md:flex-col items-end gap-1.5 justify-between w-full md:w-auto pt-2 md:pt-0 border-t md:border-t-0 border-meridian-border/50">
                <div className="flex items-center gap-2">
                  {isOnline ? (
                    <>
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                      </span>
                      <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-xs font-mono font-semibold tracking-wide text-emerald-400">
                        CONNECTED
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-500/50"></span>
                      <WifiOff className="w-3.5 h-3.5 text-amber-400/70" />
                      <span className="text-xs font-mono font-medium tracking-wide text-amber-400/80">
                        OFFLINE / WAITING
                      </span>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-1 text-[11px] font-mono text-meridian-text-3">
                  <Clock className="w-3 h-3 text-meridian-text-3/70" />
                  <span>Last Ping: {timeAgoText}</span>
                </div>
              </div>
            </div>

            {/* Quick Command Push Bar */}
            <div className="pt-3 border-t border-meridian-border/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <div className="text-[11px] font-mono text-meridian-text-3">
                LCD Display Format: <span className="text-meridian-gold font-medium">Name + Class / Tr. Name + (Staff)</span>
              </div>

              <button
                id={`sync-names-btn-${dev.serial_number}`}
                type="button"
                onClick={() => handleSyncNames(dev.serial_number)}
                disabled={syncingSn === dev.serial_number}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium bg-meridian-deep hover:bg-meridian-gold/10 text-meridian-text-2 hover:text-meridian-gold border border-meridian-border hover:border-meridian-gold/30 transition disabled:opacity-50"
              >
                {syncingSn === dev.serial_number ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-meridian-gold" />
                    <span>Pushing Names...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5 text-meridian-gold" />
                    <span>Push Names & Classes to Screen</span>
                  </>
                )}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
