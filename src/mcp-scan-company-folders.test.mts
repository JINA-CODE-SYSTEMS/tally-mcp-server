import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCompanyFolders, findCompanyMetadataFile } from './mcp.mjs';

function mkMetaFile(dir: string, fileName: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  // Company.900/.1800 are UTF-16LE blobs: a binary header then the readable name.
  const header = Buffer.from([0x00, 0x01, 0x02, 0x00]);
  const body = Buffer.from(name, 'utf16le');
  fs.writeFileSync(path.join(dir, fileName), Buffer.concat([header, body]));
}

test('scanCompanyFolders recovers names for flat AND nested (Edit Log) layouts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-scan-'));
  try {
    // Flat layout: <data>/<id>/Company.900
    mkMetaFile(path.join(root, '100000'), 'Company.900', 'Flat Layout Co');
    // Nested Edit Log layout: <data>/<id>/<id>/Company.1800 — the case that used
    // to yield a blank name because list-companies only read the flat Company.900.
    mkMetaFile(path.join(root, '100001', '100001'), 'Company.1800', 'Nested EditLog Co');
    // A digit folder with no metadata → name stays blank (expected).
    fs.mkdirSync(path.join(root, '100002'), { recursive: true });

    const folders = scanCompanyFolders(root);
    const byId = Object.fromEntries(folders.map(f => [f.folder, f.name]));

    assert.equal(byId['100000'], 'Flat Layout Co');
    assert.equal(byId['100001'], 'Nested EditLog Co', 'nested-layout name must not be blank');
    assert.equal(byId['100002'], '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findCompanyMetadataFile reports layout marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-find-'));
  try {
    mkMetaFile(path.join(root, 'flat'), 'Company.900', 'X Co');
    mkMetaFile(path.join(root, 'nest', 'inner'), 'Company.1800', 'Y Co');
    assert.equal(findCompanyMetadataFile(path.join(root, 'flat'))?.layout, 'flat');
    assert.equal(findCompanyMetadataFile(path.join(root, 'nest'))?.layout, 'nested');
    assert.equal(findCompanyMetadataFile(path.join(root, 'missing')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
