# security (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Cryptographic and validation primitives for OpenContext: Fernet token
encryption, URL allowlisting, and a pluggable key manager.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `security` — Main entrypoint
- `security/token-encryption` — Fernet-style symmetric encryption
- `security/url-validator` — URL allowlist / blocklist validation
- `security/key-manager` — Pluggable key resolution interface
