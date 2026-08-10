# @opencontext/integrations-weixin

[WeChat](https://www.wechat.com/) (微信) integration for OpenLoomi. Built on
the official
[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
SDK and ships helpers for QR login, CDN asset decryption, and iLink
reverse-engineered listeners.

## Installation

```sh
pnpm add @opencontext/integrations-weixin
```

## Subpath Exports

- `@opencontext/integrations-weixin` — Main entrypoint
- `@opencontext/integrations-weixin/ws-listener` — WebSocket listener for the
  iLink client
- `@opencontext/integrations-weixin/conversation-store` — Conversation
  persistence
- `@opencontext/integrations-weixin/ilink-client` — iLink protocol client
- `@opencontext/integrations-weixin/cdn/aes-ecb` — AES-ECB decryption helper
- `@opencontext/integrations-weixin/cdn/cdn-upload` — CDN upload helper
- `@opencontext/integrations-weixin/cdn/cdn-url` — CDN URL signing helper
- `@opencontext/integrations-weixin/cdn/pic-decrypt` — Decrypt CDN-hosted
  pictures
- `@opencontext/integrations-weixin/qr-login` — QR-code login flow
