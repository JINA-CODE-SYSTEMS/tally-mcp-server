import fs from 'node:fs';

// File-backed idempotency store (#95 H-9, #97 H-11). Maps an idempotency key to the prior result so
// replaying the same key returns the stored outcome instead of re-posting a voucher (→ DUPLICATE /
// dedupe). Deliberately simple + synchronous: writes are rare (only on a successful write) and small.
export type IdempotencyRecord = { key: string; result: unknown; at: string };

export type IdempotencyStore = {
  get(key: string): IdempotencyRecord | null;
  put(key: string, result: unknown, at: string): void;
};

export function makeIdempotencyStore(filePath: string): IdempotencyStore {
  const load = (): Record<string, IdempotencyRecord> => {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj as Record<string, IdempotencyRecord> : {};
    } catch {
      return {};
    }
  };
  return {
    get(key: string): IdempotencyRecord | null {
      if (!key) return null;
      return load()[key] ?? null;
    },
    put(key: string, result: unknown, at: string): void {
      if (!key) return;
      const all = load();
      all[key] = { key, result, at };
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, filePath);
    },
  };
}
