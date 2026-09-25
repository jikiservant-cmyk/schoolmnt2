import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCsvContent, escapeCsvCell } from '../lib/csv.ts';

test('CSV cells quote delimiters and embedded quotes', () => {
  assert.equal(escapeCsvCell('Ada, "Ace"'), '"Ada, ""Ace"""');
});

test('CSV cells neutralize spreadsheet formulas, including after whitespace', () => {
  for (const value of ['=1+1', '+SUM(A1:A2)', '-2+3', '@SUM(A1:A2)', '\t=1+1']) {
    assert.equal(escapeCsvCell(value).startsWith('"\''), true, `${JSON.stringify(value)} should be forced to text`);
  }
});

test('CSV output separates escaped cells with CRLF', () => {
  assert.equal(
    buildCsvContent(['Name', 'Count'], [['A, B', 3], ['=cmd', 4]]),
    '"Name","Count"\r\n"A, B","3"\r\n"\'=cmd","4"',
  );
});
