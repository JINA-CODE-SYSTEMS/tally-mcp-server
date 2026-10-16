// A deliberately narrow JSON parser for the signed update documents (#177).
//
// `JSON.parse` is too forgiving for a document whose meaning must be the same to every reader: it
// keeps the *last* of two duplicate keys (another parser may keep the first, so an auditor and the
// client could read different values from the same signed bytes), silently strips nothing but
// accepts lone surrogates, and turns `1e400` into Infinity. This parser accepts strict RFC 8259 JSON
// minus the parts no update document needs, and rejects rather than guesses:
//
// - the bytes must be valid UTF-8, with no byte-order mark
// - an object may not repeat a key (compared after unescaping, so "a" and "a" collide)
// - numbers must be integers written plainly (no fraction, no exponent, no leading zeros, no -0)
//   and within Number.MAX_SAFE_INTEGER
// - strings may not contain lone surrogates
// - nesting is capped
//
// Objects come back with a null prototype, so a key such as "__proto__" is only ever data.

export class StrictJsonError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = 'StrictJsonError';
  }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const MAX_DEPTH = 32;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function parseStrictJson(bytes: Uint8Array): JsonValue {
  let text: string;
  try {
    // ignoreBOM: true keeps a leading U+FEFF in the text, where the parser rejects it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StrictJsonError('not valid UTF-8', 0);
  }
  const p = new Parser(text);
  p.ws();
  const value = p.value(0);
  p.ws();
  if (p.i !== text.length) p.fail('trailing data after the JSON value');
  return value;
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  fail(msg: string): never {
    throw new StrictJsonError(msg, this.i);
  }

  ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  value(depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.fail('nesting too deep');
    const c = this.s[this.i];
    if (c === '{') return this.object(depth + 1);
    if (c === '[') return this.array(depth + 1);
    if (c === '"') return this.string();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.number();
    if (this.s.startsWith('true', this.i)) { this.i += 4; return true; }
    if (this.s.startsWith('false', this.i)) { this.i += 5; return false; }
    if (this.s.startsWith('null', this.i)) { this.i += 4; return null; }
    return this.fail('unexpected character');
  }

  object(depth: number): { [key: string]: JsonValue } {
    const out: { [key: string]: JsonValue } = Object.create(null);
    const seen = new Set<string>();
    this.i++; // {
    this.ws();
    if (this.s[this.i] === '}') { this.i++; return out; }
    for (;;) {
      if (this.s[this.i] !== '"') this.fail('expected a string key');
      const keyAt = this.i;
      const key = this.string();
      if (seen.has(key)) throw new StrictJsonError(`duplicate key ${JSON.stringify(key)}`, keyAt);
      seen.add(key);
      this.ws();
      if (this.s[this.i] !== ':') this.fail('expected ":"');
      this.i++;
      this.ws();
      out[key] = this.value(depth);
      this.ws();
      const c = this.s[this.i];
      if (c === ',') { this.i++; this.ws(); continue; }
      if (c === '}') { this.i++; return out; }
      this.fail('expected "," or "}"');
    }
  }

  array(depth: number): JsonValue[] {
    const out: JsonValue[] = [];
    this.i++; // [
    this.ws();
    if (this.s[this.i] === ']') { this.i++; return out; }
    for (;;) {
      out.push(this.value(depth));
      this.ws();
      const c = this.s[this.i];
      if (c === ',') { this.i++; this.ws(); continue; }
      if (c === ']') { this.i++; return out; }
      this.fail('expected "," or "]"');
    }
  }

  string(): string {
    const s = this.s;
    this.i++; // opening quote
    let out = '';
    for (;;) {
      if (this.i >= s.length) this.fail('unterminated string');
      const code = s.charCodeAt(this.i);
      if (code === 0x22) { this.i++; break; }
      if (code < 0x20) this.fail('control character in string');
      if (code === 0x5c) {
        const e = s[this.i + 1];
        this.i += 2;
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = s.slice(this.i, this.i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('bad \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.i += 4;
            break;
          }
          default: this.i -= 2; this.fail('bad escape');
        }
        continue;
      }
      out += s[this.i];
      this.i++;
    }
    if (LONE_SURROGATE.test(out)) this.fail('lone surrogate in string');
    return out;
  }

  number(): number {
    const m = /^-?(0|[1-9][0-9]*)/.exec(this.s.slice(this.i, this.i + 32));
    if (!m) return this.fail('bad number');
    const next = this.s[this.i + m[0].length];
    if (next === '.' || next === 'e' || next === 'E') this.fail('only integers are allowed');
    if (next !== undefined && next >= '0' && next <= '9') this.fail('number too long');
    if (m[0] === '-0') this.fail('negative zero');
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) this.fail('integer out of range');
    this.i += m[0].length;
    return n;
  }
}
