// Typed failures of the signed update channel (#177), classified the way docs/dev/update-manifest.md
// §8 ("Failure surfacing") requires. The classification matters as much as the failure: a transport
// problem (captive portal, proxy error page, oversized body) is quiet and counts toward "stale"; a
// well-formed document that fails a check is loud, immediately. The updater and the tray read
// `surface` to decide which of the §8 states to show; they never decide it from the message text.

/**
 * Which §8 state a failure maps to.
 *
 * - `transport`            quiet; retried next run; counts toward "Stale" (amber after 7 days)
 * - `verification-failed`  red: "An update was rejected because it could not be verified. Nothing was
 *                          installed. Please tell Jina."
 * - `update-keys-expired`  red: the trusted key set expired and no newer one verified
 * - `stale`                the manifest on offer has expired — a possible freeze (A7). Amber; red once
 *                          the stored manifest has expired too
 * - `deferred`             quiet, retried: Authenticode revocation status could not be fetched. Never a pass
 * - `internal`             our own bug or damaged local state. Loud: a silently broken updater is worse
 *                          than none
 */
export type FailureSurface =
  | 'transport'
  | 'verification-failed'
  | 'update-keys-expired'
  | 'stale'
  | 'deferred'
  | 'internal';

// Every code the verification core can raise, with the §8 state it surfaces as. The step comments
// refer to the normative order in update-manifest.md §6.
const SURFACE_BY_CODE = {
  // Before anything is verified: the bytes are not a DSSE envelope at all, or are over the cap (A9).
  METADATA_TOO_LARGE: 'transport',
  ENVELOPE_NOT_DSSE: 'transport',
  KEYSET_MISSING: 'transport',

  // Envelope and signatures (§5, steps 2 and 4).
  ENVELOPE_INVALID: 'verification-failed',
  PAYLOAD_TYPE_MISMATCH: 'verification-failed',
  SIGNATURE_THRESHOLD_NOT_MET: 'verification-failed',

  // Documents (§4.2, §4.3).
  PAYLOAD_INVALID: 'verification-failed',
  DOCUMENT_TYPE_MISMATCH: 'verification-failed',
  SPEC_VERSION_UNSUPPORTED: 'verification-failed',
  KEYID_MISMATCH: 'verification-failed',
  KEYSET_INVALID: 'verification-failed',

  // Key-set refresh (step 2).
  KEYSET_ROLLBACK: 'verification-failed',
  KEYSET_VERSION_GAP: 'verification-failed',
  KEYSET_EXPIRED: 'update-keys-expired',
  AUTHENTICODE_LATCH_VIOLATION: 'verification-failed',

  // Manifest (step 4).
  CHANNEL_MISMATCH: 'verification-failed',
  MANIFEST_KEYS_TOO_OLD: 'verification-failed',
  MANIFEST_ROLLBACK: 'verification-failed',
  MANIFEST_FROM_FUTURE: 'verification-failed',
  MANIFEST_LIFETIME_TOO_LONG: 'verification-failed',
  MANIFEST_EXPIRED: 'stale',
  RELEASE_VERSION_INVALID: 'verification-failed',
  ARTIFACT_URL_INVALID: 'verification-failed',

  // Artifact (steps 7 and 9).
  ARTIFACT_SIZE_MISMATCH: 'verification-failed',
  ARTIFACT_HASH_MISMATCH: 'verification-failed',
  ARTIFACT_UNREADABLE: 'internal',

  // Authenticode (step 8). The call into WinVerifyTrust lands with #175; the policy check is here.
  AUTHENTICODE_UNSIGNED: 'verification-failed',
  AUTHENTICODE_INVALID: 'verification-failed',
  AUTHENTICODE_SIGNER_MISMATCH: 'verification-failed',
  AUTHENTICODE_NO_TIMESTAMP: 'verification-failed',
  AUTHENTICODE_REVOCATION_UNAVAILABLE: 'deferred',

  // Our side: pinned trust anchors, persisted state, caller input.
  ROOT_NOT_CONFIGURED: 'internal',
  STATE_INVALID: 'internal',
  INPUT_INVALID: 'internal',
} as const satisfies Record<string, FailureSurface>;

export type UpdateErrorCode = keyof typeof SURFACE_BY_CODE;

/** Why one signature in an envelope did not count toward a threshold. */
export type SignatureRejection =
  | 'unknown-key'    // keyid is not a key trusted for any role (ignored, per §5)
  | 'wrong-role'     // keyid belongs to the other role: a root key on a manifest, a release key on keys.json
  | 'revoked'        // keyid is listed in revoked_keyids
  | 'expired'        // release key whose own `expires` has passed
  | 'bad-signature'  // the key is trusted for this role but the signature does not verify
  | 'duplicate';     // a second signature by a key already counted

export type UpdateErrorDetails = Record<string, unknown>;

export class UpdateVerificationError extends Error {
  readonly code: UpdateErrorCode;
  readonly surface: FailureSurface;
  readonly details: UpdateErrorDetails;

  constructor(code: UpdateErrorCode, message: string, details: UpdateErrorDetails = {}) {
    super(`${code}: ${message}`);
    this.name = 'UpdateVerificationError';
    this.code = code;
    this.surface = SURFACE_BY_CODE[code];
    this.details = details;
  }

  /** True for failures §8 says must be shown immediately, in red. */
  get loud(): boolean {
    return this.surface === 'verification-failed' || this.surface === 'update-keys-expired' || this.surface === 'internal';
  }
}

export function surfaceOf(code: UpdateErrorCode): FailureSurface {
  return SURFACE_BY_CODE[code];
}

/**
 * The tray text for each state, from §8. It never suggests downloading the update by hand or any other
 * way around a failed verification.
 */
export const SURFACE_MESSAGES: Readonly<Record<FailureSurface, string>> = Object.freeze({
  'transport': 'Could not reach the update server. Will try again.',
  'verification-failed': 'An update was rejected because it could not be verified. Nothing was installed. Please tell Jina.',
  'update-keys-expired': 'Update keys expired. Updates cannot be verified until newer keys are available. Please tell Jina.',
  'stale': 'Could not get a current update manifest. This install may not be receiving updates.',
  'deferred': 'Update check deferred: the signature status of the update could not be confirmed. Will try again.',
  'internal': 'The updater hit an internal error. Nothing was installed. Please tell Jina.',
});
