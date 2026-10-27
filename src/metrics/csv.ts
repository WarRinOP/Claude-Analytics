// CSV writing (RFC 4180) shared by `cli.ts export` and the breakdown download of the API.

// A value that starts with one of these is read as a formula by spreadsheet programs, so text columns get a leading
// apostrophe. Numbers are never touched.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(value: string | number | boolean): string {
  let s = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Rows end with CRLF, as the RFC says, including the last one.
export function toCsv(header: string[], rows: Array<Array<string | number | boolean>>): string {
  const line = (cells: Array<string | number | boolean>): string => cells.map(csvField).join(',') + '\r\n';
  return line(header) + rows.map(line).join('');
}
