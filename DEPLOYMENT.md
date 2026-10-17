# Letter by Letter — Containerized Deployment

This document covers building, verifying, cutting over to, and rolling back the
containerized deployment of **Letter by Letter**.

## Division of responsibility

| Owner | Does |
| --- | --- |
| **Worker (artifact generation)** | Produces `Dockerfile`, `.dockerignore`, `compose.yaml`, `homelab-letter-by-letter.service`, `smoke-test.mjs`, and this document. No reset, no `git push`, no deploy, no host mutation. |
| **Hermes (host execution)** | Copies the **full original source tree** plus these generated artifacts into `/srv/apps/letter-by-letter`, runs host-only Docker/systemd commands, and performs browser verification. |

The worker never touches the running system. The commands below are for Hermes
to run on the host (or for a human operator).

---

## 1. Artifacts

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage build: client build, server build, production-only deps, hardened non-root runtime. |
| `.dockerignore` | Keeps git, `node_modules`, `dist`, env/secrets, and logs out of the build context. |
| `compose.yaml` | Production service `letter-by-letter`, image `letter-by-letter:local`, port `4000`, hardening, log rotation. |
| `homelab-letter-by-letter.service` | systemd oneshot unit template that runs `docker compose up -d` at boot (never builds). |
| `smoke-test.mjs` | End-to-end HTTP + Socket.IO verification against a running server. |
| `tests/integration.test.mjs` | Isolated `node:test` + `socket.io-client` suite; forks the compiled server on an ephemeral port with injected limits. |
| `server/src/validation.ts` | Runtime validation + quota/rate-limit helpers for the socket boundary. |
| `DEPENDENCY-COMMANDS.md` | Exact npm commands to remove `nanoid`, refresh dependencies, and audit. |
| `ops/host-cache-cleanup.service`, `ops/host-cache-cleanup.timer` | Host-only systemd templates that prune UNUSED Docker build cache (global scope). |
| `DEPLOYMENT.md` | This document. |

### Image contents (runtime stage)

```
/app/server/dist            # compiled server (main: dist/index.js)
/app/server/words_list.txt  # read by GET /random-word
/app/server/package.json
/app/server/node_modules    # production deps only (npm ci --omit=dev)
/app/client/dist            # built SPA
```

The source layout is preserved on purpose: `server/dist/index.js` serves the
SPA from `path.resolve(__dirname, '../../client/dist')`, which resolves to
`/app/client/dist`. The other candidate path, `/app/server/dist/static`, is
absent, so the external `client/dist` is used.

Runtime hardening: non-root `node` user, `read_only: true` root filesystem,
`tmpfs` on `/tmp`, `cap_drop: ALL`, `no-new-privileges:true`, `init: true`,
`restart: unless-stopped`, JSON log rotation (`5m` × `2`), and **no memory cap**.
The container is stateless on disk (rooms live in memory only), so a read-only
filesystem is safe.

---

## 2. Prerequisites (host)

- Docker Engine with the Compose v2 plugin (`docker compose`).
- The original `letter-by-letter.service` and its old source tree are left
  **untouched** — they are the rollback target.
- Caddy continues to reverse-proxy **`172.17.0.1:4000`**. The compose port
  mapping is deliberately *not* bound to `127.0.0.1`, so it stays reachable from
  other containers via the docker bridge gateway.

---

## 3. Build

```bash
cd /srv/apps/letter-by-letter
docker compose build          # builds image letter-by-letter:local (both npm ci + builds)
```

`docker compose build` runs `npm ci` in the client and server workspaces, builds
both, installs server production-only dependencies, and assembles the runtime
image. Requires network access on the host (npm registry) — expected during
build, not at boot.

---

## 4. Candidate verification (before cutover)

Run the candidate on a **separate host port** so the current production stack
keeps serving 4000.

```bash
cd /srv/apps/letter-by-letter
# Candidate on an alternate port, image tag, container name, AND compose
# project name so the running production stack/container/image is never touched.
LETTER_PORT=14000 \
  LETTER_IMAGE=letter-by-letter:candidate \
  LETTER_CONTAINER_NAME=letter-by-letter-candidate \
  docker compose -p letter-by-letter-candidate up -d --build
docker compose -p letter-by-letter-candidate ps
docker compose -p letter-by-letter-candidate logs --tail=50 letter-by-letter
```

The env overrides are optional and default to the production values, so plain
`docker compose up -d` is unchanged. A candidate **must** use a different
`-p` project name: the project name scopes compose labels and the network, so
reusing the production project would recreate the production service even with
a different `container_name`.

Then verify:

```bash
# HTTP + Socket.IO end-to-end (uses client's socket.io-client)
node smoke-test.mjs http://127.0.0.1:14000

# Or explicitly
SMOKE_URL=http://127.0.0.1:14000 node smoke-test.mjs
```

The smoke test:

- checks `GET /health` → `{ "status": "ok" }`
- checks `GET /random-word` → non-empty word
- checks `GET /` → serves `index.html` (proves the client build is included)
- connects **3 players** over **websocket-only** transport, creates/joins a room,
  starts a round, and has the selected host submit `ORANGE`
- asserts the two non-host players' letters **collectively spell ORANGE** and
  that the host — and only the host — receives `host_word === "ORANGE"`
- enforces a hard 30 s timeout, exits **non-zero** on any failure, and always
  disconnects every socket

**Browser verification (Hermes, on the host):** open `http://<host>:14000/`,
confirm the UI loads, create a room, join from 2–3 devices/tabs, start a round,
and confirm letter distribution and host word display work. Also confirm the
proxied path once Caddy points at the chosen port.

Tear the candidate down when done (same project name and overrides so compose
targets the candidate):

```bash
LETTER_PORT=14000 \
  LETTER_IMAGE=letter-by-letter:candidate \
  LETTER_CONTAINER_NAME=letter-by-letter-candidate \
  docker compose -p letter-by-letter-candidate down
```

---

## 5. Cutover

```bash
# 1. Stop the ORIGINAL user service (do not delete it — rollback target).
sudo systemctl stop letter-by-letter.service

# 2. Ensure the image exists (service does NOT build at boot).
cd /srv/apps/letter-by-letter
docker compose build

# 3. Install / refresh the systemd unit template.
sudo cp homelab-letter-by-letter.service /etc/systemd/system/homelab-letter-by-letter.service
sudo systemctl daemon-reload
sudo systemctl enable --now homelab-letter-by-letter.service

# 4. Confirm production on 4000.
docker compose ps
node smoke-test.mjs http://127.0.0.1:4000
curl -fsS http://172.17.0.1:4000/health   # from a network-namespaced context if desired
```

The unit is `Type=oneshot` + `RemainAfterExit=yes`, `Requires=docker.service`,
`After=network-online.target docker.service`,
`RequiresMountsFor=/srv/apps/letter-by-letter`, `WorkingDirectory=/srv/apps/letter-by-letter`.
`ExecStart` is `docker compose up -d` (no build) and `ExecStop` is
`docker compose down`.

Finally, reload Caddy (unchanged config should already point at
`172.17.0.1:4000`):

```bash
sudo systemctl reload caddy
```

---

## 6. Rollback

Fully reversible; the original source and unit were preserved.

```bash
# 1. Bring the containerized stack down.
sudo systemctl stop homelab-letter-by-letter.service
sudo systemctl disable homelab-letter-by-letter.service   # optional

# 2. Restart the ORIGINAL user-source service.
sudo systemctl start letter-by-letter.service
sudo systemctl status letter-by-letter.service

# 3. Verify.
curl -fsS http://127.0.0.1:4000/health
sudo systemctl reload caddy
```

**Preserve the original deployment.** Do not delete the old `letter-by-letter`
source tree (the user "Projects" checkout) or the existing
`/etc/systemd/system/letter-by-letter.service`. If that working tree has
uncommitted/dirty changes, leave them exactly as-is — they are the rollback
source of truth. No `git reset`, no `git push`, and no redeploy of the original
should be performed by the worker.

---

## 7. Benefits

- **Reproducible.** Node 24 and exact dependency versions come from
  `package-lock.json` via `npm ci`; the host's Node version is irrelevant.
- **Isolated.** The app no longer shares the host runtime with other services;
  production dependencies only.
- **Consistent builds.** Client (`vite build`) and server (`tsc`) are compiled
  in-image, so no stale `dist/` can leak in (excluded by `.dockerignore`).
- **Hardened by default.** Non-root user, read-only root FS, `tmpfs /tmp`,
  dropped capabilities, `no-new-privileges`, `init: true` for correct signal
  handling (so WebSocket connections close cleanly on stop).
- **Observable.** Built-in HTTP `/health` healthcheck (Node only, no `curl`)
  reports container health for monitoring; `restart: unless-stopped` restarts
  the container **only when the process exits**, not on unhealthy health
  status alone; bounded JSON logs (`5m`, 2 files).
- **Fast, safe cutover/rollback.** One `systemctl stop/start` swaps implementations.
- **Verifiable.** `smoke-test.mjs` reproduces a real 3-player round end-to-end.

---

## 8. Limitations

- **In-memory state only.** Rooms/rounds live in process memory. Restarting the
  container (or `docker compose down`) loses all active rooms; there is no
  persistence and no graceful room migration.
- **Single instance.** No shared session store means the service cannot be
  horizontally scaled — multiple replicas would not share rooms.
- **Rebuild to update code.** Since boot never builds, any source change requires
  `docker compose build` followed by `docker compose up -d --no-build --force-recreate`
  (or a unit restart). A plain `docker compose restart` does **not** recreate the
  container with the newly built image — restart only restarts the existing container.
- **Public port binding.** Published on `0.0.0.0` (required so Caddy's
  `172.17.0.1:4000` target works). Firewall/Caddy must remain the access control
  boundary; the app itself has permissive CORS (`origin: '*'`).
- **Read-only filesystem.** Anything needing local disk writes must use `/tmp`
  (tmpfs) or a mounted volume; the app currently needs neither.
- **Smoke test needs host Node + client deps.** It resolves `socket.io-client`
  from `client/package.json`, so run it from the repo root where `client/` exists
  (its `node_modules` must be installed on the host only for the test).
- **Build-time network.** `npm ci` needs registry access during build.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Smoke test: `GET / did not return an HTML document` | Client build missing in image; confirm `client-builder` stage ran and `.dockerignore` doesn't exclude needed sources. |
| Smoke test: connect timeouts | Wrong URL/port, or the service isn't listening on `0.0.0.0`. Check `docker compose logs`. |
| `/random-word` 500s | `server/words_list.txt` not present in the image (must be copied into the runtime stage). |
| Caddy gets 502 | Mapping bound to loopback, or Caddy not targeting `172.17.0.1:4000`. The mapping must stay `0.0.0.0:4000->4000`. |
| Container restarts at boot only | Image not built before enabling the unit; run `docker compose build` first. |
| Healthcheck unhealthy but app works | `PORT` env differs from the port the server listens on; compose sets `PORT=4000`. |

---

## 10. Dependency hygiene, tests, and Docker build-cache discipline

### 10.1 Dependencies and audits

`nanoid` was removed from the server (player IDs now use the Node built-in
`crypto.randomUUID()`, room codes use `crypto.randomInt()`). The exact npm
commands to remove it, refresh in-range dependencies, and run fresh audits are
in `DEPENDENCY-COMMANDS.md`. The lockfiles are regenerated **only** by those
commands and are never hand-edited.

Production audit gate (target `0` findings) — fresh results from this
disposable worktree:

```bash
npm --prefix server audit --omit=dev   # 0 vulnerabilities (89 prod deps)
npm --prefix client audit --omit=dev   # 0 vulnerabilities (20 prod deps)
```

Remaining **dev-only** graph findings (informational, no forced majors):

- server full tree: **11 high** — all in the dev lint/watch graph
  (`@typescript-eslint/{eslint-plugin,parser,type-utils,typescript-estree,utils}`,
  `nodemon` → `chokidar` → `braces`, `fast-glob`/`globby`/`micromatch`).
  Clearing them requires `@typescript-eslint` 7 → 8 (major) and a
  `nodemon`/`braces` chain change; deferred, not force-applied.
- client full tree: **9 total (6 high, 3 moderate)** — `vite` 5 → 8,
  `tailwindcss` 3 → 4, plus transitive `esbuild` and `postcss-selector-parser`.
  All dev/build-time only; deferred, not force-applied.

Never run `npm audit fix --force`; record raw output instead.

### 10.2 Automated integration tests

Test prerequisites are explicit and mutate nothing during the test:

```bash
npm ci --prefix server     # once, on the disposable worktree
npm ci --prefix client     # provides socket.io-client for the suite
npm test                   # builds the server, then runs tests/*.test.mjs
npm run test:integration   # runs tests only (server/dist must be built)
```

`npm test` runs `npm --prefix server run build` and then
`node --test tests/*.test.mjs`; it does no implicit installs.

`tests/integration.test.mjs` uses `node:test` + `socket.io-client`. Every test
**forks the compiled server** (`server/dist/index.js`) on `PORT=0` bound to
`127.0.0.1` (loopback only) with per-test injected limits, so it never talks to
production or a public interface. Cleanup disconnects all clients and terminates
each server (`SIGTERM`, then `SIGKILL`), startup failures/timeouts also kill the
child, and every test carries a bounded timeout. Coverage: missing/invalid ACKs,
malformed and oversized inputs, invalid names/codes, host-only `submit_word`,
the 8-player cap, the global room cap, per-socket membership limits, event rate
limiting, connection quota, disconnect cleanup/host reassignment, and a full
valid 3-player round (letter distribution, host word, points, next round).

### 10.3 Docker build cache (host storage budget)

The host is storage-limited: **do not retain large Docker build caches for any
project**. After any `docker compose build` / `docker build`, prune *unused*
build cache (images, containers, volumes, and app data are untouched):

```bash
docker buildx prune --all --force
```

This removes all unused build cache; cache currently used by active builds is
not removed. `ops/host-cache-cleanup.service` +
`ops/host-cache-cleanup.timer` automate a daily (plus boot-delayed) sweep in
global scope. The unit runs exactly the command above via the absolute path
`/usr/bin/docker`, never restarts Docker or any container, and removes only
unused build cache.

Hermes reviews the templates before installing:

```bash
command -v docker   # expect /usr/bin/docker
sudo cp ops/host-cache-cleanup.service /etc/systemd/system/
sudo cp ops/host-cache-cleanup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now host-cache-cleanup.timer
systemctl list-timers host-cache-cleanup.timer
```
