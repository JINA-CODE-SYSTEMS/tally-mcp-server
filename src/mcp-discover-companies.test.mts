import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCompaniesConfig, scanAvailableCompanies } from './mcp.mjs';

// Builds a fake Company.900/1800 file: UTF-16LE-encoded blob whose readable text contains
// the company name. Mirrors the structure scanAvailableCompanies / extractCompanyNameFromMetadataFile expect.
function makeCompanyFile(filePath: string, companyName: string): void {
  // Tally's real Company.* files have a binary header before the name; we prepend a few
  // non-printable bytes (which the extractor strips) so the test exercises the strip path.
  const prefix = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x00]);
  const nameBuf = Buffer.from(companyName, 'utf16le');
  fs.writeFileSync(filePath, Buffer.concat([prefix, nameBuf]));
}

function makeTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tally-mcp-discover-test-'));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('scanAvailableCompanies returns [] when data path does not exist', () => {
  const result = scanAvailableCompanies('/no/such/path/anywhere/12345');
  assert.deepEqual(result, []);
});

test('scanAvailableCompanies returns [] for empty data dir', () => {
  const dir = makeTempDataDir();
  try {
    const result = scanAvailableCompanies(dir);
    assert.deepEqual(result, []);
  } finally {
    rmDir(dir);
  }
});

test('scanAvailableCompanies finds flat-layout (Company.900) companies', () => {
  const dir = makeTempDataDir();
  try {
    fs.mkdirSync(path.join(dir, '100000'));
    makeCompanyFile(path.join(dir, '100000', 'Company.900'), 'Ross Industries Pvt Ltd');
    const result = scanAvailableCompanies(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].folderId, '100000');
    assert.equal(result[0].displayName, 'Ross Industries Pvt Ltd');
    assert.equal(result[0].hasData, true);
    assert.ok(result[0].dataFilePath?.endsWith('Company.900'));
    assert.ok(!result[0].notes.includes('Edit Log nested layout'));
  } finally {
    rmDir(dir);
  }
});

test('scanAvailableCompanies finds nested-layout (Edit Log Company.1800) companies', () => {
  const dir = makeTempDataDir();
  try {
    // Edit Log layout: <data>/<id>/<id>/Company.1800 — data files one level deeper than the
    // conventional layout. This is what scanCompanyFolders' single-level scan misses.
    fs.mkdirSync(path.join(dir, '100000', '100000'), { recursive: true });
    makeCompanyFile(path.join(dir, '100000', '100000', 'Company.1800'), 'EditLog Co Ltd');
    const result = scanAvailableCompanies(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].folderId, '100000');
    assert.equal(result[0].displayName, 'EditLog Co Ltd');
    assert.equal(result[0].hasData, true);
    assert.ok(result[0].dataFilePath?.endsWith('Company.1800'));
    assert.ok(result[0].notes.includes('Edit Log nested layout'));
  } finally {
    rmDir(dir);
  }
});

test('scanAvailableCompanies marks empty folders hasData=false with note', () => {
  const dir = makeTempDataDir();
  try {
    fs.mkdirSync(path.join(dir, '999999'));
    const result = scanAvailableCompanies(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].hasData, false);
    assert.equal(result[0].dataFilePath, null);
    assert.ok(result[0].notes.includes('No Company'));
  } finally {
    rmDir(dir);
  }
});

test('scanAvailableCompanies skips non-digit folder names (e.g. backups, temp)', () => {
  const dir = makeTempDataDir();
  try {
    fs.mkdirSync(path.join(dir, '100000'));
    makeCompanyFile(path.join(dir, '100000', 'Company.900'), 'Real Co');
    fs.mkdirSync(path.join(dir, 'backup-2026'));
    fs.mkdirSync(path.join(dir, '_tmp'));
    fs.writeFileSync(path.join(dir, 'README.txt'), 'not a folder we care about');
    const result = scanAvailableCompanies(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].folderId, '100000');
  } finally {
    rmDir(dir);
  }
});

test('scanAvailableCompanies merges credential hints from companies-config when present', () => {
  const dir = makeTempDataDir();
  try {
    fs.mkdirSync(path.join(dir, '100000'));
    makeCompanyFile(path.join(dir, '100000', 'Company.900'), 'Secret Co');
    fs.mkdirSync(path.join(dir, '200000'));
    makeCompanyFile(path.join(dir, '200000', 'Company.900'), 'Open Co');

    const configPath = path.join(dir, '.tally-mcp-companies.json');
    fs.writeFileSync(configPath, JSON.stringify({
      '100000': { requiresCredentials: true, knownUsername: 'admin', notes: 'user-based security' },
      '200000': { requiresCredentials: false }
    }));

    const result = scanAvailableCompanies(dir, configPath);
    const sortedById = result.sort((a, b) => a.folderId.localeCompare(b.folderId));
    assert.equal(sortedById[0].requiresCredentials, true);
    assert.equal(sortedById[0].knownUsername, 'admin');
    assert.ok(sortedById[0].notes.includes('user-based security'));
    assert.equal(sortedById[1].requiresCredentials, false);
    assert.equal(sortedById[1].knownUsername, null);
  } finally {
    rmDir(dir);
  }
});

test('scanAvailableCompanies leaves requiresCredentials=null when no config exists', () => {
  const dir = makeTempDataDir();
  try {
    fs.mkdirSync(path.join(dir, '100000'));
    makeCompanyFile(path.join(dir, '100000', 'Company.900'), 'Unknown Co');
    const result = scanAvailableCompanies(dir);  // no configPath
    assert.equal(result[0].requiresCredentials, null);
    assert.equal(result[0].knownUsername, null);
  } finally {
    rmDir(dir);
  }
});

test('loadCompaniesConfig returns {} when path does not exist', () => {
  assert.deepEqual(loadCompaniesConfig('/no/such/companies/config.json'), {});
});

test('loadCompaniesConfig returns {} on malformed JSON (does not throw)', () => {
  const dir = makeTempDataDir();
  try {
    const configPath = path.join(dir, 'bad.json');
    fs.writeFileSync(configPath, '{ this is not valid json');
    assert.deepEqual(loadCompaniesConfig(configPath), {});
  } finally {
    rmDir(dir);
  }
});

test('loadCompaniesConfig tolerates UTF-8 BOM (some editors emit one)', () => {
  const dir = makeTempDataDir();
  try {
    const configPath = path.join(dir, 'with-bom.json');
    const bom = '﻿';
    fs.writeFileSync(configPath, bom + JSON.stringify({ '100000': { requiresCredentials: true } }));
    const config = loadCompaniesConfig(configPath);
    assert.equal(config['100000']?.requiresCredentials, true);
  } finally {
    rmDir(dir);
  }
});

test('loadCompaniesConfig rejects array-shaped JSON (returns empty)', () => {
  const dir = makeTempDataDir();
  try {
    const configPath = path.join(dir, 'array.json');
    fs.writeFileSync(configPath, JSON.stringify([{ '100000': true }]));
    assert.deepEqual(loadCompaniesConfig(configPath), {});
  } finally {
    rmDir(dir);
  }
});
