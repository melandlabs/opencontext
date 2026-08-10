# @opencontext/search

Web search adapters used by the OpenLoomi agent. Currently includes a Brave
Search client; additional providers can be plugged in via the shared
interface.

## Installation

```sh
pnpm add @opencontext/search
```

## Subpath Exports

- `@opencontext/search` — Main entrypoint with the shared `SearchProvider`
  interface
- `@opencontext/search/brave` — [Brave Search](https://brave.com/search/api/)
  client implementation

## Environment

The Brave client reads `BRAVE_SEARCH_API_KEY` from the environment.
