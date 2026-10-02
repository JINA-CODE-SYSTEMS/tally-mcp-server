# Throwaway spike: remote channel and pairing (#219)

**This is not product code.** It is not built by `npm run build` and not tested by `npm test`. It is
not in the installer and nothing in `src/` imports it. It exists to show that the design in
[docs/dev/remote-channel-design.md](../../../docs/dev/remote-channel-design.md) works on the runtime
we ship, and that its one third-party dependency installs with install scripts disabled. P2 and P3
write the real code. Delete this folder once they land.

## What it shows

- `@noble/curves` 2.4.0 and its only dependency, `@noble/hashes` 2.4.0, install with
  `npm ci --ignore-scripts` on Windows x64 under Node 22.23.2. That is the Node the installer pins.
  Both are pure JS with no install scripts. `npm audit signatures` reports verified registry
  signatures and provenance attestations for both.
- The CPace glue (`cpace.mjs`) reproduces every value in draft-irtf-cfrg-cpace-21 Appendix B.5
  (CPACE-P256_XMD:SHA-256_SSWU_NU_-SHA256): generator string, generator, both shares, K, ISK. It also
  aborts on the draft's invalid-point vectors (B.5.11). The string helpers match A.1 and A.3.
- Pairing works end to end: CPace, then a TLS 1.3 external-PSK handshake whose Finished messages
  confirm the key, then a per-device key taken from the TLS exporter. The encrypted MCP-shaped
  exchange also works, both directly ("LAN") and through a forwarding relay that records every byte.
  Nothing readable crosses the relay. The ClientHello offers only `psk_dhe_ke`, so every session
  has forward secrecy.
- Negative tests pass:
  - wrong code, including lockout after three tries
  - expired code and reused code
  - replay of a recorded pairing transcript
  - our protocol version downgraded, and TLS 1.2
  - LAN/relay transport confusion
  - an unpaired device, and a known device id presented with the wrong key
  - revocation of a live session
  - a revoked device trying to resume a saved TLS session
  - a relay flipping one ciphertext bit
- The pre-TLS frame parser survives 20,000 random mutations: every mutated frame either throws
  `FrameError` or parses into a well-formed result. It never crashes.

## Run

```
cd scripts/dev/spike-channel
npm ci --ignore-scripts
node spike.mjs
```

It exits 0 only if every check passes. Last run: Node v22.23.2, OpenSSL 3.5.7, win32-x64,
49/49 checks passed.

## What it deliberately does not do

- No DPAPI key storage, no service, no tray, no discovery, no real relay. It uses TCP loopback only.
- No rendezvous. The code in the spike is 8 characters, all fed into CPace as the password. The
  split between the rendezvous part and the secret part, and the code's encoding, are internal
  (#178).
- The wire encodings, labels and version strings here are placeholders. They are not a format
  anyone should implement against.
