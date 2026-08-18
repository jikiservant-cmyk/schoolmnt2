interface PersonInfo {
  full_name: string;
  role?: string | null;
  classes?: { name?: string | null } | null;
}

/**
 * Format person display name for ZKTeco Biometric LCD screens (limited character length)
 * Example: "John Doe (P4)" or "Tr. Jane Smith"
 */
export function formatZKTecoDisplayName(person: PersonInfo): string {
  if (!person || !person.full_name) {
    return 'User';
  }

  const rawName = person.full_name.trim();
  const role = (person.role || 'student').toLowerCase();
  const className = person.classes?.name?.trim();

  let formatted = rawName;

  if (role === 'teacher') {
    if (!formatted.toLowerCase().startsWith('tr.') && !formatted.toLowerCase().startsWith('teacher')) {
      formatted = `Tr. ${formatted}`;
    }
  } else if (role === 'support_staff') {
    if (!formatted.toLowerCase().startsWith('stf.') && !formatted.toLowerCase().startsWith('staff')) {
      formatted = `Stf. ${formatted}`;
    }
  } else if (role === 'admin') {
    if (!formatted.toLowerCase().startsWith('adm.') && !formatted.toLowerCase().startsWith('admin')) {
      formatted = `Adm. ${formatted}`;
    }
  } else if (role === 'student' && className) {
    formatted = `${formatted} (${className})`;
  }

  // ZKTeco terminals usually have a 24-character display limit for names
  if (formatted.length > 24) {
    // If it has class at the end, keep the class
    if (className && formatted.endsWith(`(${className})`)) {
      const suffix = ` (${className})`;
      const maxNameLen = Math.max(8, 24 - suffix.length);
      formatted = `${rawName.substring(0, maxNameLen).trim()}${suffix}`;
    } else {
      formatted = formatted.substring(0, 24).trim();
    }
  }

  return formatted;
}
