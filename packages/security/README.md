# @openloomi/security

Cryptographic and validation primitives for OpenLoomi: Fernet token
encryption, URL allowlisting, and a pluggable key manager.

## Installation

```sh
pnpm add @openloomi/security
```

## Subpath Exports

- `@openloomi/security` — Main entrypoint
- `@openloomi/security/token-encryption` — Fernet-style symmetric encryption
- `@openloomi/security/url-validator` — URL allowlist / blocklist validation
- `@openloomi/security/key-manager` — Pluggable key resolution interface
