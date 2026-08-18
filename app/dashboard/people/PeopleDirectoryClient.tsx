'use client';

import React, { useState, useMemo, useTransition } from 'react';
import Link from 'next/link';
import { 
  Users, 
  Search, 
  Plus, 
  CheckCircle2, 
  XCircle, 
  Smartphone, 
  UserCheck, 
  GraduationCap, 
  Briefcase, 
  Shield, 
  X,
  Phone,
  Filter,
  Fingerprint,
  Edit2,
  Check,
  Loader2,
  AlertCircle
} from 'lucide-react';
import AddPersonForm from './AddPersonForm';
import TeacherPinManager from './TeacherPinManager';
import { updatePersonDeviceUserIdAction } from './actions';

interface SchoolClass {
  id: string;
  name: string;
}

interface Person {
  id: string;
  full_name: string;
  role: string;
  class_id?: string | null;
  device_user_id?: string | null;
  phone?: string | null;
  is_active?: boolean | null;
}

interface PeopleDirectoryClientProps {
  initialPeople: Person[];
  classes: SchoolClass[];
  initialRoleFilter?: string;
}

export default function PeopleDirectoryClient({
  initialPeople,
  classes,
  initialRoleFilter = 'all'
}: PeopleDirectoryClientProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>(initialRoleFilter);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [showAddModal, setShowAddModal] = useState(false);

  // Quick edit biometric UID modal
  const [editingPerson, setEditingPerson] = useState<Person | null>(null);
  const [newDeviceUid, setNewDeviceUid] = useState('');
  const [isPending, startTransition] = useTransition();
  const [uidError, setUidError] = useState<string | null>(null);
  const [uidSuccess, setUidSuccess] = useState<string | null>(null);

  const openEditUidModal = (person: Person) => {
    setEditingPerson(person);
    setNewDeviceUid(person.device_user_id || '');
    setUidError(null);
    setUidSuccess(null);
  };

  const handleSaveUid = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPerson) return;

    setUidError(null);
    setUidSuccess(null);

    startTransition(async () => {
      try {
        const res = await updatePersonDeviceUserIdAction(editingPerson.id, newDeviceUid);
        if (res && res.error) {
          setUidError(res.error);
        } else {
          setUidSuccess('Biometric Hardware UID updated and synced with terminal!');
          setTimeout(() => {
            setEditingPerson(null);
            setUidSuccess(null);
          }, 1200);
        }
      } catch (err: any) {
        setUidError(err.message || 'Failed to update UID.');
      }
    });
  };

  // Map class lookup
  const classMap = useMemo(() => {
    const map = new Map<string, string>();
    classes.forEach(c => map.set(c.id, c.name));
    return map;
  }, [classes]);

  // Counts
  const counts = useMemo(() => {
    const total = initialPeople.length;
    const students = initialPeople.filter(p => p.role === 'student').length;
    const teachers = initialPeople.filter(p => p.role === 'teacher').length;
    const supportStaff = initialPeople.filter(p => p.role === 'support_staff').length;
    const admins = initialPeople.filter(p => p.role === 'admin').length;
    const withBiometric = initialPeople.filter(p => !!p.device_user_id).length;
    return { total, students, teachers, supportStaff, admins, withBiometric };
  }, [initialPeople]);

  // Filtered people
  const filteredPeople = useMemo(() => {
    return initialPeople.filter(p => {
      // Role filter
      if (roleFilter !== 'all' && p.role !== roleFilter) {
        return false;
      }
      // Status filter
      if (statusFilter === 'active' && !p.is_active) return false;
      if (statusFilter === 'inactive' && p.is_active) return false;

      // Search query
      if (searchTerm.trim()) {
        const query = searchTerm.toLowerCase();
        const nameMatch = p.full_name?.toLowerCase().includes(query);
        const phoneMatch = p.phone?.toLowerCase().includes(query);
        const uidMatch = p.device_user_id?.toLowerCase().includes(query);
        const className = p.class_id ? classMap.get(p.class_id)?.toLowerCase() : '';
        const classMatch = className?.includes(query);

        return nameMatch || phoneMatch || uidMatch || classMatch;
      }

      return true;
    });
  }, [initialPeople, roleFilter, statusFilter, searchTerm, classMap]);

  return (
    <div className="space-y-6 pt-5 animate-fade-in">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-2 border-b border-[#e7e7ea]">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-[#929297] mb-1">
            PEOPLE & DIRECTORY
          </div>
          <h1 className="text-[22px] sm:text-[25px] font-bold tracking-tight text-[#171719] leading-tight">
            Students & Teachers
          </h1>
          <p className="text-[12px] text-[#85858a] mt-0.5">
            Manage student registrations, faculty passcodes, and hardware biometric enrollments.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="h-[34px] px-3.5 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-[9px] text-[11px] font-medium flex items-center gap-1.5 shadow-2xs transition cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Person</span>
          </button>
        </div>
      </div>

      {/* 3 Top Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[15px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex items-center justify-between">
          <div>
            <span className="text-[11px] text-[#85858a] font-medium block">Total Students</span>
            <b className="text-[24px] font-bold tracking-tight text-[#171719] leading-none mt-1 block">
              {counts.students.toLocaleString()}
            </b>
            <span className="text-[10px] text-[#30b357] font-medium mt-1 inline-block">
              Enrolled across {classes.length} streams
            </span>
          </div>
          <div className="w-10 h-10 rounded-[10px] bg-[#edf5ff] text-[#007aff] grid place-items-center text-sm font-semibold">
            ♙
          </div>
        </div>

        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[15px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex items-center justify-between">
          <div>
            <span className="text-[11px] text-[#85858a] font-medium block">Faculty & Staff</span>
            <b className="text-[24px] font-bold tracking-tight text-[#171719] leading-none mt-1 block">
              {counts.teachers.toLocaleString()}
            </b>
            <span className="text-[10px] text-[#85858a] mt-1 inline-block">
              Passcodes & manual registers
            </span>
          </div>
          <div className="w-10 h-10 rounded-[10px] bg-[#edf9f0] text-[#30b357] grid place-items-center text-sm font-semibold">
            ♧
          </div>
        </div>

        <div className="bg-white border border-[#e7e7ea] rounded-[13px] p-[15px_18px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex items-center justify-between">
          <div>
            <span className="text-[11px] text-[#85858a] font-medium block">Biometric Enrolled</span>
            <b className="text-[24px] font-bold tracking-tight text-[#171719] leading-none mt-1 block">
              {counts.withBiometric.toLocaleString()}
            </b>
            <span className="text-[10px] text-[#007aff] font-medium mt-1 inline-block">
              Linked to ZKTeco terminals
            </span>
          </div>
          <div className="w-10 h-10 rounded-[10px] bg-[#fff5e7] text-[#f5a30a] grid place-items-center text-sm font-semibold">
            ▤
          </div>
        </div>
      </div>

      {/* Main Directory Card with Full-Width Table */}
      <div className="bg-white border border-[#e7e7ea] rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] overflow-hidden">
        
        {/* Controls Toolbar: Search & Filter Tabs */}
        <div className="p-4 sm:p-5 border-b border-[#f1f1f4] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          
          {/* Role Pill Filters */}
          <div className="flex flex-wrap items-center gap-1.5 bg-[#f5f5f7] p-1 rounded-[10px] border border-[#e7e7ea]">
            <button
              type="button"
              onClick={() => setRoleFilter('all')}
              className={`px-3 py-1.5 rounded-[7px] text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                roleFilter === 'all'
                  ? 'bg-white text-[#171719] shadow-2xs font-semibold'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <span>All</span>
              <span className="text-[10px] opacity-70">({counts.total})</span>
            </button>

            <button
              type="button"
              onClick={() => setRoleFilter('student')}
              className={`px-3 py-1.5 rounded-[7px] text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                roleFilter === 'student'
                  ? 'bg-white text-[#007aff] shadow-2xs font-semibold'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <span>Students</span>
              <span className="text-[10px] opacity-70">({counts.students})</span>
            </button>

            <button
              type="button"
              onClick={() => setRoleFilter('teacher')}
              className={`px-3 py-1.5 rounded-[7px] text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                roleFilter === 'teacher'
                  ? 'bg-white text-[#30b357] shadow-2xs font-semibold'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <span>Teachers</span>
              <span className="text-[10px] opacity-70">({counts.teachers})</span>
            </button>

            <button
              type="button"
              onClick={() => setRoleFilter('support_staff')}
              className={`px-3 py-1.5 rounded-[7px] text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                roleFilter === 'support_staff'
                  ? 'bg-white text-[#7c3aed] shadow-2xs font-semibold'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <span>Support Staff</span>
              <span className="text-[10px] opacity-70">({counts.supportStaff})</span>
            </button>

            <button
              type="button"
              onClick={() => setRoleFilter('admin')}
              className={`px-3 py-1.5 rounded-[7px] text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                roleFilter === 'admin'
                  ? 'bg-white text-[#171719] shadow-2xs font-semibold'
                  : 'text-[#85858a] hover:text-[#171719]'
              }`}
            >
              <span>Admins</span>
              <span className="text-[10px] opacity-70">({counts.admins})</span>
            </button>
          </div>

          {/* Search Box & Quick Status Filter */}
          <div className="flex items-center gap-2.5 w-full lg:w-auto">
            <div className="relative flex-1 lg:w-72">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#929297]" />
              <input
                type="text"
                placeholder="Search by name, phone, UID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-9 pl-8 pr-3 bg-[#fafafa] focus:bg-white border border-[#e1e1e5] rounded-[9px] text-xs text-[#171719] placeholder:text-[#96969b] focus:outline-none focus:border-[#007aff] transition"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#929297] hover:text-[#171719]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="h-9 px-2.5 bg-[#fafafa] border border-[#e1e1e5] rounded-[9px] text-xs text-[#5e5e63] focus:outline-none focus:border-[#007aff]"
            >
              <option value="all">All Status</option>
              <option value="active">Active Only</option>
              <option value="inactive">Inactive Only</option>
            </select>
          </div>

        </div>

        {/* Spacious Table Container with Independent Horizontal Scrolling */}
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#fafafa] border-b border-[#f1f1f4] text-[10px] uppercase font-semibold tracking-wider text-[#929297]">
                <th className="py-3 px-5 whitespace-nowrap">Person</th>
                <th className="py-3 px-4 whitespace-nowrap">Role</th>
                <th className="py-3 px-4 whitespace-nowrap">Class / Stream</th>
                <th className="py-3 px-4 whitespace-nowrap text-center">Hardware UID</th>
                <th className="py-3 px-4 whitespace-nowrap">Contact Phone</th>
                <th className="py-3 px-4 whitespace-nowrap text-center">Status</th>
                <th className="py-3 px-5 whitespace-nowrap text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f7f7f9]">
              {filteredPeople.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-xs text-[#929297]">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <div className="w-10 h-10 rounded-full bg-[#f4f4f6] text-[#929297] grid place-items-center text-base">
                        ⌕
                      </div>
                      <p className="font-medium text-[#171719]">No matching people found</p>
                      <p className="text-[11px] text-[#85858a]">
                        Try adjusting your search terms or role filters.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredPeople.map((person) => {
                  const assignedClass = person.class_id ? classMap.get(person.class_id) : null;
                  const initials = person.full_name
                    ? person.full_name
                        .split(' ')
                        .map(n => n[0])
                        .join('')
                        .substring(0, 2)
                        .toUpperCase()
                    : 'U';

                  return (
                    <tr key={person.id} className="hover:bg-[#fbfbfd] transition">
                      
                      {/* Person Name & Avatar */}
                      <td className="py-3.5 px-5 whitespace-nowrap">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full grid place-items-center text-[10px] font-bold shrink-0 ${
                            person.role === 'teacher'
                              ? 'bg-[#edf9f0] text-[#30b357]'
                              : person.role === 'support_staff'
                              ? 'bg-[#f4f0ff] text-[#7c3aed]'
                              : person.role === 'admin'
                              ? 'bg-[#edf5ff] text-[#007aff]'
                              : 'bg-[#f0f0f3] text-[#555]'
                          }`}>
                            {initials}
                          </div>
                          <div>
                            <div className="font-semibold text-[#171719] text-xs">
                              {person.full_name}
                            </div>
                            <div className="text-[10px] text-[#929297] capitalize">
                              {person.role === 'support_staff' ? 'Support Staff' : person.role}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Academic Role */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-medium ${
                          person.role === 'student'
                            ? 'bg-[#f4f4f6] text-[#5e5e63]'
                            : person.role === 'teacher'
                            ? 'bg-[#edf9f0] text-[#2da94f]'
                            : person.role === 'support_staff'
                            ? 'bg-[#f4f0ff] text-[#7c3aed]'
                            : 'bg-[#edf5ff] text-[#007aff]'
                        }`}>
                          <span>
                            {person.role === 'student'
                              ? '♙ Student'
                              : person.role === 'teacher'
                              ? '♧ Faculty'
                              : person.role === 'support_staff'
                              ? '⛑ Support Staff'
                              : '✦ Admin'}
                          </span>
                        </span>
                      </td>

                      {/* Class Scope */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {person.role === 'student' ? (
                          assignedClass ? (
                            <span className="font-medium text-[#171719] bg-[#f7f7f9] border border-[#e7e7ea] px-2 py-0.5 rounded-md text-[11px]">
                              {assignedClass}
                            </span>
                          ) : (
                            <span className="text-[#929297] text-[11px] italic">Unassigned</span>
                          )
                        ) : person.role === 'support_staff' ? (
                          <span className="text-[#5e5e63] text-[11px]">School Operations</span>
                        ) : (
                          <span className="text-[#5e5e63] text-[11px]">All School Classes</span>
                        )}
                      </td>

                      {/* Device UID */}
                      <td className="py-3.5 px-4 whitespace-nowrap text-center">
                        <div className="inline-flex items-center gap-1.5 justify-center">
                          {person.device_user_id ? (
                            <button
                              type="button"
                              onClick={() => openEditUidModal(person)}
                              className="group font-mono text-[11px] font-medium bg-[#fafafa] hover:bg-[#edf5ff] border border-[#e7e7ea] hover:border-[#007aff]/40 px-2 py-0.5 rounded text-[#171719] transition flex items-center gap-1 cursor-pointer"
                              title="Click to edit Biometric UID"
                            >
                              <span>{person.device_user_id}</span>
                              <Edit2 className="w-2.5 h-2.5 text-[#929297] group-hover:text-[#007aff]" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openEditUidModal(person)}
                              className="text-[10px] text-[#007aff] hover:text-[#0062cc] bg-[#edf5ff] hover:bg-[#dbeafe] px-2 py-0.5 rounded font-medium transition cursor-pointer flex items-center gap-1"
                              title="Assign Biometric Device UID"
                            >
                              <Fingerprint className="w-2.5 h-2.5" />
                              <span>Assign UID</span>
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Contact Phone */}
                      <td className="py-3.5 px-4 whitespace-nowrap text-[#5e5e63]">
                        {person.phone ? (
                          <span className="font-mono text-[11px] text-[#171719]">
                            {person.phone}
                          </span>
                        ) : (
                          <span className="text-[#b4b4b8] text-[11px]">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3.5 px-4 whitespace-nowrap text-center">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-medium ${
                          person.is_active
                            ? 'bg-[#edf9f0] text-[#2da94f]'
                            : 'bg-[#fff0ef] text-[#eb453c]'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            person.is_active ? 'bg-[#30b357]' : 'bg-[#ef4444]'
                          }`} />
                          <span>{person.is_active ? 'Active' : 'Inactive'}</span>
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-5 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEditUidModal(person)}
                            className="p-1.5 text-[#85858a] hover:text-[#007aff] hover:bg-[#f0f0f3] rounded-md transition cursor-pointer"
                            title="Edit Biometric Hardware UID"
                          >
                            <Fingerprint className="w-3.5 h-3.5" />
                          </button>
                          {person.role === 'teacher' && (
                            <TeacherPinManager personId={person.id} fullName={person.full_name} />
                          )}
                        </div>
                      </td>

                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Table Footer */}
        <div className="p-3.5 bg-[#fafafa] border-t border-[#f1f1f4] flex items-center justify-between text-xs text-[#85858a]">
          <div>
            Showing <strong className="text-[#171719]">{filteredPeople.length}</strong> of{' '}
            <strong className="text-[#171719]">{initialPeople.length}</strong> registered persons
          </div>
          <div className="text-[11px] text-[#929297]">
            Scroll horizontally to view all attributes
          </div>
        </div>

      </div>

      {/* Edit Biometric UID Modal */}
      {editingPerson && (
        <div className="fixed inset-0 z-50 bg-[#171719]/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-[#e7e7ea] rounded-[16px] max-w-md w-full p-6 shadow-xl animate-fade-in space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#f1f1f4]">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-full bg-[#edf5ff] text-[#007aff] flex items-center justify-center">
                  <Fingerprint className="w-4.5 h-4.5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#171719]">Biometric Hardware UID</h3>
                  <p className="text-[11px] text-[#85858a]">Link ZKTeco terminal PIN / Device User ID</p>
                </div>
              </div>
              <button 
                onClick={() => {
                  setEditingPerson(null);
                  setUidError(null);
                  setUidSuccess(null);
                }} 
                className="p-1 text-[#929297] hover:text-[#171719]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-[#f7f7f9] p-3 rounded-[10px] border border-[#e7e7ea] space-y-1">
              <div className="text-[10px] uppercase font-semibold tracking-wider text-[#929297]">
                Target Member
              </div>
              <div className="text-xs font-bold text-[#171719] flex items-center gap-2">
                <span>{editingPerson.full_name}</span>
                <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-[#edf5ff] text-[#007aff]">
                  {editingPerson.role}
                </span>
              </div>
            </div>

            {uidError && (
              <div className="p-3 text-xs text-[#ef4444] bg-[#fff0ef] rounded-[9px] border border-[#fbd1cf] flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{uidError}</span>
              </div>
            )}

            {uidSuccess && (
              <div className="p-3 text-xs text-[#2da94f] bg-[#edf9f0] rounded-[9px] border border-[#d2f4d9] flex items-center gap-2">
                <Check className="w-4 h-4 shrink-0" />
                <span>{uidSuccess}</span>
              </div>
            )}

            <form onSubmit={handleSaveUid} className="space-y-4">
              <div>
                <label className="block text-[11px] font-semibold text-[#171719] mb-1.5">
                  Device Hardware UID / PIN
                </label>
                <input
                  type="text"
                  placeholder="e.g. 101 or 1012 or 90745"
                  value={newDeviceUid}
                  onChange={(e) => setNewDeviceUid(e.target.value)}
                  disabled={isPending}
                  className="w-full h-10 px-3 bg-white border border-[#e1e1e5] text-xs font-mono rounded-[9px] focus:outline-none focus:border-[#007aff] transition text-[#171719] placeholder:text-[#96969b]"
                />
                <p className="text-[11px] text-[#85858a] mt-1.5 leading-relaxed">
                  Enter the exact User ID / PIN configured on the biometric terminal for this teacher or student. When they scan their fingerprint or enter this PIN, their attendance will be captured into <strong>school.attendance_logs</strong> automatically.
                </p>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingPerson(null)}
                  disabled={isPending}
                  className="h-9 px-3.5 border border-[#e1e1e5] hover:bg-[#f7f7f8] rounded-[9px] text-xs text-[#5e5e63] font-medium transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="h-9 px-4 bg-[#007aff] hover:bg-[#0062cc] text-white rounded-[9px] text-xs font-medium transition flex items-center gap-1.5 cursor-pointer shadow-2xs disabled:opacity-60"
                >
                  {isPending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Syncing...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Save & Sync UID</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Person Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-[#171719]/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-lg w-full animate-fade-in max-h-[90vh] overflow-y-auto">
            <AddPersonForm 
              classes={classes} 
              onClose={() => setShowAddModal(false)} 
            />
          </div>
        </div>
      )}

    </div>
  );
}
