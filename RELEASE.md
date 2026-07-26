# dMemo release checklist (human steps)

This is the exact sequence a human operator runs to actually publish dMemo.
Nothing in this repo runs any of these steps automatically — `scripts/publish.mjs`
defaults to a dry run and refuses to publish for real without two explicit
flags (`--live --yes-i-am-sure`). No GitHub repo has been created and no npm
publish has ever been executed as part of building this pipeline.

## 0. Pre-flight (once)

- [x] **An npm organization named `dmemo` is a hard prerequisite, not an
      optional nicety.** An earlier version of this checklist said scopes
      are "claimed implicitly by first publish" — that is wrong and would
      have failed the release at package one. A scope belongs to you
      automatically only when it matches your npm *username*; `@dmemo` does
      not match, so without an org named `dmemo` the first `@dmemo/*`
      publish is rejected outright. Five of the six packages are `@dmemo/*`.
      Org created 2026-07-26 at https://www.npmjs.com/org/create (Free plan
      — public packages only, which is what we want).
- [ ] `npm whoami` — confirm you're logged in, and `npm org ls dmemo` —
      confirm your account is a member of the `dmemo` org with publish
      rights. `npm login` is interactive and cannot be run unattended.
- [ ] Confirm 2FA/OTP is set up on the npm account if publishes require it
      (pass `--otp=123456` to `scripts/publish.mjs` if so).
- [x] **GitHub org: `dmemo-ai`** (decided 2026-07-26). Repos `dmemo-ai/dmemo`
      and `dmemo-ai/claude-dmemo`. This matches what every `package.json`
      `repository` field, `claude-dmemo/plugin/.claude-plugin/plugin.json`,
      and `MARKETPLACE_SOURCE` in
      `packages/setup-cli/src/installers/claudeCode.ts` already hardcode —
      audited 2026-07-26, no grep-replace needed. The org does not exist yet;
      creating it is step 1.
- [x] **Release version: `0.1.0` for all six npm packages and
      `plugin.json`** (decided 2026-07-26). `packages/setup-cli` was at
      `0.2.0` and is moved down to match; nothing is published, so no
      version is being reused.
- [ ] Registry names confirmed free as of 2026-07-26 — `dmemo` and every
      `@dmemo/*` return 404 on npm, `dmemo-hermes` returns 404 on PyPI.
      Re-check right before publishing if much time has passed.

## 1. Create and push the main GitHub repo

- [x] `dmemo-ai` GitHub org created 2026-07-26 (free plan).
- [x] **Done 2026-07-26.** `toomingos/dMemo` was *transferred* (not
      re-pushed) into the org and renamed to lowercase in the same
      operation:
      `gh api -X POST repos/toomingos/dMemo/transfer -f new_owner=dmemo-ai -f new_name=dmemo`
      Transfer rather than a fresh push, so history/issues/stars survive and
      GitHub leaves a permanent redirect from the old URL — verified, the
      old path now resolves to `dmemo-ai/dmemo`. Renamed to lowercase
      because all seven `package.json` `repository` fields hardcode
      `github.com/dmemo-ai/dmemo`, and npm echoes that URL verbatim on the
      package page. Note the transfer API is **asynchronous** — it returns
      the *old* `full_name` with a 202; re-query `repos/dmemo-ai/dmemo` to
      confirm rather than trusting the response body.
- [x] Local `origin` re-pointed to `https://github.com/dmemo-ai/dmemo.git`.
- [ ] Push the pending working-tree changes (installer rewrites, RELEASE.md,
      `.gitignore` fix, `claude-dmemo/` LICENSE+README). Nothing is pushed
      yet — the repo on GitHub is still at commit `5c0d3b7`.
- [ ] Confirm `LICENSE`, `TASKS.md`, `packages/*` all land in the repo as
      expected (nothing in `.gitignore` should exclude source you need).

## 2. Create and push the Claude Code marketplace repo

- [x] `github.com/dmemo-ai/claude-dmemo` created 2026-07-26, public, and
      currently **empty** (no commits pushed yet). Matches
      `MARKETPLACE_SOURCE` in `packages/setup-cli/src/installers/claudeCode.ts`
      and `homepage`/`repository` in
      `claude-dmemo/plugin/.claude-plugin/plugin.json`.
- [ ] `cd claude-dmemo && git init`, commit, push. This repo's layout is
      already correct and verified (see step 5 below) — it just needs to
      exist on GitHub and be public so `claude plugin marketplace add
      dmemo-ai/claude-dmemo` can clone it. **Claude Code requires
      `.claude-plugin/marketplace.json` at the repo ROOT**, which is why this
      has to be its own repo and cannot be resolved as a subdirectory of the
      monorepo.
- [ ] Rebuild the vendored hook scripts fresh right before this push:
      `pnpm --filter @dmemo/node-adapter run build` (writes into
      `claude-dmemo/plugin/scripts/`) — do this from the monorepo root so
      the shipped `.cjs` bundles reflect the exact code being released, not
      a stale build.
- [ ] Confirm `plugin/scripts/node_modules` is NOT in the commit. It is a
      symlink the plugin regenerates at runtime pointing at the builder's
      own machine (`native-bootstrap.ts`, `linkNodeModulesShim`), and it was
      committed by accident once already — the root `.gitignore`'s
      `node_modules/` pattern is directory-only and does not match a
      symlink. `claude-dmemo/.gitignore` now covers this in both contexts
      (monorepo and standalone). Verified 2026-07-26: a fresh `git init` +
      `git add -A` in a copy of this directory tracks 17 files and zero
      `node_modules` entries.
- [x] `LICENSE` (MIT, copied from the monorepo root) and `README.md` were
      added 2026-07-26. The monorepo's copies do not travel with this
      directory once it is its own repo, and a public marketplace repo with
      neither is a bad first impression.

## 3. npm login

- [ ] `npm login` (interactively) or `npm config set //registry.npmjs.org/:_authToken=<token>`
      in CI. `scripts/publish.mjs` shells out to `pnpm publish`, which uses
      whatever npm auth is already configured in the environment — it does
      not prompt for credentials itself.

## 4. Dry run (always do this first, even though it's the script's default)

```bash
cd /Users/tomasdomingos/dMemo
node scripts/publish.mjs
```

- [x] Confirm all 6 packages print `(dry-run)` tarball listings with no
      errors, in this order: `@dmemo/blob-spec` → `@dmemo/core` →
      `@dmemo/sdk-wrappers` → `@dmemo/opencode-plugin` →
      `@dmemo/openclaw-plugin` → `dmemo` (the setup-cli package, published
      as bare `dmemo` per its `package.json` `name` field, not
      `@dmemo/setup-cli`). **Verified 2026-07-26**: exit 0, all six at
      `0.1.0`, correct order, no errors.
- [x] Spot-check each tarball's file list for the files you expect (`dist/`,
      `README.md`, `LICENSE`, plus `SPEC.md` for blob-spec,
      `openclaw.plugin.json` for openclaw-plugin, `vendor/` for setup-cli)
      and the absence of `.test.js`/`.test.d.ts` files. **Verified
      2026-07-26**: zero `.test.` files across all six tarballs — the
      `files` negation patterns in `packages/setup-cli/package.json` do
      cover nested paths like `dist/installers/*.test.js`.
- [x] Confirm `@dmemo/core`'s packed `package.json` shows
      `"@dmemo/blob-spec": "0.1.0"` (a real version), not
      `"workspace:*"` — `pnpm publish`/`pnpm pack` rewrite this
      automatically; a raw `npm publish` from inside the package dir would
      NOT rewrite it and would produce a broken published package. Always
      publish via `pnpm publish` (or this script, which calls it), never
      raw `npm publish`. **Verified 2026-07-26** by unpacking real
      `pnpm pack` tarballs — every cross-package dep is rewritten:
      `@dmemo/core` → `blob-spec 0.1.0`; `@dmemo/opencode-plugin` and
      `@dmemo/openclaw-plugin` → `core 0.1.0`. `@dmemo/sdk-wrappers` and
      `dmemo` have no `@dmemo/*` runtime deps at all (setup-cli ships the
      engine as prebuilt `vendor/` bundles instead).

## 5. Verify the Claude Code marketplace repo structure once more

```bash
find claude-dmemo -type f | sort
cat claude-dmemo/.claude-plugin/marketplace.json   # "source": "./plugin", name "dmemo-plugins"
cat claude-dmemo/plugin/.claude-plugin/plugin.json # name "dmemo", version matches release
```

- [ ] `marketplace.json`'s `plugins[0].source` is `"./plugin"` (relative,
      confirmed already present).
- [ ] `plugin.json`'s `version` matches the npm packages' version being
      released (currently `0.1.0` everywhere — bump both together).

## 6. Live publish

```bash
cd /Users/tomasdomingos/dMemo
node scripts/publish.mjs --live --yes-i-am-sure
# with 2FA: node scripts/publish.mjs --live --yes-i-am-sure --otp=123456
```

- [ ] Watch the output — the script stops immediately on the first failed
      package rather than skipping ahead (order matters: don't publish
      `@dmemo/core` before `@dmemo/blob-spec` is live, or `npm install` of
      core will fail for every early adopter until blob-spec exists).
- [ ] After it finishes, `npm view @dmemo/blob-spec version`, `npm view
      @dmemo/core version`, `npm view @dmemo/sdk-wrappers version`, `npm
      view @dmemo/opencode-plugin version`, `npm view @dmemo/openclaw-plugin
      version`, `npm view dmemo version` — confirm all six now resolve on
      the registry.

## 7. Smoke test the real, published thing

- [ ] In a throwaway directory (NOT this repo), run
      `npx dmemo@0.1.0 setup` for real, with a real (freshly generated or
      test) wallet, against testnet. Confirm it installs cleanly end to
      end. This is the only step that can't be fully verified by dry runs —
      it depends on the actual npm registry and a real `npx` resolution.
- [ ] In a Claude Code session, run `/plugin marketplace add
      dmemo-ai/claude-dmemo` then `/plugin install dmemo@dmemo-plugins`
      (or `claude plugin marketplace add` / `claude plugin install` from
      the CLI) and confirm the plugin installs and its hooks fire.

## 8. Announce / tag

- [ ] `git tag v0.1.0 && git push --tags` on both repos.
- [ ] Whatever announcement channel — not scripted here.

## What is NOT covered by automation

- Creating the npm `@dmemo` scope/org — first-publish-claims-it for a plain
  scope; an npm **organization** (for multiple human publishers) must be
  created manually on npmjs.com.
- Creating either GitHub repo — `git init`/`gh repo create`/push are manual,
  on purpose (no credentials exist in this environment to do it safely).
- npm login/auth token provisioning.
- The `pc.0g.ai` inference-leg sign-in flow (T4.1 accepted gap) — this is
  printed as instructions to the end user by `npx dmemo setup`, not
  something the release pipeline touches.
