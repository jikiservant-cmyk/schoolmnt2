/**
 * Zero-dependency spreadsheet & CSV builder (`lib/security/safe-spreadsheet.ts`).
 *
 * Replaces vulnerable `xlsx@0.18.5` (GHSA-4r6h-8v6p-xvw6 Prototype Pollution &
 * GHSA-5pgg-2g8v-p4x9 ReDoS) with a pure TypeScript ECMA-376 OpenXML `.xlsx`
 * (PKZIP STORE + inlineStr / numeric cells) and RFC 4180 `.csv` generator.
 *
 * Security protections:
 *  - Neutralizes CSV / Excel DDE & formula injection prefixes (`=`, `+`, `-`,
 *    `@`, `\t`, `\r`, including whitespace-prefixed formulas) by prefixing `'`.
 *  - Uses `Blob` + `URL.createObjectURL` downloads instead of `encodeURI('data:text/csv,...')`
 *    so cells or headers containing `#` (e.g. `Roll #`, `#1`) never truncate exports.
 */

export type SpreadsheetCell = string | number | boolean | null | undefined;

export interface SpreadsheetSheet {
  name: string;
  rows: SpreadsheetCell[][];
}

const FORMULA_INJECTION_RE = /^[=+\-@\t\r]|^[\s\u0000-\u001F]+[=+\-@]/;
const INVALID_XML_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * Neutralizes spreadsheet formula injection triggers (`=`, `+`, `-`, `@`, `\t`, `\r`).
 */
export function neutralizeFormulaInjection(raw: string): string {
  if (!raw) return '';
  if (FORMULA_INJECTION_RE.test(raw)) {
    return `'${raw}`;
  }
  return raw;
}

/**
 * Formats a single cell safely for RFC 4180 CSV export.
 */
export function formatSafeCsvCell(value: SpreadsheetCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  const safe = neutralizeFormulaInjection(String(value));
  // Quote every non-numeric string containing commas, quotes, newlines, tabs, `#`, or spaces,
  // or quote unconditionally for maximum spreadsheet parser compatibility.
  if (/[",\r\n\t#]/.test(safe) || safe.startsWith("'")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Builds a complete UTF-8 CSV string with formula neutralization.
 */
export function buildSafeCsv(rows: SpreadsheetCell[][]): string {
  return rows
    .map((row) => row.map((cell) => formatSafeCsvCell(cell)).join(','))
    .join('\r\n');
}

function escapeXml(str: string): string {
  return str
    .replace(INVALID_XML_CHARS_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Converts 0-based column index to Excel column letters (`0 -> A`, `25 -> Z`, `26 -> AA`). */
export function columnIndexToLetters(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function sanitizeSheetName(raw: string, index: number): string {
  const cleaned = (raw || '')
    .replace(INVALID_XML_CHARS_RE, '')
    .replace(/[/\\?*[\]:]/g, '_')
    .trim()
    .slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

function buildWorksheetXml(rows: SpreadsheetCell[][]): string {
  const rowXmlParts: string[] = [];
  let maxCols = 1;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    if (row.length > maxCols) maxCols = row.length;
    const rowNum = r + 1;
    const cellXmlParts: string[] = [];

    for (let c = 0; c < row.length; c++) {
      const val = row[c];
      if (val === null || val === undefined || val === '') continue;
      const ref = `${columnIndexToLetters(c)}${rowNum}`;

      if (typeof val === 'number' && Number.isFinite(val)) {
        cellXmlParts.push(`<c r="${ref}" t="n"><v>${val}</v></c>`);
      } else if (typeof val === 'boolean') {
        cellXmlParts.push(`<c r="${ref}" t="b"><v>${val ? 1 : 0}</v></c>`);
      } else {
        const safeText = escapeXml(neutralizeFormulaInjection(String(val)));
        cellXmlParts.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${safeText}</t></is></c>`);
      }
    }

    rowXmlParts.push(`<row r="${rowNum}">${cellXmlParts.join('')}</row>`);
  }

  const lastRow = Math.max(1, rows.length);
  const dimensionRef = `A1:${columnIndexToLetters(Math.max(0, maxCols - 1))}${lastRow}`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dimensionRef}"/>` +
    `<sheetData>${rowXmlParts.join('')}</sheetData>` +
    `</worksheet>`
  );
}

// Precomputed IEEE 802.3 CRC-32 lookup table
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntryInput {
  path: string;
  data: Uint8Array;
}

/**
 * Packs files into an uncompressed (`STORE`, method 0) standard PKZIP archive.
 */
function buildStoredZip(entries: ZipEntryInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const body = entry.data;
    const checksum = crc32(body);

    // Local file header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);  // signature PK\x03\x04
    lv.setUint16(4, 20, true);          // version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true);      // UTF-8 filename flag
    lv.setUint16(8, 0, true);           // compression method = 0 (STORE)
    lv.setUint16(10, 0, true);          // mod time
    lv.setUint16(12, 0x21, true);       // mod date (1980-01-01)
    lv.setUint32(14, checksum, true);   // CRC-32
    lv.setUint32(18, body.length, true);// compressed size
    lv.setUint32(22, body.length, true);// uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);          // extra length
    localHeader.set(nameBytes, 30);

    // Central directory header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);  // signature PK\x01\x02
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0x0800, true);      // UTF-8 flag
    cv.setUint16(10, 0, true);          // compression method = 0 (STORE)
    cv.setUint16(12, 0, true);          // mod time
    cv.setUint16(14, 0x21, true);       // mod date
    cv.setUint32(16, checksum, true);   // CRC-32
    cv.setUint32(20, body.length, true);// compressed size
    cv.setUint32(24, body.length, true);// uncompressed size
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);          // extra length
    cv.setUint16(32, 0, true);          // comment length
    cv.setUint16(34, 0, true);          // disk number start
    cv.setUint16(36, 0, true);          // internal file attributes
    cv.setUint32(38, 0, true);          // external file attributes
    cv.setUint32(42, offset, true);     // relative offset of local header
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, body);
    centralParts.push(centralHeader);
    offset += localHeader.length + body.length;
  }

  let centralSize = 0;
  for (const part of centralParts) centralSize += part.length;

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);      // signature PK\x05\x06
  ev.setUint16(4, 0, true);               // disk number
  ev.setUint16(6, 0, true);               // central dir start disk
  ev.setUint16(8, entries.length, true);  // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);    // size of central directory
  ev.setUint32(16, offset, true);         // offset of central directory
  ev.setUint16(20, 0, true);              // comment length

  const output = new Uint8Array(offset + centralSize + eocd.length);
  let cursor = 0;
  for (const part of localParts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  output.set(eocd, cursor);
  return output;
}

/**
 * Generates a valid ECMA-376 OpenXML `.xlsx` binary (`Uint8Array`) from one or more sheets.
 */
export function buildSafeXlsx(sheetsInput: SpreadsheetSheet[]): Uint8Array {
  const sheets = sheetsInput.length > 0 ? sheetsInput : [{ name: 'Sheet1', rows: [] }];
  const enc = new TextEncoder();

  // Deduplicate sanitized sheet names
  const usedNames = new Set<string>();
  const normalizedSheets = sheets.map((sheet, idx) => {
    let base = sanitizeSheetName(sheet.name, idx);
    if (usedNames.has(base.toLowerCase())) {
      const suffix = `_${idx + 1}`;
      base = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    }
    usedNames.add(base.toLowerCase());
    return { name: base, rows: sheet.rows };
  });

  const worksheetOverrides = normalizedSheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('');

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    worksheetOverrides +
    `</Types>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbookSheetsXml = normalizedSheets
    .map(
      (s, i) =>
        `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join('');

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${workbookSheetsXml}</sheets>` +
    `</workbook>`;

  const workbookRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    normalizedSheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join('') +
    `<Relationship Id="rId${normalizedSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
    `</styleSheet>`;

  const entries: ZipEntryInput[] = [
    { path: '[Content_Types].xml', data: enc.encode(contentTypesXml) },
    { path: '_rels/.rels', data: enc.encode(rootRelsXml) },
    { path: 'xl/workbook.xml', data: enc.encode(workbookXml) },
    { path: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRelsXml) },
    { path: 'xl/styles.xml', data: enc.encode(stylesXml) },
    ...normalizedSheets.map((s, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(buildWorksheetXml(s.rows)),
    })),
  ];

  return buildStoredZip(entries);
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const safeName = filename.replace(/[/\\:*?"<>|\u0000-\u001F]/g, '_');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Generates and downloads an Excel `.xlsx` file in the browser via `Blob` URL.
 */
export function downloadSafeXlsx(filename: string, sheets: SpreadsheetSheet[]): void {
  const bytes = buildSafeXlsx(sheets);
  const blob = new Blob([bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const finalName = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  triggerBlobDownload(blob, finalName);
}

/**
 * Generates and downloads a UTF-8 `.csv` file in the browser via `Blob` URL
 * (never truncated by `#`, `%`, or large row counts).
 */
export function downloadSafeCsv(filename: string, rows: SpreadsheetCell[][]): void {
  const csv = '\uFEFF' + buildSafeCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const finalName = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  triggerBlobDownload(blob, finalName);
}
