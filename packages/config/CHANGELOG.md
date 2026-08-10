# @melandlabs/config

## 0.1.1

### Patch Changes

- Repair broken `exports` paths that blocked ESM resolution:

  - `@melandlabs/config`: ship CJS at the published entry point (tsup only
    emits `.cjs` because `src/eslint.js` uses `module.exports` while the
    package is `"type": "module"`).
  - `@melandlabs/i18n`: `./locales/{en-US,zh-Hans}` now point to the
    flat `dist/locales-{en-US,zh-Hans}.js` files that tsup emits.
  - `@melandlabs/indexeddb`: drop the stale `./storage` export (the file
    was never built).
  - `@melandlabs/integrations-gmail`: add missing `"."` export so the
    package's main entry resolves under Node 22 ESM.
  - `@melandlabs/integrations-telegram`: `./tdata-decrypter` now points
    to `dist/tdata-decrypter-index.js`.
  - `@melandlabs/integrations-weixin`: `./cdn/*` now points to the flat
    `dist/cdn-*.js` files.
  - `@melandlabs/opencontext`: add missing `"."` export.
  - `@melandlabs/search`: `./brave` now points to `dist/brave-index.js`.
  - `@melandlabs/storage`: `./adapters`, `./adapters/local-fs`,
    `./adapters/vercel-blob` now point to the flat
    `dist/adapters-*.js` files.
