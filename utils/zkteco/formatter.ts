interface PersonInfo {
  full_name: string;
  role?: string | null;
  classes?: { name?: string | null } | null;
}

export interface LcdDisplayFormatOptions {
  prefixTeacher?: string;
  prefixAdmin?: string;
  prefixSupport?: string;
  showStudentClass?: boolean;
  maxChars?: number;
}

const DEFAULT_MAX_SCREEN_CHARS = 24; // typical ZKTeco name field / LCD width

/** Remove ADMS control characters (tab, CR, LF, NUL, '=') and tidy spaces. */
function clean(value: string): string {
  return value.replace(/[\t\r\n\0=]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Clean role prefix while keeping an intentional trailing single space when desired. */
function cleanPrefix(value: string, fallback: string): string {
  const safe = value.replace(/[\t\r\n\0=]/g, ' ').replace(/\s+/g, ' ');
  return safe.length <= 8 ? safe : fallback;
}

/** Cut to n characters without splitting an emoji / surrogate pair. */
function cut(value: string, n: number): string {
  const chars = Array.from(value);
  return chars.length <= n ? value : chars.slice(0, n).join('').trim();
}

const len = (value: string) => Array.from(value).length;

/**
 * Format person display name for ZKTeco Biometric LCD screens (limited character length)
 * respecting per-school configured staff prefixes and student class display toggle.
 */
export function formatZKTecoDisplayName(
  person: PersonInfo,
  options?: LcdDisplayFormatOptions
): string {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_SCREEN_CHARS;
  if (!person || !person.full_name || !clean(person.full_name)) {
    return 'User';
  }

  const rawName = clean(person.full_name);
  const role = (person.role || 'student').toLowerCase();
  const className = person.classes?.name ? clean(person.classes.name) : '';

  const pTeacher = cleanPrefix(options?.prefixTeacher ?? 'Tr. ', 'Tr. ');
  const pAdmin = cleanPrefix(options?.prefixAdmin ?? 'Adm. ', 'Adm. ');
  const pSupport = cleanPrefix(options?.prefixSupport ?? 'Stf. ', 'Stf. ');

  // Staff get a short role prefix, unless the name already carries it as a word
  // ("Tr. Jane", "Teacher Jane"), not merely as letters ("Stafford" is a name).
  const prefixes: Record<string, [string, RegExp]> = {
    teacher: [pTeacher, /^(tr\.|teacher\b)/i],
    support_staff: [pSupport, /^(stf\.|staff\b)/i],
    admin: [pAdmin, /^(adm\.|admin\b)/i],
  };
  const prefix = prefixes[role];
  if (prefix) {
    if (!prefix[0]) return cut(rawName, maxChars);
    const trimmedPrefix = prefix[0].trim();
    const startsWithCustomPrefix =
      trimmedPrefix.length > 0 &&
      rawName.toLowerCase().startsWith(trimmedPrefix.toLowerCase());
    return cut(
      startsWithCustomPrefix || prefix[1].test(rawName)
        ? rawName
        : prefix[0] + rawName,
      maxChars
    );
  }

  // Students: "Name (Class)" when enabled and fits. Otherwise the child's name wins:
  // the full name without the class, never a chopped name to make room for it.
  if (role === 'student' && className && (options?.showStudentClass ?? true)) {
    const withClass = `${rawName} (${className})`;
    if (len(withClass) <= maxChars) return withClass;
  }
  return cut(rawName, maxChars);
}
