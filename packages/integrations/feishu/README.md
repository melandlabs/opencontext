# @opencontext/integrations-feishu

[Feishu](https://www.feishu.cn/) (飞书, also known as Lark) integration for
OpenLoomi. Wraps the official [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk)
and provides app registration, registration-cookie flow, conversation
storage, and channel adapter glue.

## Installation

```sh
pnpm add @opencontext/integrations-feishu
```

## Subpath Exports

- `@opencontext/integrations-feishu` — Main entrypoint
- `@opencontext/integrations-feishu/app-registration` — App registration helper
- `@opencontext/integrations-feishu/registration-cookie` — Registration cookie flow
- `@opencontext/integrations-feishu/conversation-store` — Conversation persistence
- `@opencontext/integrations-feishu/state` — Runtime state container
