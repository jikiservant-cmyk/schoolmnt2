/**
 * Spreadsheet-output safety (CWE-1236, CSV / formula injection).
 *
 * Attendance exports contain values that this app does not fully control:
 * student and guardian names, phone numbers, class names and device enrollment
 * IDs. A value beginning with `=`, `+`, `-` or `@` is interpreted by Excel,
 * LibreOffice and Google Sheets as a FORMULA when the file is opened, which is
 * enough to exfiltrate other cells or, on older Excel builds, run DDE commands.
 * Quoting alone does not help: `"=cmd|'/c calc'!A0"` still evaluates.
 *
 * `csvCell` neutralises the payload (leading apostrophe, the standard
 * spreadsheet "treat as text" marker), strips CR/LF/NUL so a cell can never
 * break out into a new row, and applies RFC 4180 quoting.
 */

/** Anything that could start a formula, allowing for leading whitespace/controls. */
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]/;

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);

  // A cell must never be able to introduce a new record or terminate the file.
  text = text.replace(/[\r\n\u0000]+/g, ' ');

  // Prefix so spreadsheets store the value as text instead of evaluating it.
  if (FORMULA_START.test(text)) text = `'${text}`;

  return `"${text.replace(/"/g, '""')}"`;
}

/** One CSV record (no trailing newline). */
export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** A complete CSV document from a header row plus data rows. */
export function csvDocument(header: unknown[], rows: unknown[][]): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n');
}

/** `data:text/csv` URI for the browser download (encodeURIComponent keeps commas). */
export function csvDataUri(header: unknown[], rows: unknown[][]): string {
  return 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvDocument(header, rows));
}
