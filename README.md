# xqueue

A private, single-user X/Twitter post scheduler. Type a post, hit Enter, it drops
to the bottom of a queue. An hourly Cloudflare cron posts the top of the queue on
whatever interval you toggle (1 / 3 / 6 / 9 / 12 / 24 h), self-throttling under
X's Free-tier limit of 17 posts / 24 h.

- **Cloudflare Worker** (static UI + API) — same skeleton as `spudnote-web`
- **D1** holds the queue + interval setting
- **Cron Trigger** (`0 * * * *`) drives posting; the interval lives in D1, so
  changing it never needs a redeploy
- **OAuth 1.0a** user-context auth to `POST /2/tweets` (no library, uses Web Crypto)
- Runs entirely on the Cloudflare **free tier**; no Mac-mini dependency

Account: `lukasgenis@outlook.com`. URL: `https://xqueue.<account>.workers.dev`.

---

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
npx wrangler secret put APP_SECRET      # any passphrase; the UI asks for it once

# 4. Deploy
./deploy.sh        # or: npx wrangler deploy
```

Then open `https://xqueue.<account>.workers.dev`, enter the passphrase when prompted,
and start queueing.

### X credentials (from developer.x.com)

You need **user-context** OAuth 1.0a creds, not the app-only Bearer token:

1. App → **User authentication settings** → **App permissions: Read and write**, save.
2. **Keys and tokens** tab:
   - Consumer Keys → **API Key** + **API Key Secret** → `X_API_KEY` / `X_API_SECRET`
   - Authentication Tokens → **Access Token** + **Secret** → `X_ACCESS_TOKEN` / `X_ACCESS_SECRET`
   - Confirm the access token says *"Created with Read and Write permissions."*
     If not, set write first (step 1) then **Regenerate**.

## How the scheduler decides to post

Every hour the cron runs and posts the oldest queued item **only if**:

1. `now − last_posted_at ≥ interval_hours` (the toggle), **and**
2. fewer than 17 posts in the trailing 24 h (X Free cap).

A failed post retries on the next cron and is marked `failed` after 3 attempts so
it can't block the queue. You can also force the top item out immediately via
`POST /api/post-now` (still respects the daily cap).

## Optional: Cloudflare Access

The `APP_SECRET` passphrase already gates the API. For a second layer, add a
Cloudflare **Access** self-hosted app on the `xqueue.<account>.workers.dev`
hostname with an email policy for yourself (free, up to 50 users).

## Local dev

```sh
npx wrangler dev            # uses a local D1; cron won't fire automatically
# trigger the scheduler manually against the dev server:
curl -X POST localhost:8787/api/post-now -H "x-app-secret: <APP_SECRET>"
```

<!-- autodeploy connectivity test 1783899459002 -->
