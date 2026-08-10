# @opencontext/security

Cryptographic and validation primitives for OpenLoomi: Fernet token
encryption, URL allowlisting, and a pluggable key manager.

## Installation

```sh
pnpm add @opencontext/security
```

## Subpath Exports

- `@opencontext/security` — Main entrypoint
- `@opencontext/security/token-encryption` — Fernet-style symmetric encryption
- `@opencontext/security/url-validator` — URL allowlist / blocklist validation
- `@opencontext/security/key-manager` — Pluggable key resolution interface
