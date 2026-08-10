# integrations-feishu (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[Feishu](https://www.feishu.cn/) (飞书, also known as Lark) integration for
OpenContext. Wraps the official [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk)
and provides app registration, registration-cookie flow, conversation
storage, and channel adapter glue.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `integrations-feishu` — Main entrypoint
- `integrations-feishu/app-registration` — App registration helper
- `integrations-feishu/registration-cookie` — Registration cookie flow
- `integrations-feishu/conversation-store` — Conversation persistence
- `integrations-feishu/state` — Runtime state container
