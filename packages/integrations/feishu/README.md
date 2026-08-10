# @openloomi/integrations-feishu

[Feishu](https://www.feishu.cn/) (飞书, also known as Lark) integration for
OpenLoomi. Wraps the official [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk)
and provides app registration, registration-cookie flow, conversation
storage, and channel adapter glue.

## Installation

```sh
pnpm add @openloomi/integrations-feishu
```

## Subpath Exports

- `@openloomi/integrations-feishu` — Main entrypoint
- `@openloomi/integrations-feishu/app-registration` — App registration helper
- `@openloomi/integrations-feishu/registration-cookie` — Registration cookie flow
- `@openloomi/integrations-feishu/conversation-store` — Conversation persistence
- `@openloomi/integrations-feishu/state` — Runtime state container
