# tally-feeding skill

A Claude skill for **client-consistent data entry into Tally Prime** through the
Tally Prime MCP server. It's the seed skill meant to be distributed to other users of
the MCP server as-is.

## What it does

When you ask Claude to feed / post / enter data into Tally for a client, the skill:

1. **Learns the client's existing conventions** live from their Tally (chart of
   accounts, ledger & party naming, tax ledgers, voucher and stock patterns) — all
   read-only.
2. **Confirms with the client** whether to keep those conventions as-is or change
   them, and records the decision.
3. **Feeds new data** (ledgers, stock items, vouchers, GST invoices) matched to the
   confirmed conventions, with a **preview + consent** step on every write — you can
   *allow once* or *allow always* (scoped per action type per client, and reversible).
4. **Verifies** the postings and **updates a per-client instruction sheet** as you
   give feedback, so entries stay consistent across sessions.

Designed for Claude Opus / Sonnet.

## Layout

```
tally-feeding/
├── SKILL.md                                  the skill (generic, distributable)
├── references/
│   └── tally-tools.md                        exact MCP tool names, params, collections
├── assets/
│   ├── client-instruction-sheet.template.md  template Claude copies per client
│   └── example-filled-sheet.md               fictional worked example
└── clients/                                   PRIVATE — real per-client sheets (git-ignored)
    └── .gitkeep
```

## Distribution & privacy

`SKILL.md`, `references/`, and `assets/` are generic and safe to share — this is what
other users install. The `clients/` folder holds real client conventions and consent
grants; it is **git-ignored** and ships empty. Each user builds their own client
sheets the first time they feed data for a client.

## Requirements

- The Tally Prime MCP server (this repo) connected to Claude.
- Write tools enabled — i.e. the server **not** running with `READONLY_MODE=true`
  (in read-only mode the skill falls back to producing a manual-entry plan).
