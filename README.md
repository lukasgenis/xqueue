# xqueue

A private, single-user X/Twitter post scheduler. Write posts, queue them, and an
hourly Cloudflare cron drips the queue out to X on whatever interval you pick
(1 / 3 / 6 / 9 / 12 / 24 h). Runs entirely on Cloudflare's free tier — no
Mac-mini dependency, always on.

**Live:** `https://xqueue.lukas-genis.workers.dev` (account `lukasgenis@outlook.com`)

## Features

- **Composer (home)** - one top write box. **Queue** (or Enter on desktop) and
  **Post now** (confirm) are the only ship paths from the landing box.
- **Coach** (off | on) - when **on**, after you pause typing, Workers AI
  (**Mistral Small 3.1**) returns honesty / hook / bone, one deepening
  question, and 1-2 high-bone suggestions (house style: all lowercase, no
  terminal full stop). Tuned for real X timeline craft (specificity, charge,
  form match: question drafts stay questions). Not a virality score.
- **Lightning tag (⚡)** - automatic when **Coach is on** and you Queue or Post
  now from the landing composer only. Plain ⚡ after the cost on queue and
  history items. Bulk import and Review accept never get the tag.
- **Queue** - queued posts drain on your interval. Top of the list posts next.
  "Next post" shows **now** when due or under one minute away.
- **Post now** - also available per queued item (**➤**).
- **Interval** - 1/3/6/9/12/24 h (or ∞ paused). Global; stored in D1.
- **Edit / reorder / delete / shuffle** - queued items only.
- **Bulk import** - paste or upload `.txt`/`.md`/`.csv`; blank-line or
  one-per-line split. No lightning tag.
- **Review** - Tinder-style triage for dumps; accept queues, reject discards;
  undo; persistent deck in D1. Over-280 editable but not accept-able until cut.
- **AI generate (Review)** - batch drafts into the review deck (voice from
  recent posted/queued/pending). Free CF Neurons apply account-wide.
- **Cost tracking (AUD)** - composer estimate, per-item costs, drain total,
  spent so far. USD prices; FX via cron-cached rate.
- **Runway** - days of queue left at current interval + empties date.
- **Queue / History tabs** - pending vs posted/failed with live counts.
- **Login** - passphrase UI, per-IP rate limit, constant-time compare.
- **Mobile-friendly** - 16px inputs, tap-to-reveal actions, stacked composer
  actions on narrow screens.

## Architecture

- **Cloudflare Worker** (`src/index.js`) serves the static UI from `./public` and
  handles the `/api/*` routes. Based on the `spudnote-web` skeleton.
- **D1 database** `xqueue` holds the queue (per-post `cost_usd`, optional
  `kind` = `lightning`), settings, auth rate-limit log, review deck tables.
  Schema in `schema.sql`; new columns need live `ALTER TABLE` (also done lazily
  in the Worker for `kind`).
- **Cron Trigger** (see `wrangler.toml`) runs the scheduler.
- **OAuth 1.0a** user-context signing to `POST /2/tweets` in-Worker (Web Crypto).
- **Workers AI** binding for Review generate + landing coach.
- **Auto-deploy:** push to `main` on GitHub (`lukasgenis/xqueue`) → Cloudflare
  runs `wrangler deploy`. Prefer push over manual deploy.

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

# 4. Ship: commit + push to main (Cloudflare Git auto-deploys).
#    Only run `npx wrangler deploy` if you intentionally skip git.
git push origin main
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
| GET | `/api/state` | Queue, history, interval, counts, costs, FX, review |
| POST | `/api/queue` | Add one post `{text, kind?}` (`kind: "lightning"` optional) |
| POST | `/api/queue/bulk` | Add many `{texts:[]}` (no lightning) |
| POST | `/api/queue/shuffle` | Randomise queue order |
| GET | `/api/history` | Older history page `?before=` |
| GET | `/api/review` | Deck state (also in `/api/state` as `review`) |
| POST | `/api/review` | Seed deck `{texts:[], mode:"replace"\|"append"}` |
| POST | `/api/review/generate` | AI draft into deck `{count?, mode?, topic?}` |
| DELETE | `/api/review` | Empty the whole deck |
| PATCH | `/api/review/:id` | Edit a deck item `{text}` |
| DELETE | `/api/review/:id` | Remove one deck item |
| POST | `/api/review/:id/accept` | Queue this item (optional `{text}` override) |
| POST | `/api/review/:id/reject` | Discard this item |
| POST | `/api/review/undo` | Undo last accept or reject |
| POST | `/api/spark/coach` | Writing coach JSON `{text}` → honesty/hook/bone/question/cuts |
| PATCH | `/api/queue/:id` | Edit a queued post `{text}` |
| POST | `/api/queue/:id/move` | Reorder `{dir:"up"\|"down"}` |
| POST | `/api/queue/:id/post-now` | Post that specific queued item now |
| DELETE | `/api/queue/:id` | Remove a queued post |
| POST | `/api/interval` | Set interval `{hours}` (0 = paused) |
| POST | `/api/post-now` | Force-post the oldest queued item |
| POST | `/api/post-text` | Post arbitrary `{text, kind?}` immediately |

Legacy `/api/sparks*` routes may still exist in the Worker for older D1 rows; the
UI no longer uses a vault. Lightning is only `kind` on queue/post from the
landing composer when coach is on.

## Local dev

```sh
npx wrangler dev            # local D1; cron won't fire automatically
# manually trigger the scheduler against the dev server:
curl -X POST localhost:8787/api/post-now -H "x-app-secret: <APP_SECRET>"
```

## Secrets (in Cloudflare, never committed)

`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `APP_SECRET`.
