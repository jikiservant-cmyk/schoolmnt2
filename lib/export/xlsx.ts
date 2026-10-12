import { strToU8, zipSync } from 'fflate';

export type SpreadsheetCell = string | number | boolean | null | undefined;

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * Excel and LibreOffice treat cells beginning with formula sigils as formulas,
 * even in a quoted CSV field. Attendance names, device IDs and phone numbers
 * are user-controlled, so prefix those values with an apostrophe before any
 * spreadsheet export (CSV or XLSX) to prevent formula injection.
 */
export function safeSpreadsheetText(value: SpreadsheetCell): string {
  const text = String(value ?? '').replace(INVALID_XML_CHARS, '');
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index: number): string {
  let result = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

/**
 * Build a small, standards-compliant XLSX workbook with literal inline-string
 * cells. The app only exports reports; it does not need a general-purpose XLSX
 * parser, so avoiding the vulnerable SheetJS parser substantially reduces the
 * browser attack surface and package supply-chain footprint.
 */
export function createReportXlsx(sheetName: string, inputRows: SpreadsheetCell[][]): Blob {
  const rows = inputRows.slice(0, 50_000);
  const sheetData = rows.map((row, rowIndex) => {
    const cells = row.slice(0, 100).map((value, columnIndex) => {
      const text = escapeXml(safeSpreadsheetText(value));
      return `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');

  const safeSheetName = escapeXml(sheetName.replace(/[\\/*?:\[\]]/g, '_').slice(0, 31) || 'Report');
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`),
  };

  return new Blob([zipSync(files, { level: 6 })], { type: XLSX_CONTENT_TYPE });
}
