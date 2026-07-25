# dMemo release checklist (human steps)

This is the exact sequence a human operator runs to actually publish dMemo.
Nothing in this repo runs any of these steps automatically — `scripts/publish.mjs`
defaults to a dry run and refuses to publish for real without two explicit
flags (`--live --yes-i-am-sure`). No GitHub repo has been created and no npm
publish has ever been executed as part of building this pipeline.

## 0. Pre-flight (once)

- [ ] `npm whoami` — confirm you're logged into the correct npm account/org
      that owns the `@dmemo` scope (or claim the scope first: the first
      publish of any `@dmemo/*` package creates the org-scoped package;
      npm scopes themselves are claimed implicitly by first publish, but if
      you want a shared npm **organization** named `dmemo` for multiple
      publishers, create that at https://www.npmjs.com/org/create first).
- [ ] Confirm 2FA/OTP is set up on the npm account if publishes require it
      (pass `--otp=123456` to `scripts/publish.mjs` if so).
- [ ] Decide the real GitHub org/user that will own the source repos. This
      repo's `package.json` `repository` fields and the plugin marketplace
      installer both hardcode `dmemo-ai` (repos `dmemo-ai/dmemo` and
      `dmemo-ai/claude-dmemo`) — if the real org differs, grep-replace
      `dmemo-ai` across `packages/*/package.json` and
      `packages/setup-cli/src/installers/claudeCode.ts`'s
      `MARKETPLACE_SOURCE` constant before publishing, or the marketplace
      install command and repo links will point at a nonexistent/wrong repo.

## 1. Create and push the main GitHub repo

- [ ] Create `github.com/dmemo-ai/dmemo` (or your real org/name).
- [ ] `git init` this monorepo (`/Users/tomasdomingos/dMemo`) if not already
      a git repo, commit everything, add the remote, push `main`.
- [ ] Confirm `LICENSE`, `TASKS.md`, `packages/*` all land in the repo as
      expected (nothing in `.gitignore` should exclude source you need).

## 2. Create and push the Claude Code marketplace repo

- [ ] Create `github.com/dmemo-ai/claude-dmemo` (must match
      `MARKETPLACE_SOURCE` in `packages/setup-cli/src/installers/claudeCode.ts`
      and `homepage`/`repository` in
      `claude-dmemo/plugin/.claude-plugin/plugin.json`).
- [ ] `cd claude-dmemo && git init`, commit, push. This repo's layout is
      already correct and verified (see step 5 below) — it just needs to
      exist on GitHub and be public so `claude plugin marketplace add
      dmemo-ai/claude-dmemo` can clone it.
- [ ] Rebuild the vendored hook scripts fresh right before this push:
      `pnpm --filter @dmemo/node-adapter run build` (writes into
      `claude-dmemo/plugin/scripts/`) — do this from the monorepo root so
      the shipped `.cjs` bundles reflect the exact code being released, not
      a stale build.

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

- [ ] Confirm all 6 packages print `(dry-run)` tarball listings with no
      errors, in this order: `@dmemo/blob-spec` → `@dmemo/core` →
      `@dmemo/sdk-wrappers` → `@dmemo/opencode-plugin` →
      `@dmemo/openclaw-plugin` → `dmemo` (the setup-cli package, published
      as bare `dmemo` per its `package.json` `name` field, not
      `@dmemo/setup-cli`).
- [ ] Spot-check each tarball's file list for the files you expect (`dist/`,
      `README.md`, `LICENSE`, plus `SPEC.md` for blob-spec,
      `openclaw.plugin.json` for openclaw-plugin, `vendor/` for setup-cli)
      and the absence of `.test.js`/`.test.d.ts` files.
- [ ] Confirm `@dmemo/core`'s packed `package.json` shows
      `"@dmemo/blob-spec": "0.1.0"` (a real version), not
      `"workspace:*"` — `pnpm publish`/`pnpm pack` rewrite this
      automatically; a raw `npm publish` from inside the package dir would
      NOT rewrite it and would produce a broken published package. Always
      publish via `pnpm publish` (or this script, which calls it), never
      raw `npm publish`.

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
