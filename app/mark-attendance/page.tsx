'use client';

import { useState, useEffect, useTransition } from 'react';
import { submitClockInAction, getPeopleWithDeviceIds } from './actions';
import { 
  ArrowLeft, 
  Cpu, 
  Fingerprint, 
  Wifi, 
  Check, 
  AlertCircle,
  HelpCircle,
  Clock
} from 'lucide-react';
import Link from 'next/link';

export default function MarkAttendance() {
  const [isPending, startTransition] = useTransition();
  const [pin, setPin] = useState<string>('');
  const [statusText, setStatusText] = useState<string>('SYSTEM READY');
  const [statusMode, setStatusMode] = useState<'idle' | 'success' | 'error' | 'loading'>('idle');
  const [currentTime, setCurrentTime] = useState<string>('12:00:00');
  const [mounted, setMounted] = useState(false);
  const [successInfo, setSuccessInfo] = useState<{ name: string; role: string } | null>(null);
  const [availablePeople, setAvailablePeople] = useState<{ full_name: string; role: string; device_user_id: string }[]>([]);

  // Blinking colon indicator for digital clock
  const [colonVisible, setColonVisible] = useState(true);

  useEffect(() => {
    Promise.resolve().then(() => {
      setMounted(true);
      setCurrentTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
    });
    // Clock updates
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(now.toLocaleTimeString('en-US', { hour12: false }));
      setColonVisible(v => !v);
    }, 1000);
    
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    async function loadPeople() {
      try {
        const data = await getPeopleWithDeviceIds();
        setAvailablePeople(data);
      } catch (err) {
        console.error('Failed to load registered people for attendance emulator list:', err);
      }
    }
    loadPeople();
  }, []);

  const handleKeyPress = (num: string) => {
    if (statusMode === 'success' || statusMode === 'error') {
      // Clear message on new type
      setStatusMode('idle');
      setStatusText('SYSTEM READY');
      setSuccessInfo(null);
    }

    if (pin.length < 8) {
      setPin(prev => prev + num);
    }
  };

  const handleClear = () => {
    setPin('');
    setStatusMode('idle');
    setStatusText('SYSTEM READY');
    setSuccessInfo(null);
  };

  const handleBackspace = () => {
    if (pin.length > 0) {
      setPin(prev => prev.slice(0, -1));
    }
  };

  const handleEnter = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!pin) return;

    setStatusMode('loading');
    setStatusText('TRANSMITTING...');
    setSuccessInfo(null);

    startTransition(async () => {
      try {
        const res = await submitClockInAction(pin);
        if (res && res.error) {
          setStatusMode('error');
          setStatusText(res.error.toUpperCase());
        } else if (res && res.success) {
          setStatusMode('success');
          setStatusText('ACCESS GRANTED');
          setSuccessInfo({
            name: res.fullName || 'User',
            role: res.role || 'MEMBER'
          });
          setPin(''); // Reset digits
        }
      } catch (err: any) {
        setStatusMode('error');
        setStatusText('TRANSMISSION ERROR');
        console.error('Clock in transmission failed:', err);
      }
    });
  };

  return (
    <div className="min-h-screen bg-meridian-deep text-meridian-text-1 flex flex-col items-center justify-center p-6 select-none relative">
      
      {/* Decorative background rings */}
      <div className="absolute top-10 left-10 opacity-10 pointer-events-none select-none">
        <svg width="300" height="300" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="40" fill="none" stroke="#1E3226" strokeWidth="1"/>
          <circle cx="100" cy="100" r="70" fill="none" stroke="#1E3226" strokeWidth="1"/>
          <circle cx="100" cy="100" r="100" fill="none" stroke="#1E3226" strokeWidth="1"/>
        </svg>
      </div>

      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-12 gap-8 items-center z-10">
        
        {/* Helper Instructions panel (Left 5 Columns on desktop) */}
        <div className="md:col-span-5 space-y-6">
          <div className="space-y-2">
            <Link 
              href="/dashboard" 
              className="inline-flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-meridian-text-2 hover:text-meridian-gold transition"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Portal Overview
            </Link>
            <h1 className="font-serif text-3xl font-medium tracking-tight text-meridian-text-1">
              Terminal Simulator
            </h1>
            <p className="text-xs text-meridian-text-3 font-mono uppercase tracking-widest">
              Biometric Clock-In hardware emulator
            </p>
          </div>

          <div className="bg-meridian-panel border border-meridian-border rounded-xl p-5 space-y-4 shadow-xs">
            <h4 className="font-serif text-sm font-semibold text-meridian-text-1 flex items-center gap-2">
              <HelpCircle className="w-4 h-4 text-meridian-gold" />
              How to operate terminal
            </h4>
            <div className="text-xs text-meridian-text-2 space-y-2 leading-relaxed">
              <p>
                This board simulates a wall-mounted physical ZKTeco ADMS biometric clocking terminal.
              </p>
              <p>
                1. Input a student or teacher&apos;s <strong className="text-meridian-gold">Device User ID</strong> (e.g., <span className="font-mono bg-meridian-deep px-1 py-0.5 rounded text-[10.5px]">101</span>, <span className="font-mono bg-meridian-deep px-1 py-0.5 rounded text-[10.5px]">102</span>) using the physical keypads or your keyboard.
              </p>
              <p>
                2. Click <strong className="text-meridian-text-1">ENTER (E)</strong> on the terminal matrix or press enter on your device.
              </p>
              <p>
                3. The local TCP agent transmits the data to our Supabase database instance securely.
              </p>
            </div>

            <div className="pt-3 border-t border-meridian-border">
              <div className="text-[10px] font-mono uppercase tracking-widest text-meridian-text-3 mb-2 font-semibold">
                Available Directory IDs for Testing:
              </div>
              {availablePeople.length > 0 ? (
                <ul className="space-y-1 text-xs font-mono text-meridian-text-2 max-h-48 overflow-y-auto">
                  {availablePeople.map((person) => (
                    <li key={person.device_user_id} className="flex items-center justify-between bg-meridian-panel-raised/50 px-2.5 py-1 rounded">
                      <span className="truncate max-w-[200px]">{person.full_name}</span>
                      <span className="text-[9px] text-meridian-text-3 uppercase">({person.role})</span>
                      <span className="text-meridian-gold font-bold">{person.device_user_id}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-meridian-text-3 font-mono italic">
                  No active enrolled device users found. Register a person with a Device User ID in the directory first to test.
                </p>
              )}
              <p className="text-[9px] text-meridian-text-3 mt-2 leading-tight">
                * Note: Registering any new person in the directory with a &quot;Device User ID&quot; instantly links them here!
              </p>
            </div>
          </div>
        </div>

        {/* Biometric Wall Unit (Right 7 Columns on desktop) */}
        <div className="md:col-span-7 flex justify-center">
          
          {/* Wall mount chassis */}
          <div className="w-full max-w-sm bg-meridian-text-1 border border-[#0d1711] rounded-3xl p-6 shadow-2xl relative overflow-hidden flex flex-col items-center">
            
            {/* Glossy terminal top status bar */}
            <div className="w-full flex justify-between items-center text-[10px] font-mono text-[#75886F] mb-4 pb-2 border-b border-[#2d3e32]/80 select-none">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-meridian-gold" />
                <span>ZK-ADMS PRO v8</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-meridian-gain animate-ping"></span>
                <Wifi className="w-3.5 h-3.5 text-meridian-gain" />
                <span>ONLINE</span>
              </div>
            </div>

            {/* Simulated LCD Screen Panel */}
            <div className="w-full bg-[#14241b] border border-[#254534] rounded-xl p-4 flex flex-col justify-between h-40 shadow-inner relative select-none">
              
              {/* LCD Screen Reflection overlay */}
              <div className="absolute inset-0 bg-gradient-to-tr from-white/0 via-white/5 to-white/10 rounded-xl pointer-events-none"></div>
              
              <div className="flex justify-between items-start">
                <span className="text-[10px] font-mono uppercase tracking-widest text-meridian-text-3 font-semibold">
                  NA&apos;JIKI TECH SYSTEM
                </span>
                
                {/* Real-time blinking clock */}
                <div className="flex items-center gap-1 text-xs font-mono font-bold text-meridian-gold">
                  <Clock className="w-3.5 h-3.5 text-meridian-gold" />
                  <span>
                    {mounted ? currentTime.split(':').slice(0, 2).join(colonVisible ? ':' : ' ') : '--:--'}
                  </span>
                </div>
              </div>

              {/* Dynamic status messaging display row */}
              <div className="my-auto space-y-1.5">
                <div className={`text-center font-mono text-xs tracking-widest font-bold px-2 py-1 rounded transition duration-200 ${
                  statusMode === 'success' 
                    ? 'bg-meridian-gold/20 text-meridian-gold border border-meridian-gold/40' 
                    : statusMode === 'error'
                      ? 'bg-meridian-loss/20 text-meridian-loss border border-meridian-loss/40'
                      : 'text-meridian-text-1'
                }`}>
                  {statusText}
                </div>

                {successInfo && (
                  <div className="text-center font-serif text-sm font-semibold tracking-wide text-meridian-text-1 animate-fade-in">
                    {successInfo.name} <span className="text-[10px] font-mono text-meridian-text-3">({successInfo.role})</span>
                  </div>
                )}
              </div>

              {/* Pin input screen indicators */}
              <div className="flex justify-between items-baseline border-t border-[#254534] pt-2 text-xs font-mono">
                <span className="text-meridian-text-3">ENROLLMENT ID:</span>
                <span className="text-lg font-bold tracking-widest text-meridian-gold bg-meridian-panel-raised px-2 rounded min-w-[60px] text-right border border-meridian-border">
                  {pin || '—'}
                </span>
              </div>

            </div>

            {/* Interactive Hardware Matrix Keypad */}
            <div className="w-full grid grid-cols-3 gap-2.5 mt-6 px-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => handleKeyPress(num)}
                  disabled={isPending}
                  className="py-3 bg-[#1c3024] hover:bg-[#254534] active:bg-[#14241b] text-[#f0fdf4] border border-[#254534] rounded-xl font-mono text-lg font-bold shadow-md cursor-pointer transition active:scale-95 flex items-center justify-center select-none"
                >
                  {num}
                </button>
              ))}

              {/* CLEAR BUTTON */}
              <button
                type="button"
                onClick={handleClear}
                disabled={isPending}
                className="py-3 bg-[#3b1c1c] hover:bg-[#522525] text-red-300 border border-[#522525] rounded-xl font-mono text-base font-bold shadow-md cursor-pointer transition active:scale-95 flex items-center justify-center select-none"
              >
                CLEAR
              </button>

              {/* ZERO KEY */}
              <button
                type="button"
                onClick={() => handleKeyPress('0')}
                disabled={isPending}
                className="py-3 bg-[#1c3024] hover:bg-[#254534] active:bg-[#14241b] text-[#f0fdf4] border border-[#254534] rounded-xl font-mono text-lg font-bold shadow-md cursor-pointer transition active:scale-95 flex items-center justify-center select-none"
              >
                0
              </button>

              {/* ENTER / SUBMIT KEY */}
              <button
                type="button"
                onClick={() => handleEnter()}
                disabled={isPending || !pin}
                className="py-3 bg-meridian-gold/20 hover:bg-meridian-gold/30 active:bg-meridian-gold/10 text-meridian-gold border border-meridian-gold/40 rounded-xl font-mono text-base font-bold shadow-md cursor-pointer transition active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center select-none"
              >
                ENTER
              </button>
            </div>

            {/* Backspace utility key overlay */}
            <div className="w-full px-2 mt-2">
              <button
                type="button"
                onClick={handleBackspace}
                disabled={isPending || pin.length === 0}
                className="w-full py-2 bg-[#1c3024]/60 hover:bg-[#1c3024] text-meridian-text-2 border border-[#254534] rounded-lg font-mono text-xs transition active:scale-95 disabled:opacity-30 flex items-center justify-center gap-1 cursor-pointer"
              >
                ⌫ BACKSPACE
              </button>
            </div>

            {/* Simulated Glass biometric optical fingerprint reader block */}
            <div className="mt-6 flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-gradient-to-b from-[#1b3425] to-[#122319] border-2 border-[#3b5d47] shadow-xl flex items-center justify-center relative cursor-pointer group active:scale-95 transition" onClick={() => {
                if (pin) handleEnter();
                else {
                  setStatusMode('error');
                  setStatusText('TYPE ID FIRST');
                }
              }}>
                {/* Luminous laser line */}
                <div className="absolute w-12 h-0.5 bg-[#4ef481] opacity-75 animate-bounce blur-[0.5px]"></div>
                <Fingerprint className="w-8 h-8 text-[#4ef481] group-hover:scale-105 transition" />
              </div>
              <span className="text-[9px] font-mono tracking-widest text-[#75886F] mt-2 select-none uppercase">
                OPTI-SCAN BARCODE
              </span>
            </div>

          </div>
        </div>

        <div className="mt-8 text-center text-xs font-mono text-meridian-text-3">
          Na&apos;Jiki Tech Biometric Terminal &bull; <span className="text-meridian-gold font-medium">ADMS Hardware Engine</span>
        </div>

      </div>

    </div>
  );
}
