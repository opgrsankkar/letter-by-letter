# DEPENDENCY-COMMANDS.md

Run every command below from the **root of this disposable checkout** (the
directory containing this file). These commands mutate manifests and lockfiles,
so **never** run them against the production tree (`/srv/apps/letter-by-letter`)
or any tree that is not a disposable worktree/checkout.

## Actual results already obtained in this disposable worktree

- `nanoid` removed from `server` — player IDs now use `crypto.randomUUID()`,
  room codes use `crypto.randomInt()`.
- In-range `npm update` and a **non-force** `npm audit fix` were applied.
  Lockfiles were regenerated **by npm only** and are not hand-edited.
- Fresh production audits:
  - `npm --prefix server audit --omit=dev` → **0 vulnerabilities** (89 prod deps)
  - `npm --prefix client audit --omit=dev` → **0 vulnerabilities** (20 prod deps)
- Installed runtime versions observed: express `4.22.3`, socket.io and
  socket.io-client `4.8.4`, engine.io `6.6.11`, socket.io-parser `4.2.7`,
  ws `8.21.3`, proxy-addr `2.0.8`, qs `6.16.1`.
- `npm audit fix --force` was **not** used and no lockfile was edited by hand.

## Commands (safe to re-run)

```bash
# 0) From the disposable checkout root (NOT the production tree).
cd <disposable-checkout>

# 1) Explicit CI installs (no manifest mutation).
npm ci --prefix server
npm ci --prefix client

# 2) Remove nanoid (no-op if already removed from package.json).
npm --prefix server uninstall nanoid

# 3) In-range refresh (patch/minor within declared ranges only).
npm --prefix server update
npm --prefix client update

# 4) Production audits — target is ZERO findings for both.
npm --prefix server audit --omit=dev
npm --prefix client audit --omit=dev

# 5) Apply only semver-compatible fixes (if any are still reported).
npm --prefix server audit fix
npm --prefix client audit fix

# 6) Full audits including dev-only tooling (informational — see below).
npm --prefix server audit
npm --prefix client audit

# 7) Confirm nanoid is gone from the server tree.
npm --prefix server ls nanoid || true

# 8) Build + isolated tests (`node --test tests/*.test.mjs`; no implicit install).
npm --prefix server run build
node --test tests/*.test.mjs
```

## Remaining dev-only findings (deliberately NOT force-fixed)

These are dev/build-time only; clearing them needs breaking majors, so they are
deferred and reported rather than forced:

| Workspace | Full-tree total | Source | Fix requires |
| --- | --- | --- | --- |
| server | 11 high | `@typescript-eslint/*` 7.x; `nodemon` → `chokidar` → `braces`; `fast-glob`/`globby`/`micromatch` | `@typescript-eslint` 7 → 8 (semver-major) and a `nodemon`/`braces` chain change |
| client | 9 (6 high, 3 moderate) | `vite` 5.x, `tailwindcss` 3.x, transitive `esbuild`, `postcss-selector-parser` | `vite` 5 → 8 and `tailwindcss` 3 → 4 (semver-major) |

No forced majors are applied now. If a future task approves the migrations,
they should be done in their own disposable checkout with build + test
re-verification.

## Acceptance criteria

- Step 7 prints no dependency named `nanoid` under `server/`.
- Step 4 prints `found 0 vulnerabilities` for both workspaces (production gate).
- Step 8 builds the server and passes `tests/*.test.mjs`.
- Report the raw output of steps 4 and 6; do not claim a clean audit without it.
- Never run `npm audit fix --force`.
