## Summary

<!-- Brief description of what this PR does -->

## Changes

- 

## Checklist

- [ ] `npx tsc` compiles without errors
- [ ] `npm test` passes
- [ ] No secrets, passwords, GSTINs, or financial data in the diff
- [ ] New MCP tools include `auditLog()` calls
- [ ] Write tools check `READONLY_MODE` before executing
- [ ] XML parameters use `utility.String.escapeHTML()` for injection prevention
- [ ] SQL queries go through `validateSQL()` before execution
