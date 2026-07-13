# xqueue

A private, single-user X/Twitter post scheduler. Write posts, queue them, and an
hourly Cloudflare cron drips the queue out to X on whatever interval you pick
(1 / 3 / 6 / 9 / 12 / 24 h). Runs entirely on Cloudflare's free tier — no
Mac-mini dependency, always on.

**Live:** `https://xqueue.lukas-genis.workers.dev` (account `lukasgenis@outlook.com`)

## Features

- **Queue** — write a post, hit **Queue** (or Enter on desktop); it drops to the
  bottom. The top of the queue is what posts next.
- **Post now** — post immediately (with a themed confirm) instead of queueing:
  the composer's **Post now** for new text, or the **➤** button on any queued
  item to jump it to the front. Both record to history and count toward the cap.
- **Interval** — 1/3/6/9/12/24 h toggle controlling how fast the queue drains.
  Global to the whole queue; stored in D1, so changing it never needs a redeploy.
- **Edit / reorder / delete** — edit a queued post inline (auto-growing box),
  move it up/down with ▲▼, or delete it (with confirm). Queued items only.
- **Bulk import** — paste many posts or upload a `.txt`/`.md`/`.csv`, split by
  blank line (multi-line posts) or one-per-line. Live count, skips over-280 /
  empty entries with a report.
- **Cost tracking (AUD)** — live per-post cost estimate in the composer (flags
  links, which are 13× pricier), per-item costs, a "cost to drain the queue"
  total, and a running "spent so far" total. USD→AUD via a cron-cached live rate.
- **Runway** — Queue tab shows how many days of posts remain at the current
  interval, and the projected empties date.
- **Queue / History tabs** — switch between pending and posted/failed, each with
  a live count.
- **Login + brute-force protection** — custom passphrase login page (no browser
  popups anywhere), per-IP rate limiting, constant-time secret comparison.
- **Mobile-friendly** — 16px inputs (no iOS zoom), tap-a-post to reveal its
  actions, keyboard-aware edit box, responsive throughout.

## Architecture

- **Cloudflare Worker** (`src/index.js`) serves the static UI from `./public` and
  handles the `/api/*` routes. Based on the `spudnote-web` skeleton.
- **D1 database** `xqueue` holds the queue (with per-post `cost_usd`), settings
  (interval, last-posted, cached FX rate), and the auth rate-limit log. Schema in
  `schema.sql`; column additions applied via `ALTER TABLE` on the live DB.
- **Cron Trigger** (`0 * * * *`, in `wrangler.toml`) runs the scheduler hourly.
- **OAuth 1.0a** user-context signing to `POST /2/tweets`, done in-Worker with
  Web Crypto (HMAC-SHA1) — no library. Signing was verified against Twitter's
  documented test vector.
- **Auto-deploy:** connected to GitHub (`lukasgenis/xqueue`, private) via
  Cloudflare's Git integration — every push to `main` runs `wrangler deploy`.

## Cost (important — X killed the free tier)

As of **Feb 2026**, X moved to **pay-per-use credits** (no free tier for new
developers; existing users migrated with a one-time $10 voucher). For xqueue's
usage — plain text, no links:

- **$0.015 per text post** (no URL, no media)
- **$0.20 per post if it contains a URL** (13× more — avoid links in queued text)
- Images are the same cheap $0.015 rate as text

At ~6 posts/day that's roughly **$2.70/month**. Fund credits in the X Developer
Console (enable auto-recharge so the queue never stalls). The app also enforces a
safety cap of **17 posts / 24 h** to match X's Free-plan rate limit.

## One-time setup

From `~/Developer/xqueue`:

```sh
# 1. Create the D1 database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create xqueue

# 2. Create the tables (remote = the real deployed DB)
npx wrangler d1 execute xqueue --remote --file=./schema.sql

# 3. Set the 4 X credentials + a UI passphrase (each prompts for the value)
npx wrangler secret put X_API_KEY
npx wrangler secret put X_API_SECRET
npx wrangler secret put X_ACCESS_TOKEN
npx wrangler secret put X_ACCESS_SECRET
npx wrangler secret put APP_SECRET      # any long random passphrase; the UI asks once

# 4. Deploy (or just push to main — Git integration auto-deploys)
npx wrangler deploy
```

Then open the URL, enter the passphrase on the login screen, and start queueing.

### X credentials (from developer.x.com)

You need **user-context OAuth 1.0a** creds — NOT the OAuth 2.0 Client ID/Secret
and NOT the app-only Bearer token:

1. App → **User authentication settings** → **App permissions: Read and write**, save.
2. **Keys and tokens** tab:
   - **Consumer Keys → API Key + API Key Secret** → `X_API_KEY` / `X_API_SECRET`
   - **Authentication Tokens → Access Token + Secret** → `X_ACCESS_TOKEN` / `X_ACCESS_SECRET`
     (the access token starts with `digits-` — that's the OAuth 1.0a giveaway)
   - Confirm it says *"Created with Read and Write permissions."* If not, set write
     first (step 1) then **Regenerate**.

## How the scheduler decides to post

Every hour the cron posts the oldest queued item **only if**:

1. `now − last_posted_at ≥ interval_hours`, **and**
2. fewer than 17 posts in the trailing 24 h (safety cap).

A failed post retries next cron and is marked `failed` after 3 attempts so it
can't block the queue. **Post now** (`POST /api/post-text`) and **force-post the
top item** (`POST /api/post-now`) both still respect the daily cap.

## Security

- `APP_SECRET` gates every `/api/*` call. Use a long random value (e.g.
  `openssl rand -base64 24`) — with high entropy, brute force is infeasible.
- **Per-IP rate limiting:** 10 failed passphrase attempts in 15 min → that IP is
  locked out (429). Logged in the `auth_attempts` table, pruned by the cron.
- **Constant-time comparison** of the secret.
- Optional extra layer: Cloudflare **Access** self-hosted app on the hostname
  (free) for real SSO/email-OTP login on top.

## API reference (all require `x-app-secret` header)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Queue, history, interval, counts, costs, FX rate |
| POST | `/api/queue` | Add one post `{text}` |
| POST | `/api/queue/bulk` | Add many `{texts:[]}` |
| PATCH | `/api/queue/:id` | Edit a queued post `{text}` |
| POST | `/api/queue/:id/move` | Reorder `{dir:"up"\|"down"}` |
| POST | `/api/queue/:id/post-now` | Post that specific queued item now |
| DELETE | `/api/queue/:id` | Remove a queued post |
| POST | `/api/interval` | Set interval `{hours}` |
| POST | `/api/post-now` | Force-post the oldest queued item |
| POST | `/api/post-text` | Post arbitrary `{text}` immediately |

## Local dev

```sh
npx wrangler dev            # local D1; cron won't fire automatically
# manually trigger the scheduler against the dev server:
curl -X POST localhost:8787/api/post-now -H "x-app-secret: <APP_SECRET>"
```

## Secrets (in Cloudflare, never committed)

`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `APP_SECRET`.
