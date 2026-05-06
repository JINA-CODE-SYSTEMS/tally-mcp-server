# TDL / XML Reverse-Engineering Notes

Branch: `experiment/tally-internals`. Goal: find an XML/TDL request shape that **actually loads a company in Tally** (without restarting Tally), bypassing the apparent limitation that `$$CmpLoadCompany` evaluates as a boolean inside `<TALLYREQUEST>Export</TALLYREQUEST>` envelopes but never persists a load.

---

## Ground rules

- All probes go through the new `tally-raw-xml-probe` MCP tool. Gated by `TALLY_DEBUG_XML=1` on the server.
- After every probe that *might* have loaded a company, follow up with `list-loaded-companies` to verify the open list actually changed. If it didn't, the probe was a no-op regardless of what the response body says.
- Document each attempt below: hypothesis number, payload, raw response excerpt, list-loaded-companies before/after, conclusion.

---

## What's already known (from prior work + GitHub issue #1 thread)

- `$$CmpLoadCompany:"<name>"` inside a TDL Field SET, invoked via Export-type request → returns a TDL evaluation result (boolean), but does **not** load the company. State unchanged.
- `$$CmpConnect:"<name>"` — same behavior.
- `<SVCURRENTCOMPANY>` only routes XML requests between *already-loaded* companies. Not a load mechanism.
- The TDL add-on `scripts/mcp-company-loader.tdl` defines `MCPDoLoadCompany` action via `Form Accept` — but `Form Accept` only fires when the form is interactively displayed, which doesn't happen in Export mode.
- `Default Companies=Yes` + `Load=<id>` in `tally.ini` triggers auto-load on Tally startup. Validates that the engine knows how to load — we just can't reach the trigger from XML.

---

## Hypotheses queue

### H1: `<TALLYREQUEST>Import</TALLYREQUEST>` instead of `Export`

**Theory:** Import-type requests run procedural TDL on the server side (handling masters/vouchers data ingestion), so they may have privileges Export doesn't — including triggering company-load side effects.

#### H1A: Minimal Import variant (ID="List of Companies", SVCURRENTCOMPANY=ROSS)

**Payload:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>List of Companies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>ROSS</SVCURRENTCOMPANY>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>
```

**Result:**
- HTTP request hung indefinitely until user dismissed a Tally modal.
- Tally surfaced a modal: `TDL Error! - Description not found ( Description: Report - 'List of Companies')`
- After modal dismissed, response was empty/unparseable (likely token-expired by then).
- `list-loaded-companies` AFTER: still empty — no company was loaded.

**Conclusions:**
- **`TALLYREQUEST=Import` is fundamentally different from Export**: Import dispatches the `<ID>` as something to *execute* in Tally's runtime, not just read.
- **Import requests block on UI state** — if the dispatch surfaces a modal (error or otherwise), the HTTP response hangs until a human dismisses it.
- "List of Companies" is NOT a known report name in this Tally Prime build (Silver edition seen in the screenshot). Would need to find the actual report/action ID for company loading.
- We confirmed the bootstrap goal is unchanged (no company loaded after attempt) — so H1A doesn't load a company, but the failure mode tells us we're hitting the right *codepath*.

**Important environmental finding:**
- Test box runs **Tally Prime SILVER edition** (visible in title bar from screenshot).
- Silver = single-user, single-company. Multi-company loading is a Gold-edition feature.
- This may invalidate the entire "load multiple subsidiaries" use case on Silver — no XML trick will bypass an engine-level edition restriction.
- **Action item:** confirm Silver vs Gold via `Help → About`; if Silver, decide whether the production target is Silver (load = swap, not add) or Gold (multi-load works).

#### H1B: try a known-valid report ID

_(pending — needs user to confirm Silver/Gold and approve more modal-blocking probes)_

Candidate IDs to try once we resume:
- `Open Company` (engine action name)
- `Cmp Load Company`
- `Load Company`
- `Select Company`
- `Company Info`
- `Open Existing Company`

---

### H2: Custom TDL `Action` that wraps the engine-level Load Company action

**Theory:** Tally's UI invokes a built-in Action called `Load Company` (visible via the Help menu's action list). TDL can `Call:` actions. If we define a custom Action that calls the engine action, and invoke our Action via XML, the engine action might fire.

**Payload sketch:**
```xml
<TDL>
  <TDLMESSAGE>
    <ACTION NAME="MCPLoadCmp">
      <ACTION>Call: Load Company : "@@MCPTargetCmp"</ACTION>
    </ACTION>
  </TDLMESSAGE>
</TDL>
```

(Wrapped in an envelope that triggers the action.)

**Result:** _(pending)_

**Conclusion:** _(pending)_

---

### H3: Embed `$$CmpLoadCompany` inside a TDL `[Function]` body (not a Field SET)

**Theory:** TDL functions (`[Function: ...]` blocks) have different execution semantics from field expressions — they support multi-statement bodies (`LOOP`, `RETURN`, side-effect statements). The function context may grant the privilege to actually trigger the load.

**Payload sketch:**
```xml
<TDL>
  <TDLMESSAGE>
    <FUNCTION NAME="MCPLoad">
      <PARAMETER>pCmpName : String</PARAMETER>
      <RETURNS>Logical</RETURNS>
      <ACTIONS>
        <01>SET : Result : $$CmpLoadCompany:##pCmpName</01>
        <02>RETURN : ##Result</02>
      </ACTIONS>
    </FUNCTION>
  </TDLMESSAGE>
</TDL>
```

…then call `$$MCPLoad:"SPECTRUM"` from a report.

**Result:** _(pending)_

**Conclusion:** _(pending)_

---

### H4: Use Tally's native action verb names directly as request body

**Theory:** Tally menus invoke actions like `Load Company`, `Open Company`, `Select Company`. If the XML server accepts an action name as the request `ID` (with `<TYPE>Action</TYPE>`), the engine might dispatch the same code path the menu uses.

Variants to try:
- `<ID>Load Company</ID>` with `<TYPE>Action</TYPE>`
- `<ID>LOAD COMPANY</ID>`
- `<ID>Cmp Load Company</ID>`
- `<ID>Open Company</ID>`
- `<ID>SELECT COMPANY</ID>`

For each, vary `<TALLYREQUEST>` between `Export`, `Import`, `Action`, `Update`.

**Result:** _(pending)_

---

### H5: `<TALLYREQUEST>Update</TALLYREQUEST>` with a Company-shaped object payload

**Theory:** Tally supports importing master/transaction data via XML. Pushing a Company object (even a no-op update referencing a known on-disk folder) might trigger the engine to load it as part of the update reconciliation.

**Result:** _(pending)_

---

## Open questions / tools we may need later

- Is there a way to *enumerate available actions* on the Tally engine? (e.g. an XML query against an internal Action collection.) Would let us discover verbs programmatically rather than guessing.
- Is there an Audit log inside Tally itself that shows which actions fire on each XML request? Would close the inference loop on whether a probe actually triggered the Load codepath internally even if the open-list didn't change.
- The `$$SysInfo` TDL function may expose engine version and build flags. Worth probing — different builds of Tally Prime may have different XML capabilities.

---

## Negative results catalog

(populated as hypotheses fail — useful so we don't re-test)

### Dispatch surface mapped (2026-05-06)

| `<TYPE>` | Verdict | Notes |
| --- | --- | --- |
| `Data` | valid | Looks up Report by `<ID>`; with Import, executes Report (can pop UI modals) |
| `Function` | valid | **Built-ins NOT exposed** (`$$CmpLoadCompany`, `$$CmpIsLoaded`, `$$SysInfo` all "Could not find"); inline TDL definitions in body are NOT processed; only PRE-installed user functions are callable |
| `Object` | valid | Already-loaded only; does NOT auto-load to satisfy a query; folder ID treated as a name |
| `Collection` | valid | Already-loaded only; returns CMPINFO stats |
| `Report` | INVALID | "Unknown Request, cannot be processed" |
| `Action` | INVALID | "Unknown Request, cannot be processed" |

| `<TALLYREQUEST>` | Verdict | Notes |
| --- | --- | --- |
| `Export` | valid | Returns data |
| `Import` | valid | Dispatches Report execution as a side effect (UI-visible) |
| `Action`, `Update`, `Receive`, `Service` | accepted by parser | All routed to Description (Report) lookup; no special verb privilege over Import |

### `$$CmpLoadCompany` is NOT a loader

- Tested via inline TDL Report with `Form Accept` action body (H3A) and engine-action `Action: Cmp Load Company` clause (H3B).
- Both invocations DID fire the function — confirmed by getting Tally's standard "Could not find Company `''`" error message.
- The function searches the in-memory Company collection by name. With no companies loaded, the collection is empty, so any lookup fails with the empty-string error.
- **Conclusion**: `$$CmpLoadCompany` is a "select among already-loaded companies" function, not a "load from disk" function. Its name misled prior implementations (`scripts/mcp-company-loader.tdl`).

### Architectural conclusion

**Tally Prime has no XML or TDL primitive that loads a company from disk.** Loading is exclusively initiated by:

1. Tally process startup (via `Load=` directives in `tally.ini`)
2. Tally UI (Alt+F3 → Select Company)

This is an engine-level constraint, not a protocol limitation. **Path A (tally.ini rewrite + Tally restart) is the only restart-based mechanism; the GUI agent (Strategy 3 of `open-company`) is the only restart-free mechanism.** No XML envelope can route around either.

### What's deprecated

- `scripts/mcp-company-loader.tdl` — the TDL add-on never could have worked. Safe to remove or leave as a historical artifact.
- `open-company` Strategy 1 (`tdl-load`) and Strategy 2 (`tdl-connect`) — these test for accessibility, not load. They should be renamed for clarity (e.g. `verify-loaded`, `check-open-list`) since they cannot bootstrap.

### Edition note

Test box was Tally Prime SILVER (single-user, single-company). Even if a load primitive existed, multi-load wouldn't work on Silver. For multi-subsidiary cross-reference workflows, **Gold is required at the engine level** — no MCP-side trick fixes this.
