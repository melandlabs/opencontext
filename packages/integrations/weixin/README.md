# @openloomi/integrations-weixin

[WeChat](https://www.wechat.com/) (微信) integration for OpenLoomi. Built on
the official
[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
SDK and ships helpers for QR login, CDN asset decryption, and iLink
reverse-engineered listeners.

## Installation

```sh
pnpm add @openloomi/integrations-weixin
```

## Subpath Exports

- `@openloomi/integrations-weixin` — Main entrypoint
- `@openloomi/integrations-weixin/ws-listener` — WebSocket listener for the
  iLink client
- `@openloomi/integrations-weixin/conversation-store` — Conversation
  persistence
- `@openloomi/integrations-weixin/ilink-client` — iLink protocol client
- `@openloomi/integrations-weixin/cdn/aes-ecb` — AES-ECB decryption helper
- `@openloomi/integrations-weixin/cdn/cdn-upload` — CDN upload helper
- `@openloomi/integrations-weixin/cdn/cdn-url` — CDN URL signing helper
- `@openloomi/integrations-weixin/cdn/pic-decrypt` — Decrypt CDN-hosted
  pictures
- `@openloomi/integrations-weixin/qr-login` — QR-code login flow
