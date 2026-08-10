# @opencontext/audit

Structured audit logging for security-sensitive actions: command execution,
file reads, and credential access. Provides logger functions plus an optional
`installAuditInterceptors` hook for global capture.

## Installation

```sh
pnpm add @opencontext/audit
```

## Exports

- `logCommandExec()` — Record a shell/process execution event
- `logFileRead()` — Record a filesystem read event
- `logCredentialAccess()` — Record a credential access event
- `readAuditLogs()` — Read existing audit entries
- `clearAuditLogs()` — Clear the audit log store
- `AUDIT_LOG_PATH` — Default on-disk location of the audit log
- `installAuditInterceptors()` — Install global process interceptors
- `AuditEntry`, `CredentialAccessEntry` — Entry types
