import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStrictJson, StrictJsonError } from './strict-json.mjs';

const parse = (s: string | Buffer) => parseStrictJson(typeof s === 'string' ? Buffer.from(s, 'utf8') : s);
// Parsed objects have a null prototype; deepStrictEqual compares prototypes, so compare plain copies.
const plain = (s: string) => JSON.parse(JSON.stringify(parse(s)));
const bad = (s: string | Buffer, why: RegExp) => assert.throws(() => parse(s), (e: unknown) => e instanceof StrictJsonError && why.test(e.message));

test('strict JSON: parses ordinary documents', () => {
  assert.deepEqual(plain(' {"a": [1, -2, true, false, null, "x\\u00e9\\n"], "b": {}} '), { a: [1, -2, true, false, null, 'xé\n'], b: {} });
  assert.deepEqual(plain('"\\ud83d\\ude00"'), '😀');
});

test('strict JSON: duplicate keys are rejected, including ones spelled differently', () => {
  bad('{"a":1,"a":2}', /duplicate key/);
  bad('{"a":1,"\\u0061":2}', /duplicate key/);
  bad('{"x":{"version":1,"version":2}}', /duplicate key/);
});

test('strict JSON: only plain integers are numbers', () => {
  bad('{"v":1.0}', /only integers/);
  bad('{"v":1e3}', /only integers/);
  bad('{"v":1E3}', /only integers/);
  bad('{"v":01}', /number too long|unexpected|expected/);
  bad('{"v":-0}', /negative zero/);
  bad('{"v":9007199254740992}', /out of range/);
  bad('{"v":+1}', /unexpected/);
  assert.deepEqual(plain('{"v":9007199254740991}'), { v: 9007199254740991 });
});

test('strict JSON: encoding problems are rejected', () => {
  bad(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]), /unexpected/); // BOM
  bad(Buffer.from([0x22, 0xc3, 0x28, 0x22]), /UTF-8/);
  bad('"\\ud800"', /lone surrogate/);
  bad('"a\u0001b"', /control character/);
  bad('"\\x41"', /bad escape/);
});

test('strict JSON: structure problems are rejected', () => {
  bad('{"a":1}x', /trailing data/);
  bad('{"a":1,}', /string key/);
  bad('[1,]', /unexpected/);
  bad("{'a':1}", /string key/);
  bad('NaN', /unexpected/);
  bad('['.repeat(40) + ']'.repeat(40), /too deep/);
});

test('strict JSON: "__proto__" is just a key', () => {
  const v = parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(v), null);
  assert.deepEqual(Object.keys(v), ['__proto__']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
