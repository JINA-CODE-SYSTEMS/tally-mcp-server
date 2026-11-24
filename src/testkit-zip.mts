// Test helper (not a test file): a minimal zip writer, to build .xlsx fixtures inside tests.
//
// Tests run from dist/ and tsc copies no binary fixtures there, so workbooks are generated on the fly.
// Stored (method 0) and deflated (method 8) entries, so the reader's two decompression paths are both hit.

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: Array<{ name: string; data: string | Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.store ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A small .xlsx: sheets of rows, where a cell is a string (shared string), a number, a boolean, null, or
 * { inline: string } / { formulaString: string } / { rich: string[] } to exercise the other cell types.
 */
export type FixtureCell = string | number | boolean | null | { inline: string } | { formulaString: string } | { rich: string[] };

export function buildXlsx(sheets: Array<{ name: string; rows: FixtureCell[][] }>, opts: { date1904?: boolean; store?: boolean } = {}): Buffer {
  const shared: string[] = [];
  const sharedXml: string[] = [];
  const sIndex = (s: string, xml?: string) => { shared.push(s); sharedXml.push(xml ?? `<si><t xml:space="preserve">${esc(s)}</t></si>`); return shared.length - 1; };
  const colName = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheetXml = (rows: FixtureCell[][]) => {
    const body = rows.map((row, r) => {
      const cells = row.map((v, c) => {
        const ref = `${colName(c)}${r + 1}`;
        if (v === null) return '';
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
        if (typeof v === 'string') return `<c r="${ref}" t="s"><v>${sIndex(v)}</v></c>`;
        if ('inline' in v) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v.inline)}</t></is></c>`;
        if ('formulaString' in v) return `<c r="${ref}" t="str"><f>A1</f><v>${esc(v.formulaString)}</v></c>`;
        return `<c r="${ref}" t="s"><v>${sIndex(v.rich.join(''), `<si>${v.rich.map((t, k) => `<r>${k ? '<rPr><b/></rPr>' : ''}<t xml:space="preserve">${esc(t)}</t></r>`).join('')}<rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>`)}</v></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  };
  const sheetParts = sheets.map(s => sheetXml(s.rows));
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${opts.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${sharedXml.join('')}</sst>`;
  return buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', store: true },
    { name: 'xl/workbook.xml', data: workbook, store: opts.store },
    { name: 'xl/_rels/workbook.xml.rels', data: rels, store: opts.store },
    { name: 'xl/sharedStrings.xml', data: sst, store: opts.store },
    ...sheetParts.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml, store: opts.store })),
  ]);
}
