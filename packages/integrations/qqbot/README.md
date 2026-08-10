# integrations-qqbot (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

[QQ Bot](https://bot.q.qq.com/) (QQ机器人) adapter for OpenContext. Sends and
receives QQ guild / group messages through Tencent's open bot platform.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `QQBotAdapter` — Channel adapter implementation
