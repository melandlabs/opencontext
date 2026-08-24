# Releasing `@melandlabs/*` packages

One-pager for cutting a release. The full sequence runs **once per release**;
the order matters — `pnpm install` between `changeset version` and `git
commit` is what we got wrong in the 0.6.0 release and what broke CI on the
release commit.

## When

Whenever `.changeset/*.md` files exist on `main` that haven't been bundled
into a release. Check:

```bash
ls .changeset/*.md
```

## Sequence

```bash
# 1. Local: drain remaining changesets into versions + regenerate lockfile.
#    The `pnpm install` step is non-negotiable — without it CI fails on
#    `--frozen-lockfile` because package.json and pnpm-lock.yaml diverge.
pnpm version

# 2. Local: dry-run the publish to make sure the version bumps look right.
pnpm changeset status

# 3. Inspect the diff. The commit should include:
#    - .changeset/*.md  → deleted (consumed by `pnpm version`)
#    - */CHANGELOG.md   → a new "## <version>" entry per package
#    - */package.json   → "version" bumped
#    - pnpm-lock.yaml   → specifiers bumped to match the new versions
git status --short
git diff --stat

# 4. Push. The Release workflow on main takes it from here:
#    - ci.yml runs the failing-fast lockfile consistency check, then
#      lint / typecheck / build / test / smoke test
#    - release.yml picks up the CHANGELOG headers and `pnpm release` to
#      publish each non-private package to npm
git add -A
git commit -m "chore(release): ship <descriptive summary>"
git push origin main
```

## What CI does

1. **Fail-fast lockfile check** (`pnpm install --lockfile-only`) — sees
   the diff introduced by `pnpm version` and runs `git diff --exit-code
   pnpm-lock.yaml`. If the diff is non-empty, CI fails with a clear message
   instead of letting the broken lockfile reach `pnpm install
   --frozen-lockfile`. (See `.github/workflows/ci.yml`.)
2. **Build, typecheck, lint, smoke test** on the bumped versions.
3. **Release** workflow reads each `CHANGELOG.md`, runs `pnpm release`
   (build + `changeset publish`), and pushes the git tag.

## After publish

```bash
# Confirm the versions exist on npm with the expected `dist-tag: latest`.
npm view @melandlabs/memory-store version
npm view @melandlabs/opencontext version
```

If a package is missing the `latest` tag (e.g. `pnpm publish` uploaded it
as `staged`), promote it explicitly:

```bash
npm dist-tag add @melandlabs/<pkg>@<version> latest
```

## Roll back a bad release

`changeset publish` is **additive** — npm lets you delete a published
version within 72 hours (`npm unpublish`). Beyond that, deprecate:

```bash
npm deprecate @melandlabs/<pkg>@<bad-version> "yanked: <reason>"
```

Then revert git tags and `pnpm changeset` a follow-up that fixes the
regression. Never force-push tags out of `main`.

## Notes

- The repo uses `pnpm@10.14.0` — set `"packageManager"` in `package.json`
  if you bump it.
- All packages publish with `publishConfig.access: "public"`.
- The Release workflow **cannot** retroactively bump versions; if a release
  commit goes wrong, fix forward with another changeset.
