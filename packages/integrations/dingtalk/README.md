# integrations-dingtalk (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[DingTalk](https://www.dingtalk.com/) (钉钉) chat adapter for OpenContext.
Implements the common channel interface and lets bots send / receive
messages over DingTalk's Open Platform.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `DingTalkAdapter` — Channel adapter implementation
- DingTalk credential and webhook helpers
