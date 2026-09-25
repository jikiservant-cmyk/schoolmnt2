/** Quote one CSV value and neutralize spreadsheet formula prefixes. */
export function escapeCsvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsvContent(headers: string[], rows: readonly unknown[][]): string {
  return [headers, ...rows].map(row => row.map(escapeCsvCell).join(',')).join('\r\n');
}
