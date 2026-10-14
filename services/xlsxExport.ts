// Minimal .xlsx writer (SpreadsheetML in a zip) for admin reports.
//
// Why not CSV: Excel guesses the type of every CSV cell, so a score written "11/60" opens as the date
// "Nov-60" and a 12-digit phone number as "9.19E+11". Here every cell's type is stated: text stays
// text, and numbers are real numbers that sort and sum.

export type XlsxStyle = 'title' | 'header' | 'percent';

/** A string is written as text, a number as a number; null/undefined/'' leave the cell empty. */
export type XlsxValue = string | number | null | undefined;
export type XlsxCell = XlsxValue | { value: XlsxValue; style?: XlsxStyle };

export interface XlsxSheet {
  /** Tab name; trimmed to Excel's 31 characters and stripped of the characters it rejects. */
  name: string;
  rows: XlsxCell[][];
  /** 1-based row of the column headings: it is frozen while scrolling and carries the filter buttons. */
  headerRow?: number;
  /** Column widths in characters; columns without one are sized from their content. */
  widths?: number[];
}

const STYLE_INDEX: Record<XlsxStyle, number> = { header: 1, percent: 2, title: 3 };

const xmlEscape = (value: string): string => value
  // Control characters are not allowed in XML 1.0 at all; Excel refuses the whole file over one.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const columnName = (index: number): string => {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

const unpack = (cell: XlsxCell): { value: XlsxValue; style?: XlsxStyle } =>
  cell !== null && typeof cell === 'object' ? cell : { value: cell as XlsxValue };

const cellXml = (ref: string, cell: XlsxCell): string => {
  const { value, style } = unpack(cell);
  const s = style ? ` s="${STYLE_INDEX[style]}"` : '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : (s ? `<c r="${ref}"${s}/>` : '');
  }
  if (value === null || value === undefined || value === '') return s ? `<c r="${ref}"${s}/>` : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
};

const displayLength = (cell: XlsxCell): number => {
  const { value, style } = unpack(cell);
  if (value === null || value === undefined) return 0;
  if (style === 'percent' && typeof value === 'number') return 5;
  return String(value).length;
};

const sheetXml = (sheet: XlsxSheet): string => {
  const columnCount = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const headerRow = sheet.headerRow && sheet.headerRow <= sheet.rows.length ? sheet.headerRow : 0;
  const widths = Array.from({ length: columnCount }, (_, c) => {
    const given = sheet.widths?.[c];
    if (given) return given;
    // Title lines above the headings span the sheet; they must not stretch the first column.
    const longest = sheet.rows.reduce(
      (max, row, r) => (headerRow && r < headerRow - 1 ? max : Math.max(max, displayLength(row[c]))), 0,
    );
    return Math.min(60, Math.max(8, longest + 2));
  });

  const pane = headerRow
    ? `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`
    : '';
  const cols = columnCount
    ? `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const rows = sheet.rows.map((row, r) => {
    const cells = row.map((cell, c) => cellXml(`${columnName(c)}${r + 1}`, cell)).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const filter = headerRow && columnCount && sheet.rows.length > headerRow
    ? `<autoFilter ref="A${headerRow}:${columnName(columnCount - 1)}${sheet.rows.length}"/>`
    : '';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`
    + cols
    + `<sheetData>${rows}</sheetData>`
    + filter
    + '</worksheet>';
};

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="3">'
  + '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="13"/><name val="Calibri"/><family val="2"/></font>'
  + '</fonts>'
  + '<fills count="3">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
  // Built-in format 9 is "0%": the cell holds the exact fraction, Excel shows a whole percentage.
  + '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

const sheetName = (name: string, index: number, taken: Set<string>): string => {
  let base = name.replace(/[\[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${index + 1}`;
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const buildXlsxBytes = async (sheets: XlsxSheet[]): Promise<Uint8Array> => {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const taken = new Set<string>();
  const names = sheets.map((s, i) => sheetName(s.name, i, taken));

  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>');

  // Excel keeps each sheet's filter range in a hidden defined name; without it some versions drop the filter.
  const filterNames = sheets.map((sheet, i) => {
    const columnCount = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
    const headerRow = sheet.headerRow && sheet.headerRow <= sheet.rows.length ? sheet.headerRow : 0;
    if (!headerRow || !columnCount || sheet.rows.length <= headerRow) return '';
    const quoted = `'${xmlEscape(names[i]).replace(/'/g, "''")}'`;
    return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${quoted}!$A$${headerRow}:$${columnName(columnCount - 1)}$${sheet.rows.length}</definedName>`;
  }).join('');

  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<bookViews><workbookView/></bookViews>'
    + `<sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
    + (filterNames ? `<definedNames>${filterNames}</definedNames>` : '')
    + '</workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>');
  zip.file('xl/styles.xml', STYLES_XML);
  sheets.forEach((sheet, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)));

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
};

export const buildXlsx = async (sheets: XlsxSheet[]): Promise<Blob> =>
  new Blob([await buildXlsxBytes(sheets)], { type: XLSX_MIME });

export const downloadXlsx = async (filename: string, sheets: XlsxSheet[]): Promise<void> => {
  const blob = await buildXlsx(sheets);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
