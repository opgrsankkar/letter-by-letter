# Letter by Letter

A word party game for people in the same room, played on everyone's phone.

Each round one player gives the clues. They pick a secret word, and its letters
are shuffled and dealt to everyone else, a few each. Letter holders hint at their
letters out loud, the clue-giver hints at the whole word, and the table shouts
guesses. The clue-giver taps whoever got it first, and that player's team (Ember
or Tide) scores. All the talking happens out loud; the app only deals the cards
and keeps score.

## What the app does

- **Rooms**: four-character codes (no look-alike characters), a QR code and a
  `/r/CODE` invite link. Up to 10 players per room.
- **Teams**: new players join the smaller team. Players can switch or shuffle
  teams between rounds.
- **Fair rotation**: everyone gives clues once before anyone goes twice, and
  nobody gives clues twice in a row.
- **Word deck**: six categories to draw from, or type your own word (3–20
  letters, A–Z).
- **Privacy**: each phone gets its own view. Holders see only their own letters,
  face down until tapped. The clue-giver sees the word and who holds what.
  Everyone else sees the word only at the reveal.
- **Survives flaky phones**: a seat token in `localStorage` brings a player back
  to the same seat, letters and score after a refresh or reconnect. If the
  clue-giver drops off, anyone can skip their turn.
- **Optional timer** (1–3 minutes) and a screen wake lock while a game runs.

## Layout

```
src/shared/   protocol types, validation, word deck (used by both sides)
src/server/   game.ts: pure engine · server.ts: HTTP + WebSocket · main.ts: entry
src/client/   Preact UI (Vite), hand-written CSS, self-hosted fonts
tests/        engine unit tests, server integration tests, browser e2e
```

The server is plain Node 24 running TypeScript directly (type stripping), with
`ws` as its only runtime dependency. It sends every player a personalised view
after each change. Secrets never go out in a shared broadcast.

## Develop

Node 24 or newer.

```bash
npm ci
npm run dev        # server on :4000, Vite on :5173 (proxies /ws)
npm run check      # typecheck + unit/integration tests + browser e2e
```

The e2e test drives three phones in headless Chromium. It finds a
Playwright-managed Chromium in `~/.cache/ms-playwright` or a system Chrome, or
uses `CHROME_PATH`. Screenshots of each phase land in `test-results/`.

Runtime settings (env): `PORT` (4000), `HOST` (0.0.0.0), `MAX_ROOMS` (200),
`MAX_CONNECTIONS` (1000), `ABANDON_AFTER_MIN` (15: delete a room nobody is
connected to), `AWAY_AFTER_MIN` (30: drop a player who has been gone that long),
`RATE_BURST` / `RATE_PER_SECOND` (20 / 5 messages per socket).

## Deploy (x1c homelab)

Production runs from `/srv/apps/letter-by-letter` as the `letter-by-letter`
container. Caddy reaches it on the `letter-by-letter_default` network at
`letter-by-letter:4000`, served as `letter-by-letter.happydaysblr.ddns.net`.
`homelab-letter-by-letter.service` runs `docker compose up -d` at boot and
never builds.

```bash
cd /srv/apps/letter-by-letter
git pull --ff-only
sudo docker compose build --build-arg IMAGE_REVISION=$(git rev-parse --short HEAD)
sudo docker compose up -d --no-build --force-recreate
curl -fsS https://letter-by-letter.happydaysblr.ddns.net/health
sudo docker buildx prune --all --force   # x1c is storage-limited
```

Rooms live in memory, so a redeploy ends games in progress. To roll back, check
out the previous commit and repeat the build and up steps.
