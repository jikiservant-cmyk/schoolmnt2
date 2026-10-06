interface PersonInfo {
  full_name: string;
  role?: string | null;
  classes?: { name?: string | null } | null;
}

const MAX_SCREEN_CHARS = 24; // typical ZKTeco name field / LCD width

/** Remove ADMS control characters (tab, CR, LF, NUL, '=') and tidy spaces. */
function clean(value: string): string {
  return value.replace(/[\t\r\n\0=]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Cut to n characters without splitting an emoji / surrogate pair. */
function cut(value: string, n: number): string {
  const chars = Array.from(value);
  return chars.length <= n ? value : chars.slice(0, n).join('').trim();
}

const len = (value: string) => Array.from(value).length;

/**
 * Format person display name for ZKTeco Biometric LCD screens (limited character length)
 * Example: "John Doe (P4)" or "Tr. Jane Smith"
 */
export function formatZKTecoDisplayName(person: PersonInfo): string {
  if (!person || !person.full_name || !clean(person.full_name)) {
    return 'User';
  }

  const rawName = clean(person.full_name);
  const role = (person.role || 'student').toLowerCase();
  const className = person.classes?.name ? clean(person.classes.name) : '';

  // Staff get a short role prefix, unless the name already carries it as a word
  // ("Tr. Jane", "Teacher Jane"), not merely as letters ("Stafford" is a name).
  const prefixes: Record<string, [string, RegExp]> = {
    teacher: ['Tr. ', /^(tr\.|teacher\b)/i],
    support_staff: ['Stf. ', /^(stf\.|staff\b)/i],
    admin: ['Adm. ', /^(adm\.|admin\b)/i],
  };
  const prefix = prefixes[role];
  if (prefix) {
    return cut(prefix[1].test(rawName) ? rawName : prefix[0] + rawName, MAX_SCREEN_CHARS);
  }

  // Students: "Name (Class)" when it fits. Otherwise the child's name wins:
  // the full name without the class, never a chopped name to make room for it.
  if (role === 'student' && className) {
    const withClass = `${rawName} (${className})`;
    if (len(withClass) <= MAX_SCREEN_CHARS) return withClass;
  }
  return cut(rawName, MAX_SCREEN_CHARS);
}
