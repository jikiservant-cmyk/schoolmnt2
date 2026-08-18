'use client';

import { useState, useEffect } from 'react';
import { 
  Cpu, 
  Wifi, 
  WifiOff, 
  Clock, 
  Activity, 
  Send, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Users, 
  GraduationCap, 
  Briefcase, 
  Wrench, 
  Building2, 
  Layers, 
  X, 
  Sparkles,
  Search
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { 
  pushUsersToDeviceAction, 
  getDevicePushCandidatesAction, 
  autoAssignDevicePinsAction,
  PushDeviceTargetOptions 
} from './actions';

interface DeviceItem {
  id: string;
  serial_number: string;
  label: string | null;
  ip_address: string | null;
  firmware_version: string | null;
  last_seen_at: string | null;
  created_at: string | null;
  is_active: boolean | null;
  school_id?: string | null;
  schools?: { id?: string; name?: string } | null;
}

interface ClassItem {
  id: string;
  name: string;
  school_id?: string | null;
}

interface Props {
  devices: DeviceItem[];
  classes?: ClassItem[];
}

type PushCategory = 'teachers' | 'support_staff' | 'class' | 'all_students' | 'all';

export default function DeviceLiveList({ devices, classes = [] }: Props) {
  const router = useRouter();
  const [now, setNow] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ msg: string; isError?: boolean; details?: string[] } | null>(null);

  // Modal State for Selective Device Push
  const [selectedDevice, setSelectedDevice] = useState<DeviceItem | null>(null);
  const [pushCategory, setPushCategory] = useState<PushCategory>('teachers');
  const [selectedClassId, setSelectedClassId] = useState<string>('');
  
  // Candidates preview state
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [candidatesData, setCandidatesData] = useState<{
    schoolName: string;
    totalCount: number;
    withPinCount: number;
    withoutPinCount: number;
    candidates: Array<{
      id: string;
      full_name: string;
      role: string;
      device_user_id: string | null;
      className: string | null;
      formattedName: string;
    }>;
  } | null>(null);

  const [isPushing, setIsPushing] = useState(false);
  const [candidateFilter, setCandidateFilter] = useState('');

  // Periodically refresh the server data and clock every 5 seconds
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const interval = setInterval(() => {
      setNow(Date.now());
      router.refresh();
    }, 5000);
    return () => clearInterval(interval);
  }, [router]);

  async function loadCandidates(dev: DeviceItem, category: PushCategory, classId?: string) {
    setIsLoadingCandidates(true);
    try {
      const options: PushDeviceTargetOptions = {
        deviceSerialNumber: dev.serial_number,
        category,
        classId: category === 'class' ? classId : undefined
      };
      const res = await getDevicePushCandidatesAction(options);
      if (res.success && res.candidates) {
        setCandidatesData({
          schoolName: res.schoolName || 'Connected School',
          totalCount: res.totalCount || 0,
          withPinCount: res.withPinCount || 0,
          withoutPinCount: res.withoutPinCount || 0,
          candidates: res.candidates
        });
      } else {
        setCandidatesData(null);
      }
    } catch {
      setCandidatesData(null);
    } finally {
      setIsLoadingCandidates(false);
    }
  }

  function handleOpenModal(dev: DeviceItem) {
    const deviceClasses = dev.school_id 
      ? classes.filter(c => c.school_id === dev.school_id)
      : classes;
    const initialClassId = deviceClasses.length > 0 ? deviceClasses[0].id : (classes[0]?.id || '');
    
    setSelectedDevice(dev);
    setPushCategory('teachers');
    setSelectedClassId(initialClassId);
    setCandidateFilter('');
    loadCandidates(dev, 'teachers', initialClassId);
  }

  function handleChangeCategory(cat: PushCategory) {
    setPushCategory(cat);
    if (selectedDevice) {
      loadCandidates(selectedDevice, cat, selectedClassId);
    }
  }

  function handleChangeClass(classId: string) {
    setSelectedClassId(classId);
    if (selectedDevice) {
      loadCandidates(selectedDevice, 'class', classId);
    }
  }

  // Auto-assign PINs to members missing PINs and push
  async function handleAutoAssignAndPush() {
    if (!selectedDevice) return;

    setIsPushing(true);
    setSyncStatus(null);

    try {
      const options: PushDeviceTargetOptions = {
        deviceSerialNumber: selectedDevice.serial_number,
        category: pushCategory,
        classId: pushCategory === 'class' ? selectedClassId : undefined
      };

      const res = await autoAssignDevicePinsAction(options);

      if (res.error) {
        setSyncStatus({ msg: res.error, isError: true });
      } else {
        setSyncStatus({ 
          msg: res.message || `Successfully assigned PINs and enqueued names to ${selectedDevice.label || selectedDevice.serial_number}!`,
        });
        // Reload candidates to reflect new PINs
        await loadCandidates(selectedDevice, pushCategory, selectedClassId);
      }
    } catch (err: any) {
      setSyncStatus({ msg: err.message || 'Failed to auto-assign and push names', isError: true });
    } finally {
      setIsPushing(false);
    }
  }

  // Execute pushing names
  async function handleExecutePush() {
    if (!selectedDevice) return;

    setIsPushing(true);
    setSyncStatus(null);

    try {
      const options: PushDeviceTargetOptions = {
        deviceSerialNumber: selectedDevice.serial_number,
        category: pushCategory,
        classId: pushCategory === 'class' ? selectedClassId : undefined
      };

      const res = await pushUsersToDeviceAction(options);

      if (res.error) {
        setSyncStatus({ msg: res.error, isError: true });
      } else {
        setSyncStatus({ 
          msg: res.message || `Successfully enqueued ${res.count} names to ${selectedDevice.label || selectedDevice.serial_number}!`,
          details: res.previewList
        });
        setSelectedDevice(null); // Close modal on success
      }
    } catch (err: any) {
      setSyncStatus({ msg: err.message || 'Failed to push names to terminal', isError: true });
    } finally {
      setIsPushing(false);
    }
  }

  if (!now) {
    return null; // Avoid hydration mismatch
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

  // Filter classes according to selected device school
  const relevantClasses = selectedDevice?.school_id
    ? classes.filter(c => !c.school_id || c.school_id === selectedDevice.school_id)
    : classes;

  const filteredPreviewList = (candidatesData?.candidates || []).filter(c => {
    if (!candidateFilter.trim()) return true;
    const term = candidateFilter.toLowerCase();
    return (
      c.full_name.toLowerCase().includes(term) ||
      (c.device_user_id && c.device_user_id.includes(term)) ||
      (c.className && c.className.toLowerCase().includes(term))
    );
  });

  return (
    <div className="space-y-4">
      {/* Global Toast Alert */}
      {syncStatus && (
        <div
          className={`p-4 rounded-xl border text-xs font-mono animate-fade-in ${
            syncStatus.isError
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold">
              {syncStatus.isError ? (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              ) : (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              )}
              <span>{syncStatus.msg}</span>
            </div>
            <button 
              type="button" 
              onClick={() => setSyncStatus(null)}
              className="text-gray-400 hover:text-gray-600 p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {syncStatus.details && syncStatus.details.length > 0 && (
            <div className="mt-2.5 pt-2 border-t border-emerald-200/60">
              <span className="text-[11px] text-emerald-900 font-medium block mb-1">
                Sample LCD entries sent to ADMS queue:
              </span>
              <div className="flex flex-wrap gap-1.5">
                {syncStatus.details.map((item, idx) => (
                  <span 
                    key={idx} 
                    className="inline-block px-2 py-0.5 rounded bg-white border border-emerald-300 text-[10px] text-emerald-900"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Devices List Cards */}
      {devices.map((dev) => {
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

        const schoolName = dev.schools?.name || 'Assigned School';

        return (
          <div
            key={dev.id}
            id={`device-card-${dev.id}`}
            className={`p-5 rounded-xl border transition duration-200 flex flex-col justify-between gap-4 ${
              isOnline
                ? 'bg-white border-emerald-300 shadow-sm'
                : 'bg-white border-gray-200'
            }`}
          >
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
              <div className="flex items-start gap-3.5">
                <div
                  className={`p-2.5 rounded-lg border transition ${
                    isOnline
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-600'
                      : 'bg-gray-100 border-gray-200 text-gray-400'
                  }`}
                >
                  <Cpu className="w-5 h-5" />
                </div>

                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-semibold text-base text-[#171719]">
                      {dev.label || 'Biometric Terminal'}
                    </h4>

                    {/* School Multi-tenant Badge */}
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                      <Building2 className="w-3 h-3 text-blue-600" />
                      {schoolName}
                    </span>

                    {isOnline && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300">
                        <Activity className="w-2.5 h-2.5 animate-pulse" />
                        LIVE SYNC
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono text-gray-500 mt-1.5">
                    <span>
                      SN: <span className="text-gray-800 font-semibold">{dev.serial_number}</span>
                    </span>
                    <span className="text-gray-300">•</span>
                    <span>
                      IP: <span className="text-gray-700">{dev.ip_address || '192.168.0.100'}</span>
                    </span>
                    <span className="text-gray-300">•</span>
                    <span>
                      Firmware: <span className="text-gray-700">{dev.firmware_version || 'v8.1.0'}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-row md:flex-col items-end gap-1.5 justify-between w-full md:w-auto pt-2 md:pt-0 border-t md:border-t-0 border-gray-100">
                <div className="flex items-center gap-2">
                  {isOnline ? (
                    <>
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                      </span>
                      <Wifi className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="text-xs font-mono font-semibold tracking-wide text-emerald-700">
                        CONNECTED
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-400"></span>
                      <WifiOff className="w-3.5 h-3.5 text-amber-600" />
                      <span className="text-xs font-mono font-medium tracking-wide text-amber-700">
                        OFFLINE / WAITING
                      </span>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-1 text-[11px] font-mono text-gray-400">
                  <Clock className="w-3 h-3 text-gray-400" />
                  <span>Last Ping: {timeAgoText}</span>
                </div>
              </div>
            </div>

            {/* Push Names Action Section */}
            <div className="pt-3 border-t border-gray-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-gray-50/50 -mx-5 -mb-5 p-4 rounded-b-xl">
              <div className="text-[11px] text-gray-500">
                LCD Screen Tag: <span className="font-semibold text-gray-700">Tr. [Name]</span> (Teachers) • <span className="font-semibold text-gray-700">Stf. [Name]</span> (Staff) • <span className="font-semibold text-gray-700">[Name] (Class)</span>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  id={`open-push-modal-btn-${dev.serial_number}`}
                  type="button"
                  onClick={() => handleOpenModal(dev)}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#007aff] hover:bg-[#0062cc] text-white shadow-sm transition active:scale-[0.98]"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Push Names to Device Screen</span>
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* ========================================================================= */}
      {/* SELECTIVE PUSH MODAL (Multi-Tenant & Category-Scoped) */}
      {/* ========================================================================= */}
      {selectedDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fade-in">
          <div 
            id="push-names-modal"
            className="bg-white rounded-2xl border border-gray-200 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-scale-up"
          >
            {/* Modal Header */}
            <div className="p-5 border-b border-gray-100 flex items-start justify-between gap-3 bg-[#fbfbfc]">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-blue-100 text-blue-700">
                    <Send className="w-4 h-4" />
                  </div>
                  <h3 className="text-base font-bold text-[#171719]">
                    Push Names to Biometric Screen
                  </h3>
                </div>
                <p className="text-xs text-gray-500">
                  Target Device: <span className="font-semibold text-gray-800">{selectedDevice.label || 'Terminal'}</span> (SN: {selectedDevice.serial_number})
                </p>
                <div className="flex items-center gap-1.5 text-xs text-blue-700 pt-0.5">
                  <Building2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Tenant Scope: <strong className="underline decoration-blue-300">{candidatesData?.schoolName || selectedDevice.schools?.name || 'Current School'}</strong></span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedDevice(null)}
                disabled={isPushing}
                className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-5">
              
              {/* Category Selector */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-700 mb-2">
                  1. Select Category to Push
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  
                  {/* Option: Teachers & Faculty */}
                  <button
                    type="button"
                    onClick={() => handleChangeCategory('teachers')}
                    className={`p-3 rounded-xl border text-left transition flex items-start gap-3 ${
                      pushCategory === 'teachers'
                        ? 'bg-blue-50 border-blue-500 ring-2 ring-blue-500/20'
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${pushCategory === 'teachers' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                      <Briefcase className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-gray-900">Teachers & Faculty</div>
                      <div className="text-[11px] text-gray-500 mt-0.5">Displays as &quot;Tr. [Name]&quot; on device LCD</div>
                    </div>
                  </button>

                  {/* Option: Support Staff */}
                  <button
                    type="button"
                    onClick={() => handleChangeCategory('support_staff')}
                    className={`p-3 rounded-xl border text-left transition flex items-start gap-3 ${
                      pushCategory === 'support_staff'
                        ? 'bg-blue-50 border-blue-500 ring-2 ring-blue-500/20'
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${pushCategory === 'support_staff' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                      <Wrench className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-gray-900">Support Staff</div>
                      <div className="text-[11px] text-gray-500 mt-0.5">Displays as &quot;Stf. [Name]&quot; on device LCD</div>
                    </div>
                  </button>

                  {/* Option: Students by Class */}
                  <button
                    type="button"
                    onClick={() => handleChangeCategory('class')}
                    className={`p-3 rounded-xl border text-left transition flex items-start gap-3 ${
                      pushCategory === 'class'
                        ? 'bg-blue-50 border-blue-500 ring-2 ring-blue-500/20'
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${pushCategory === 'class' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                      <Layers className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-gray-900">Students (Class by Class)</div>
                      <div className="text-[11px] text-gray-500 mt-0.5">Enroll specific classes one by one</div>
                    </div>
                  </button>

                  {/* Option: All Students */}
                  <button
                    type="button"
                    onClick={() => handleChangeCategory('all_students')}
                    className={`p-3 rounded-xl border text-left transition flex items-start gap-3 ${
                      pushCategory === 'all_students'
                        ? 'bg-blue-50 border-blue-500 ring-2 ring-blue-500/20'
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${pushCategory === 'all_students' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                      <GraduationCap className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-gray-900">All Students (Entire School)</div>
                      <div className="text-[11px] text-gray-500 mt-0.5">All student classes for this school</div>
                    </div>
                  </button>

                </div>

                {/* Option: All School Members */}
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => handleChangeCategory('all')}
                    className={`w-full p-2.5 rounded-xl border text-left transition flex items-center justify-between gap-3 ${
                      pushCategory === 'all'
                        ? 'bg-blue-50 border-blue-500 ring-2 ring-blue-500/20'
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Users className="w-4 h-4 text-blue-600" />
                      <span className="text-xs font-bold text-gray-900">Push All School Members (Teachers, Staff & Students)</span>
                    </div>
                    <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-gray-100 text-gray-600">Full Directory</span>
                  </button>
                </div>
              </div>

              {/* Class Selector Dropdown (When "class" category is selected) */}
              {pushCategory === 'class' && (
                <div className="p-4 rounded-xl bg-blue-50/70 border border-blue-200 space-y-2 animate-fade-in">
                  <label className="block text-xs font-bold text-blue-900">
                    Select Class for Enrollment:
                  </label>
                  {relevantClasses.length === 0 ? (
                    <p className="text-xs text-amber-700">No classes registered in this school yet. Please create classes first.</p>
                  ) : (
                    <select
                      id="select-push-class"
                      value={selectedClassId}
                      onChange={(e) => handleChangeClass(e.target.value)}
                      className="w-full bg-white border border-blue-300 rounded-lg px-3 py-2 text-xs font-medium text-gray-800 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                    >
                      {relevantClasses.map((cls) => (
                        <option key={cls.id} value={cls.id}>
                          Class: {cls.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Candidates Preview & Statistics */}
              <div className="border border-gray-200 rounded-xl p-4 bg-gray-50/50 space-y-3">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-[#007aff]" />
                    <span className="text-xs font-bold text-gray-900">
                      2. Screen Sync Preview
                    </span>
                  </div>

                  {candidatesData && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-semibold text-[11px]">
                        <CheckCircle2 className="w-3 h-3" />
                        {candidatesData.withPinCount} Ready with PIN
                      </span>
                      {candidatesData.withoutPinCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium text-[11px]">
                          {candidatesData.withoutPinCount} No PIN (Skipped)
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {isLoadingCandidates ? (
                  <div className="py-6 text-center text-xs text-gray-500 flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                    <span>Loading candidates for {candidatesData?.schoolName || 'school'}...</span>
                  </div>
                ) : !candidatesData || candidatesData.candidates.length === 0 ? (
                  <div className="py-6 text-center text-xs text-gray-500 bg-white rounded-lg border border-dashed border-gray-200">
                    No members found in this category for {candidatesData?.schoolName || 'this school'}.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Search inside candidate list */}
                    {candidatesData.candidates.length > 5 && (
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-gray-400" />
                        <input
                          type="text"
                          value={candidateFilter}
                          onChange={(e) => setCandidateFilter(e.target.value)}
                          placeholder="Filter preview names or PIN..."
                          className="w-full pl-8 pr-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-700 placeholder-gray-400 focus:outline-hidden focus:border-blue-400"
                        />
                      </div>
                    )}

                    <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 bg-white p-2 rounded-lg border border-gray-200 text-xs font-mono">
                      {filteredPreviewList.map((c) => {
                        const hasPin = !!c.device_user_id;
                        return (
                          <div 
                            key={c.id} 
                            className={`p-2 rounded flex items-center justify-between gap-2 border ${
                              hasPin 
                                ? 'bg-gray-50/80 border-gray-100 text-gray-800' 
                                : 'bg-amber-50/40 border-amber-200/50 text-gray-400'
                            }`}
                          >
                            <div className="flex items-center gap-2 truncate">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                hasPin ? 'bg-blue-100 text-blue-800' : 'bg-gray-200 text-gray-500'
                              }`}>
                                PIN: {c.device_user_id || 'None'}
                              </span>
                              <span className="font-semibold text-gray-900 truncate">
                                {c.full_name}
                              </span>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="text-[11px] text-[#007aff] font-bold">
                                → &quot;{c.formattedName}&quot;
                              </span>
                              {!hasPin && (
                                <span className="text-[9px] text-amber-700 bg-amber-100 px-1 py-0.5 rounded">
                                  No PIN
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#fbfbfc]">
              <button
                type="button"
                onClick={() => setSelectedDevice(null)}
                disabled={isPushing}
                className="w-full sm:w-auto px-4 py-2 rounded-lg text-xs font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 transition"
              >
                Cancel
              </button>

              <div className="flex flex-col sm:flex-row items-center gap-2 w-full sm:w-auto">
                {candidatesData && candidatesData.withoutPinCount > 0 && (
                  <button
                    id="auto-assign-and-push-btn"
                    type="button"
                    onClick={handleAutoAssignAndPush}
                    disabled={isPushing || isLoadingCandidates}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white shadow-xs transition disabled:opacity-50 active:scale-[0.98]"
                    title="Assign sequential biometric PINs to members missing PINs and push their names to the device"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Auto-assign PIN to ({candidatesData.withoutPinCount}) & Push</span>
                  </button>
                )}

                <button
                  id="confirm-push-names-btn"
                  type="button"
                  onClick={handleExecutePush}
                  disabled={isPushing || isLoadingCandidates || (candidatesData?.withPinCount || 0) === 0}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-xs font-bold bg-[#007aff] hover:bg-[#0062cc] text-white shadow-md transition disabled:opacity-50 active:scale-[0.98]"
                >
                  {isPushing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Sending to ADMS Queue...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      <span>
                        Push {candidatesData?.withPinCount || 0} Name(s) to Screen
                      </span>
                    </>
                  )}
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
