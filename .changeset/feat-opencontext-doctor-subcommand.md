---
"@melandlabs/opencontext": minor
---

Add `opencontext doctor` — read-only health checks across nine install-subsystem sections.

`doctor` runs the user's local install through nine sections (`runtime`, `filesystem`, `loop`, `memory-store`, `embedding`, `policies`, `audit`, `security`, `integrations`) and reports `ok` / `warn` / `fail` for each probe.

## Surface

```bash
opencontext doctor                          # human-readable; warns + fails only
opencontext doctor --json                   # stable { ok, exit, results } envelope
opencontext doctor --section memory-store   # filter to one section
opencontext doctor --section bogus          # unknown section → warn, not fail
opencontext doctor --deep                   # opt-in real memory-store read probe
opencontext doctor --user alice             # probe policies as a specific user
opencontext doctor --verbose                # also show passing checks
```

Exit codes: `0` when no check fails, `1` otherwise. Warnings never affect the exit code, so `--json | jq -e '.ok == true'` is a one-liner CI gate.

## Behaviour notes

- **Read-only by design.** No `--fix` knob — the PowerContext pattern. Auto-fix in v1 would risk silently rewriting a user's install on the same command they ran to *diagnose* it.
- **Best-effort probes.** A thrown probe becomes a single `fail` result, never a crash. The doctor always completes.
- **`--deep` opt-in.** A real `lexicalSearchMessages` probe against the local sqlite store is gated behind `--deep` so the default run stays cheap enough for CI / first-install smoke.
- **No new runtime deps.** `@melandlabs/audit` is added as a `devDependency` because the audit probe imports `AUDIT_LOG_PATH` and `readAuditLogs` directly; everything else was already re-exported through the facade.

## Compatibility

- Existing `opencontext` and `opencontext http` subcommands are unchanged.
- The new bin entry (`cli/opencontext`) ships via the existing tsup bundle; no `tsup.config.ts` change needed.
