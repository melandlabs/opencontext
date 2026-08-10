# hooks (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

A collection of pure React hooks.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Hooks

- `useLocalStorage` - SSR-safe localStorage hook
- `useIsMobile` - Mobile device detection
- `useOnClickOutside` - Click outside detection
- `useCustomEvent` - Custom DOM event listener
- `useMobileBottomSpacing` - Mobile bottom spacing measurement
- `useEnterSendWithIme` - IME-safe Enter-to-send hook
- `usePullToRefresh` - Pull-to-refresh gesture hook
- `useScrollToBottom` - Scroll-to-bottom with SWR state management

## Peer Dependencies

Requires `react >=18.0.0` and `swr >=2.0.0`.
