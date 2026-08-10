# rss (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


RSS feed parsing, OPML support, and tagging utilities.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- RSS normalization functions
- OPML parsing and generation
- RSS tagging utilities

## Peer Dependencies

Requires `react >=18.0.0`.
