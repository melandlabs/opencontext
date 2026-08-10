# insights (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Pure algorithm and filter logic for insight/event management.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `eventRank()` - Event ranking algorithm
- `focusClassifier` - Focus classification
- Filter schemas (Zod)
- Filter utilities (`insightMatchesFilter`, `filterInsights`)
- Option normalizers

## Note

Uses a minimal `InsightBase` interface. Implement the `InsightRepository` pattern to adapt to your data source.
