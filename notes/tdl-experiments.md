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

**Payload:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Action</TYPE>
    <ID>Cmp Load Company</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>SPECTRUM</SVCURRENTCOMPANY>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>
```

**Result:** _(pending)_

**Conclusion:** _(pending)_

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

- _(none yet)_
