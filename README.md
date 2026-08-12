# xqueue

A **single-user** X/Twitter post scheduler. Write posts, queue them, and a
Cloudflare cron drips the queue out on your interval (1 / 3 / 6 / 9 / 12 / 24 h,
or paused). Self-host on Cloudflare Workers + D1 — no always-on server.

This is not a multi-tenant SaaS. **You deploy your own instance** with your own
X credentials and passphrase.

## Try the demo

Open playground — **no passphrase**, not connected to any real X account:

**https://xqueue-demo.lukas-genis.workers.dev**

Posts are faked, the queue is a **separate** D1 with sample dummy text, and no
X secrets are configured. Same repo as production; only a second deploy target
(`wrangler.demo.toml`).

```sh
# re-deploy the public demo (maintainers)
npx wrangler deploy --config wrangler.demo.toml
```

## Why it’s cheap to run

| Piece | Cost for personal use |
|--------|------------------------|
| Cloudflare Worker + static UI | Free tier (more than enough for one person) |
| D1 (queue database) | Free tier |
| Cron trigger | Free with Workers |
| Workers AI (writing coach + Review generate) | Free Neurons/day — usually fine for personal use |
| **X posts** | **The only real bill** — pay-per-use credits |

As long as you stay on plain text (no URLs), each post is about **$0.015 USD**.
A few posts a day is a few dollars a month. Fund credits in the X Developer
Console and enable auto-recharge so the queue never stalls.

Cloudflare free limits exist, but for a personal scheduler they almost never
matter. Workers AI overage only kicks in if you hammer the coach/generate
features past the daily free pool.

## Features

- **Composer** — Queue or Post now from one write box
- **Coach** (off | on) — Workers AI craft feedback (honesty / hook / bone, one
  question, short suggestions). Not a virality score
- **Lightning (⚡)** — tagged when Coach is on and you Queue / Post from the
  landing composer
- **Queue** — drains on your interval; reorder, edit, delete, shuffle
- **Review** — Tinder-style triage for bulk dumps; optional AI draft into the deck
- **Cost estimates** — plain-text unit price (**$0.015**), shown in your display
  currency (up to 3 decimals so it is not rounded to $0.02)
- **Currency toggle** — USD (default), EUR, GBP, AUD, CAD, NZD, JPY
- **Passphrase login** — single shared secret + per-IP rate limit (production)

## Cost estimates (read this)

- Estimates use X’s **plain text** rate (~**$0.015** per post), converted to your
  display currency
- **Links are not priced into the number.** X charges much more for posts with
  URLs (~$0.20). The UI may flag `(link)` / “not in est.” but the dollar amount
  stays at the plain-text unit
- Estimates do **not** track media, other product tiers, or your live X credit
  balance. Treat them as a rough guide, not a ledger
- Prefer **no links** in queued text if you care about cost

## Architecture

- **Cloudflare Worker** (`src/index.js`) — `/api/*` + cron + static assets from
  `./public`
- **D1** — queue, settings, auth rate limits, review deck (`schema.sql`)
- **Cron** — every 15 minutes (`wrangler.toml`); posts only when interval + daily
  cap allow
- **OAuth 1.0a** — user-context `POST /2/tweets` signed in-Worker (Web Crypto)
- **Workers AI** — coach + Review generate (no extra API key; uses the `AI`
  binding)

## One-time setup

### Prerequisites

1. A [Cloudflare](https://dash.cloudflare.com) account
2. An [X Developer](https://developer.x.com) app with **pay-per-use credits**
3. Node.js (for `npx wrangler`)

### 1. Clone and install

```sh
git clone https://github.com/lukasgenis/xqueue.git
cd xqueue
npm install
npx wrangler login
```

### 2. Create D1 and wire the database id

```sh
npx wrangler d1 create xqueue
```

Copy the printed `database_id` into `wrangler.toml` (replace the placeholder /
existing id with **your** database):

```toml
[[d1_databases]]
binding = "DB"
database_name = "xqueue"
database_id = "PASTE-YOUR-ID-HERE"
```

Apply the schema (remote = the live DB):

```sh
npx wrangler d1 execute xqueue --remote --file=./schema.sql
```

### 3. X credentials (OAuth 1.0a user context)

You need **user-context OAuth 1.0a** — not OAuth 2.0 Client ID/Secret, not the
app-only Bearer token.

1. App → **User authentication settings** → permissions **Read and write** → save
2. **Keys and tokens**:
   - **Consumer Keys** → API Key + API Key Secret → `X_API_KEY` / `X_API_SECRET`
   - **Authentication Tokens** → Access Token + Secret → `X_ACCESS_TOKEN` /
     `X_ACCESS_SECRET`  
     (access token looks like `digits-…`)
3. Confirm tokens say *Created with Read and Write permissions*. If not, set
   write first, then **Regenerate**
4. Fund **credits** in the X developer console (auto-recharge recommended)

```sh
npx wrangler secret put X_API_KEY
npx wrangler secret put X_API_SECRET
npx wrangler secret put X_ACCESS_TOKEN
npx wrangler secret put X_ACCESS_SECRET
```

### 4. App passphrase

```sh
# long random value, e.g. openssl rand -base64 24
npx wrangler secret put APP_SECRET
```

The UI asks for this once and stores it in `localStorage` (sent as
`x-app-secret` on every `/api/*` call).

### 5. Deploy

```sh
npx wrangler deploy
```

Open the `*.workers.dev` URL Wrangler prints, enter the passphrase, start
queueing.

**Optional:** connect the GitHub repo to Cloudflare so pushes to `main`
auto-deploy. Prefer git push over one-off laptop deploys when you care about
history and easy reverts.

Workers AI is already bound in `wrangler.toml` — no extra secret. Free Neurons
are account-wide; coach/generate fail gracefully if AI is unavailable.

## How the scheduler decides to post

Every cron tick posts the oldest queued item **only if**:

1. `now − last_posted_at ≥ interval_hours` (or not paused), **and**
2. fewer than **17** posts in the trailing 24 h (see below)

Failed posts retry next cron and are marked `failed` after 3 attempts so they
don’t block the queue. **Post now** still respects the daily cap.

### Why 17 posts / 24 h?

The UI shows something like `3/17 posted (24h)`. That **17** is an **app-side
safety cap** (`DAILY_CAP` in `src/index.js`), not a separate bill from xqueue.

- X’s free / entry API plan historically allowed about **17 `POST /2/tweets` per
  rolling 24 hours** (per user and per app)
- Without a cap, a **1h** interval could try ~24 posts/day and hit X rate limits
  or burn pay-per-use credits when calls fail/retry
- The scheduler and every “Post now” path stop at 17 so the queue waits until
  older posts age out of the 24h window
- The header counter is headroom: `posted in last 24h / daily cap`

If your X developer plan allows a higher write rate, raise `DAILY_CAP` in
`src/index.js` and redeploy. The number is not read live from X — it’s a local
guard you control.

## Security

- Production: `APP_SECRET` gates every `/api/*` call — use high entropy (30+
  random characters is fine)
- Per-IP rate limit: 10 failed attempts / 15 min → 429
- Constant-time secret compare
- Demo mode (`DEMO=1`) skips the passphrase so the playground stays open
- Optional: Cloudflare **Access** on the production hostname for email OTP on top
- Never commit secrets, `.dev.vars`, or API tokens

## Local dev

```sh
# optional .dev.vars:
# APP_SECRET=...
# X_API_KEY=...
# X_API_SECRET=...
# X_ACCESS_TOKEN=...
# X_ACCESS_SECRET=...
# DEMO=1

npx wrangler dev
# manually trigger a post against the dev server:
curl -X POST localhost:8787/api/post-now -H "x-app-secret: <APP_SECRET>"
```

Cron does not fire automatically in local dev the same way as production.

Local open demo without X:

```sh
# .dev.vars
DEMO=1
npx wrangler dev
```

## API

All routes require the `x-app-secret` header when `APP_SECRET` is set.
Open demos (`DEMO=1`, no secret) leave the API open.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | Queue, history, interval, costs, currency, review |
| POST | `/api/currency` | Display currency `{currency:"EUR"}` |
| POST | `/api/queue` | Add one post `{text, kind?}` |
| POST | `/api/queue/bulk` | Add many `{texts:[]}` |
| POST | `/api/queue/shuffle` | Randomise queue order |
| GET | `/api/history` | Older history `?before=` |
| GET/POST/DELETE | `/api/review…` | Review deck (see source) |
| POST | `/api/spark/coach` | Writing coach `{text}` |
| PATCH | `/api/queue/:id` | Edit queued post |
| POST | `/api/queue/:id/move` | Reorder `{dir:"up"\|"down"}` |
| POST | `/api/queue/:id/post-now` | Post that item now |
| DELETE | `/api/queue/:id` | Remove queued post |
| POST | `/api/interval` | `{hours}` (0 = paused) |
| POST | `/api/post-now` | Force-post oldest queued |
| POST | `/api/post-text` | Post `{text, kind?}` immediately |

## Secrets (Cloudflare only, never committed)

| Secret | Required | Notes |
|--------|----------|--------|
| `X_API_KEY` | prod | OAuth 1.0a consumer key |
| `X_API_SECRET` | prod | Consumer secret |
| `X_ACCESS_TOKEN` | prod | User access token |
| `X_ACCESS_SECRET` | prod | User access secret |
| `APP_SECRET` | prod | UI passphrase (skip on open demos) |

Optional var: `DEMO=1` — mock posting, no X secrets, no passphrase.

## License

MIT — see [LICENSE](./LICENSE).
