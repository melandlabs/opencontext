# search (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


Web search adapters used by the OpenContext agent. Currently includes a Brave
Search client; additional providers can be plugged in via the shared
interface.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `search` — Main entrypoint with the shared `SearchProvider`
  interface
- `search/brave` — [Brave Search](https://brave.com/search/api/)
  client implementation

## Environment

The Brave client reads `BRAVE_SEARCH_API_KEY` from the environment.
