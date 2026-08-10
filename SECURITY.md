# Security Policy

## Supported Versions

| Version | Supported      |
| ------- | -------------- |
| 0.10.x  | ✅ Active      |
| < 0.10  | ❌ End of life |

## Reporting a Vulnerability

Please **do not** file public GitHub issues for security vulnerabilities.

Email **developers@melandlabs.ai** (PGP key on request) with:

- A description of the issue and its impact.
- A reproducible proof-of-concept or a minimal failing test case.
- The commit hash or release tag you observed the issue on.

We aim to acknowledge reports within **3 business days** and to provide a fix
or mitigation plan within **14 days** for severity-high issues.

## Scope

- Cryptographic primitives shipped under `@context/security`
- Encryption-at-rest in `@context/storage` adapters
- URL allowlist / blocklist logic in `@context/security/url-validator`
- Audit logging in `@context/audit`
- Fernet token handling in `@context/security/token-encryption`

## Out of Scope

- Vulnerabilities in upstream dependencies (file against the upstream project).
- Issues that require the user to disable security tooling to reproduce.
- Social-engineering or phishing against project maintainers.
