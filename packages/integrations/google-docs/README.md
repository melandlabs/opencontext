# integrations-google-docs (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

[Google Docs](https://developers.google.com/docs) integration for OpenContext.
Built on the official `googleapis` SDK with OAuth credential management.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `GoogleDocsAdapter` — Channel adapter implementation
- `GoogleDocsClient` — Typed Docs REST client

## Peer Dependencies

- `react >=18.0.0` (for the React UI components)
