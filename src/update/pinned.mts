// The production entry point to update verification (#177), bound to compiled-in constants.
//
// update-manifest.md §9.2: "Root keys and URLs are constants in the source. The verification module
// takes keys as function arguments so its tests can supply a test hierarchy; the production
// entrypoint has no parameter, variable or file through which to supply them." That is this file.
// Its functions take the persisted state and the fetched bytes, and nothing else: an input object
// carrying any other property (a root, a threshold, a channel, a clock, a "skip") is refused, and the
// clock is read here, not passed in. Nothing here reads the environment, argv, the registry or a file.
//
// NO ROOT KEY HAS BEEN GENERATED. PINNED_ROOT is empty until the root ceremony on the offline signing
// laptop (threat model §5.4) produces one; with it empty, every call fails closed with
// ROOT_NOT_CONFIGURED. Do not put a test key here: the test suite's private keys are generated at
// run time and never committed, and a key whose private half is anywhere but that laptop would be a
// way into every install.

import { UpdateVerificationError } from './errors.mjs';
import {
  refreshKeySet,
  verifyManifest,
  type RefreshKeySetResult,
  type RootOfTrust,
  type UpdateState,
  type VerifiedManifest,
} from './verify.mjs';

/** Root public keys pinned in this build (`keyid` = SHA-256 hex of the raw key, `public_key` = base64). */
export const PINNED_ROOT: RootOfTrust = Object.freeze({
  threshold: 1,
  keys: Object.freeze([]),
});

/** The only channel in spec v1. */
export const UPDATE_CHANNEL = 'stable';

/** §4.1. Hosting is not a trust input; these are only where to fetch. */
export const UPDATE_BASE_URL = 'https://claudally.jinacode.systems/update/v1/';
export const KEYS_URL = `${UPDATE_BASE_URL}keys.json`;
export const MANIFEST_URL = `${UPDATE_BASE_URL}${UPDATE_CHANNEL}/manifest.json`;
export function keySetVersionUrl(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new UpdateVerificationError('INPUT_INVALID', 'key-set version must be a positive integer');
  return `${UPDATE_BASE_URL}keys/${version}.json`;
}

function exactInput(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UpdateVerificationError('INPUT_INVALID', 'input must be an object');
  }
  const extra = Reflect.ownKeys(input).filter((k) => typeof k !== 'string' || !allowed.includes(k));
  if (extra.length) {
    throw new UpdateVerificationError('INPUT_INVALID', `unexpected input(s): ${extra.map(String).join(', ')}; trust is not configurable`);
  }
  return input as Record<string, unknown>;
}

/** §6 step 2 against the pinned root and the system clock. */
export function refreshPinnedKeySet(input: { readonly state: UpdateState; readonly keySetEnvelopes: readonly Uint8Array[] }): RefreshKeySetResult {
  const i = exactInput(input, ['state', 'keySetEnvelopes']);
  return refreshKeySet({ root: PINNED_ROOT, state: i.state as UpdateState, keySetEnvelopes: i.keySetEnvelopes as Uint8Array[], now: new Date() });
}

/** §6 step 4 on the pinned channel and the system clock. */
export function verifyPinnedManifest(input: { readonly state: UpdateState; readonly manifestEnvelope: Uint8Array }): VerifiedManifest {
  const i = exactInput(input, ['state', 'manifestEnvelope']);
  // The key set in state was adopted through refreshPinnedKeySet, so it chains to PINNED_ROOT; an
  // empty pin means nothing was ever adopted, and this stops here too.
  if (PINNED_ROOT.keys.length === 0) {
    throw new UpdateVerificationError('ROOT_NOT_CONFIGURED', 'pinned root: keys is empty: no root key has been pinned in this build, so no update can be verified');
  }
  return verifyManifest({ state: i.state as UpdateState, manifestEnvelope: i.manifestEnvelope as Uint8Array, channel: UPDATE_CHANNEL, now: new Date() });
}
