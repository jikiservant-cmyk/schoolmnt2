'use client';

import { useState } from 'react';
import { KeyRound, Copy, Check, RefreshCw, X, ShieldCheck } from 'lucide-react';
import { resetTeacherPinAction } from './actions';

interface TeacherPinManagerProps {
  personId: string;
  fullName: string;
}

export default function TeacherPinManager({ personId, fullName }: TeacherPinManagerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [generatedPin, setGeneratedPin] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleReset = async () => {
    setIsPending(true);
    setErrorMsg(null);
    try {
      const res = await resetTeacherPinAction(personId);
      if (res.error) {
        setErrorMsg(res.error);
      } else if (res.success && res.newPin) {
        setGeneratedPin(res.newPin);
      }
    } catch (e: any) {
      setErrorMsg(e?.message || 'Failed to reset passcode');
    } finally {
      setIsPending(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setIsOpen(false);
    setGeneratedPin(null);
    setErrorMsg(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white hover:bg-[#f7f7f8] border border-[#e1e1e5] hover:border-[#cfcfd4] text-[#171719] text-[11px] font-medium rounded-[8px] transition cursor-pointer shadow-2xs"
        title="View or Reset Passcode"
      >
        <KeyRound className="w-3 h-3 text-[#007aff] shrink-0" />
        <span>Passcode</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#171719]/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-white border border-[#e7e7ea] rounded-[16px] max-w-md w-full p-6 space-y-4 shadow-2xl relative animate-fade-in">
            {/* Close button */}
            <button
              type="button"
              onClick={handleClose}
              className="absolute top-4 right-4 text-[#929297] hover:text-[#171719] p-1 rounded-lg transition"
            >
              <X className="w-4 h-4" />
            </button>

            {/* Header */}
            <div className="space-y-1 pr-6 border-b border-[#f1f1f4] pb-3">
              <div className="flex items-center gap-2 text-[#171719] text-base font-bold">
                <KeyRound className="w-4 h-4 text-[#007aff] shrink-0" />
                <span>Teacher Attendance Passcode</span>
              </div>
              <p className="text-xs text-[#85858a]">
                Faculty Member: <strong className="text-[#171719]">{fullName}</strong>
              </p>
            </div>

            {/* Content area */}
            {generatedPin ? (
              <div className="space-y-4 animate-fade-in">
                <div className="p-4 bg-[#edf5ff] border border-[#d6e7ff] rounded-xl space-y-3 text-center">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#007aff]">
                    New Attendance Passcode / PIN
                  </div>
                  
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <div className="font-mono text-2xl font-bold tracking-widest text-[#007aff] bg-white border border-[#d6e7ff] px-4 py-2 rounded-lg select-all shadow-2xs">
                      {generatedPin}
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(generatedPin)}
                      className="p-2.5 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-lg transition flex items-center justify-center cursor-pointer shadow-2xs"
                      title="Copy Passcode"
                    >
                      {copied ? <Check className="w-4 h-4 text-white" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-[#5e5e63] text-left leading-relaxed pt-1">
                    Share this unique passcode with <strong>{fullName}</strong>. They will use it to log into the kiosk terminal or manual register.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleClose}
                  className="w-full h-9 bg-[#171719] hover:bg-[#2c2c2e] text-white rounded-[9px] text-xs font-medium transition cursor-pointer"
                >
                  Done
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-[#5e5e63] leading-relaxed">
                  Passcodes are hashed securely in the database. If the teacher lost their passcode or requires a new one, you can generate a fresh unique PIN below.
                </p>

                {errorMsg && (
                  <div className="p-3 text-xs text-[#ef4444] bg-[#fff0ef] border border-[#fbd1cf] rounded-lg">
                    {errorMsg}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="h-9 px-3 border border-[#e1e1e5] hover:bg-[#f7f7f8] rounded-[8px] text-xs text-[#5e5e63] font-medium transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={isPending}
                    className="h-9 px-4 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-[8px] text-xs font-medium flex items-center gap-1.5 transition disabled:opacity-50 cursor-pointer shadow-2xs"
                  >
                    {isPending ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Generating...</span>
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Generate New PIN</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
