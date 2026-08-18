'use client';

import { useState, useTransition } from 'react';
import { addPersonAction } from './actions';
import { Plus, HelpCircle, Check, Copy, AlertTriangle, ArrowRight, X, UserPlus, Loader2 } from 'lucide-react';

interface SchoolClass {
  id: string;
  name: string;
}

interface AddPersonFormProps {
  classes: SchoolClass[];
  onClose?: () => void;
}

export default function AddPersonForm({ classes, onClose }: AddPersonFormProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  
  const [successData, setSuccessData] = useState<{
    role: 'student' | 'teacher' | 'support_staff';
    fullName: string;
    guardianLinked?: boolean;
    manualLinkToken?: string;
    manualLinkExpiresAt?: string;
    teacherPin?: string | null;
  } | null>(null);

  const [selectedRole, setSelectedRole] = useState<string>('student');
  const [selectedTeacherClasses, setSelectedTeacherClasses] = useState<string[]>([]);
  const [copied, setCopied] = useState<boolean>(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccessData(null);

    const form = e.currentTarget;
    const formData = new FormData(form);

    startTransition(async () => {
      try {
        const res = await addPersonAction(formData);
        if (res && res.error) {
          setError(res.error);
        } else if (res && res.success) {
          const resData = res.data as any;
          
          setSuccessData({
            role: selectedRole as 'student' | 'teacher' | 'support_staff',
            fullName: formData.get('fullName') as string,
            guardianLinked: resData?.guardian_linked,
            manualLinkToken: resData?.manual_link_token,
            manualLinkExpiresAt: resData?.manual_link_expires_at,
            teacherPin: res?.teacherPin,
          });

          form.reset();
          setSelectedTeacherClasses([]);
        }
      } catch (err: any) {
        setError(err?.message || 'A network error occurred. Please try again.');
      }
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Render detailed success panel if registered
  if (successData) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const manualLink = successData.manualLinkToken 
      ? `${origin}/mark/${successData.manualLinkToken}` 
      : '';

    return (
      <div className="bg-white border border-[#e7e7ea] rounded-[16px] p-6 animate-fade-in space-y-5">
        <div className="flex items-center justify-between pb-3 border-b border-[#f1f1f4]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-[#edf9f0] border border-[#d2f4d9] flex items-center justify-center text-[#30b357]">
              <Check className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[#171719]">
                Registration Complete
              </h3>
              <p className="text-[11px] text-[#85858a]">
                Profile successfully added to school registry
              </p>
            </div>
          </div>
          {onClose && (
            <button onClick={onClose} className="p-1 text-[#929297] hover:text-[#171719]">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-[#f7f7f9] border border-[#e7e7ea] rounded-[12px] p-4 space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#929297]">
              Registered Profile
            </div>
            <div className="text-base font-bold text-[#171719]">
              {successData.fullName}
            </div>
            <div className="inline-flex text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#edf5ff] text-[#007aff]">
              {successData.role === 'support_staff' ? 'Support Staff' : successData.role}
            </div>
          </div>

          {/* Student Specific Details */}
          {successData.role === 'student' && (
            <div className="space-y-3">
              {successData.guardianLinked ? (
                <div className="p-3 text-xs bg-[#edf9f0] border border-[#d2f4d9] text-[#2da94f] rounded-[10px] flex items-center gap-2">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>Guardian linked! Daily attendance SMS notifications configured.</span>
                </div>
              ) : (
                <div className="p-3 text-xs bg-[#fff5e7] border border-[#ffe0b2] text-[#e99500] rounded-[10px] flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>No guardian phone provided — SMS alerts won&apos;t be routed.</span>
                </div>
              )}
            </div>
          )}

          {/* Support Staff Specific Details */}
          {successData.role === 'support_staff' && (
            <div className="p-3 text-xs bg-[#edf9f0] border border-[#d2f4d9] text-[#2da94f] rounded-[10px] flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0" />
              <span>Support staff member enrolled successfully in the staff directory.</span>
            </div>
          )}

          {/* Teacher Specific Details (PIN display + Link) */}
          {successData.role === 'teacher' && (
            <div className="space-y-4 animate-fade-in">
              {successData.teacherPin && (
                <div className="p-4 bg-[#edf5ff] border border-[#d6e7ff] rounded-[12px] space-y-2 text-center">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#007aff]">
                    Auto-Generated Attendance Passcode / PIN
                  </div>
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <div className="font-mono text-2xl font-bold tracking-widest text-[#007aff] bg-white border border-[#d6e7ff] px-4 py-2 rounded-lg select-all shadow-2xs">
                      {successData.teacherPin}
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(successData.teacherPin!)}
                      className="p-2.5 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-lg transition flex items-center justify-center cursor-pointer shadow-2xs"
                      title="Copy Passcode"
                    >
                      {copied ? <Check className="w-4 h-4 text-white" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-[#5e5e63] text-left leading-relaxed pt-1">
                    Give this passcode to <strong>{successData.fullName}</strong>. They will use it to log into the kiosk terminal or manual register.
                  </p>
                </div>
              )}

              {manualLink && (
                <div className="p-3 text-xs bg-[#f7f7f9] border border-[#e7e7ea] text-[#5e5e63] rounded-[10px] space-y-2">
                  <div className="font-semibold text-[#171719] flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-[#007aff]" />
                    Direct Attendance Token Link
                  </div>
                  <div className="flex gap-1.5 mt-2">
                    <input
                      type="text"
                      readOnly
                      value={manualLink}
                      className="w-full bg-white border border-[#e1e1e5] text-[11px] px-2.5 py-1.5 rounded-lg text-[#171719] truncate focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => copyToClipboard(manualLink)}
                      className="px-3 py-1.5 bg-[#007aff] hover:bg-[#0062cc] text-white text-xs font-medium rounded-lg transition flex items-center gap-1 cursor-pointer"
                    >
                      {copied ? 'Copied' : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-2">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-9 border border-[#e1e1e5] hover:bg-[#f7f7f8] rounded-[9px] text-xs font-medium text-[#5e5e63] transition"
            >
              Close
            </button>
          )}
          <button
            type="button"
            onClick={() => setSuccessData(null)}
            className="flex-1 h-9 bg-[#171719] hover:bg-[#2c2c2e] text-white rounded-[9px] text-xs font-medium transition flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
          >
            <span>Register Another</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-[#e7e7ea] rounded-[16px] p-6 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      <div className="flex items-center justify-between pb-3 border-b border-[#f1f1f4] mb-4">
        <div>
          <h3 className="text-base font-bold text-[#171719]">
            Register Person
          </h3>
          <p className="text-[11px] text-[#85858a] mt-0.5">
            Add a new student, teacher, or support staff member to the school directory
          </p>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1 text-[#929297] hover:text-[#171719]">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 mb-4 text-xs text-[#ef4444] bg-[#fff0ef] rounded-[9px] border border-[#fbd1cf] animate-fade-in">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        
        {/* Full Name */}
        <div>
          <label htmlFor="fullName" className="block text-[11px] font-semibold text-[#171719] mb-1.5">
            Full Name
          </label>
          <input
            id="fullName"
            name="fullName"
            type="text"
            required
            placeholder="e.g. Sandra Nakasenge"
            disabled={isPending}
            className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs rounded-[9px] focus:outline-none focus:border-[#007aff] transition disabled:opacity-50 text-[#171719] placeholder:text-[#96969b]"
          />
        </div>

        {/* Role Selector */}
        <div>
          <label htmlFor="role" className="block text-[11px] font-semibold text-[#171719] mb-1.5">
            Academic / Staff Role
          </label>
          <select
            id="role"
            name="role"
            required
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            disabled={isPending}
            className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs rounded-[9px] focus:outline-none focus:border-[#007aff] transition disabled:opacity-50 text-[#171719]"
          >
            <option value="student">Student</option>
            <option value="teacher">Teacher / Faculty</option>
            <option value="support_staff">Support Staff</option>
          </select>
        </div>

        {/* Class Selector - only show if student */}
        {selectedRole === 'student' && (
          <div className="animate-fade-in">
            <label htmlFor="classId" className="block text-[11px] font-semibold text-[#171719] mb-1.5">
              Class Assignment
            </label>
            <select
              id="classId"
              name="classId"
              required
              disabled={isPending}
              className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs rounded-[9px] focus:outline-none focus:border-[#007aff] transition disabled:opacity-50 text-[#171719]"
            >
              <option value="">-- Select Class Stream --</option>
              {classes.map((cls) => (
                <option key={cls.id} value={cls.id}>
                  {cls.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Biometric Hardware Device User ID */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="deviceUserId" className="text-[11px] font-semibold text-[#171719]">
              Device Hardware UID
            </label>
            <span className="text-[10px] text-[#929297]">Optional (ZKTeco ID)</span>
          </div>
          <input
            id="deviceUserId"
            name="deviceUserId"
            type="text"
            placeholder="e.g. 101 or 1002"
            disabled={isPending}
            className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs font-mono rounded-[9px] focus:outline-none focus:border-[#007aff] transition disabled:opacity-50 text-[#171719] placeholder:text-[#96969b]"
          />
        </div>

        {/* Student Guardian Details */}
        {selectedRole === 'student' && (
          <div className="space-y-3.5 border-t border-[#f1f1f4] pt-4 animate-fade-in">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[#007aff]">
              Guardian Details (For SMS Alerts)
            </h4>
            
            <div>
              <label htmlFor="guardianName" className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                Guardian Full Name
              </label>
              <input
                id="guardianName"
                name="guardianName"
                type="text"
                placeholder="e.g. David Namubiru"
                disabled={isPending}
                className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs rounded-[9px] focus:outline-none focus:border-[#007aff] transition disabled:opacity-50 text-[#171719] placeholder:text-[#96969b]"
              />
            </div>

            <div>
              <label htmlFor="guardianPhone" className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                Guardian Phone Number
              </label>
              <input
                id="guardianPhone"
                name="guardianPhone"
                type="tel"
                placeholder="e.g. +25677000000"
                disabled={isPending}
                className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs rounded-[9px] focus:outline-none focus:border-[#007aff] transition disabled:opacity-50 text-[#171719] placeholder:text-[#96969b]"
              />
            </div>

            <div>
              <label htmlFor="guardianRelationship" className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                Relationship
              </label>
              <select
                id="guardianRelationship"
                name="guardianRelationship"
                disabled={isPending}
                className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs rounded-[9px] focus:outline-none focus:border-[#007aff] transition disabled:opacity-50 text-[#171719]"
              >
                <option value="guardian">Guardian</option>
                <option value="father">Father</option>
                <option value="mother">Mother</option>
              </select>
            </div>
          </div>
        )}

        {/* Support Staff Details */}
        {selectedRole === 'support_staff' && (
          <div className="space-y-3.5 border-t border-[#f1f1f4] pt-4 animate-fade-in">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[#007aff]">
              Support Staff Contact Details
            </h4>

            <div>
              <label htmlFor="phone" className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                Phone Number
              </label>
              <input
                id="phone"
                name="phone"
                type="tel"
                placeholder="e.g. +25677000000"
                disabled={isPending}
                className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs rounded-[9px] focus:outline-none focus:border-[#007aff] transition disabled:opacity-50 text-[#171719] placeholder:text-[#96969b]"
              />
              <p className="text-[10px] text-[#85858a] mt-1">
                Used for direct school communications and staff records.
              </p>
            </div>
          </div>
        )}

        {/* Teacher Details */}
        {selectedRole === 'teacher' && (
          <div className="space-y-3.5 border-t border-[#f1f1f4] pt-4 animate-fade-in">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[#007aff]">
              Teacher Credentials
            </h4>

            <div>
              <label htmlFor="phone" className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                SMS Notification Phone
              </label>
              <input
                id="phone"
                name="phone"
                type="tel"
                placeholder="e.g. +25677000000"
                disabled={isPending}
                className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs rounded-[9px] focus:outline-none focus:border-[#007aff] transition disabled:opacity-50 text-[#171719] placeholder:text-[#96969b]"
              />
            </div>

            {/* Teacher Authorized Classes */}
            <div className="space-y-2">
              <label className="block text-[11px] font-semibold text-[#171719]">
                Authorized Classes
              </label>
              {classes.length === 0 ? (
                <p className="text-xs text-[#85858a] italic">No classes found in school.</p>
              ) : (
                <div className="max-h-36 overflow-y-auto border border-[#e1e1e5] bg-[#fafafa] rounded-[9px] p-2.5 space-y-2">
                  {classes.map((cls) => (
                    <label key={cls.id} className="flex items-center gap-2 text-xs text-[#171719] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={selectedTeacherClasses.includes(cls.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedTeacherClasses(prev => [...prev, cls.id]);
                          } else {
                            setSelectedTeacherClasses(prev => prev.filter(id => id !== cls.id));
                          }
                        }}
                        className="rounded border-[#e1e1e5] text-[#007aff] focus:ring-[#007aff]"
                      />
                      <span>{cls.name}</span>
                    </label>
                  ))}
                </div>
              )}
              <input type="hidden" name="classIdsJson" value={JSON.stringify(selectedTeacherClasses)} />
            </div>
          </div>
        )}

        <div className="pt-2 flex items-center justify-end gap-2">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-3.5 border border-[#e1e1e5] hover:bg-[#f7f7f8] rounded-[9px] text-xs text-[#5e5e63] font-medium transition cursor-pointer"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={isPending}
            className="flex-1 sm:flex-none h-10 px-4 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-[9px] text-xs font-medium transition disabled:opacity-60 flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
          >
            {isPending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Saving...</span>
              </>
            ) : (
              <>
                <Plus className="w-3.5 h-3.5" />
                <span>Register Person</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
