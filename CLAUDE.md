# CLAUDE.md — xqueue

Working notes for AI assistants editing this repo. See `README.md` for the
user-facing feature/setup docs.

## What this is

A **single-user** X/Twitter post scheduler. Cloudflare **Worker with static
assets** (NOT Pages) + **D1** + a 15‑minute cron. Self-hosted: each person
deploys their own instance with their own X OAuth 1.0a credentials and
`APP_SECRET` passphrase.

Optional **demo mode** (`DEMO=1` var, `wrangler.demo.toml`): fake tweet ids, no
X secrets, no passphrase (auth skipped), sample queue seed, UI banner. Same
repo — separate Worker name + D1 only. Do not put demo on a long-lived fork
branch; it will drift.

## Layout

- `src/index.js` — whole Worker: `fetch()` (static + `/api/*`) and `scheduled()`
- `public/index.html` — entire UI (inline CSS + vanilla JS, no build step)
- `schema.sql` — D1 schema (idempotent CREATEs). New columns need live
  `ALTER TABLE` (Worker also lazily ensures some columns/tables)
- `wrangler.toml` — Worker config, D1, AI binding, cron, optional `DEMO` var
- `deploy.sh` — optional helper that loads a local Cloudflare API token and
  runs `wrangler deploy` (not required; git push / `npx wrangler deploy` is fine)

## Deploy / workflow

- Prefer: edit → **commit** → **push** to default branch → Cloudflare Git
  auto-deploy when configured
- Do not run `wrangler deploy` unless the user asks for a direct deploy
- Secrets only in Cloudflare / `.dev.vars` (gitignored): `X_API_KEY`,
  `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `APP_SECRET`
- Forks must create their **own** D1 and paste `database_id` into `wrangler.toml`

## Product surface (keep docs in sync when changing)

- **Landing composer:** Queue + Post now only. Coach off|on (localStorage
  `xqueue_coach_mode`; old values `pause`/`local` map to `on`)
- **Lightning:** when coach is **on** and user Queues/Posts from the **landing**
  box, send `kind: "lightning"`. Bulk import and Review accept never set kind
- **Coach** `POST /api/spark/coach`: X-native craft. Cuts = finished lines
  (lowercase, no terminal period)
- **Currency:** `POST /api/currency` + `settings.display_currency` /
  `settings.fx_rate`. Default **USD**. Options: USD, EUR, GBP, AUD, CAD, NZD,
  JPY. FX via frankfurter.dev (cron-refreshed). UI picker matches coach picker
  styles (`.picker` / `.picker-btn` / `.picker-menu`)
- **Costs:** plain-text unit `$0.015` USD per post (photos included: X does
  not bill media upload), **+ $0.005 per photo with alt text** (separate Media
  Metadata call). Convert with `fx_rate` for display. Links are flagged in UI
  but **not** re-priced. Do not pretend the estimate is X’s real invoice
- **Photos:** up to 4 per post (`queue.media` = JSON array of `media` ids).
  Browser resizes to 2048px JPEG (HEIC → JPEG, strips location; small PNGs kept)
  + a 480px thumb, `POST /api/media` (multipart). D1 row cap 2 MB → 1.75 MB max.
  Posting uploads to `POST https://api.x.com/2/media/upload` (multipart,
  OAuth 1.0a, `media_category=tweet_image`), then drops the full file and keeps
  the thumb for History. Images are behind the passphrase: UI fetches → blob URL.
  Cron deletes unreferenced images older than 24h
- **Drafts tab:** `drafts` table, suggestions to check (AstroPiggy). Ingest
  `POST /api/drafts` `{ drafts: [{ text, note, source, key, images: [{ data
  (base64), mime, alt }] }] }`; `key` dedupes forever (dismiss keeps the row).
  Queue/Post now move it into `queue`
- No neuron usage meter that fakes a live remaining balance
- Avoid em dashes in frontend UI copy

## Conventions / gotchas

- **`[hidden]` vs `display`:** global `[hidden] { display: none !important }`
- **No native dialogs:** `confirmDialog()` and login page only
- **Auth:** `x-app-secret` header; rate limit + constant-time compare
- **X posting:** OAuth 1.0a, Web Crypto HMAC-SHA1; signature base excludes JSON body
- **D1 read-after-write lag:** serialize client actions where it matters
- **Daily cap:** `DAILY_CAP = 17` in scheduler and post-now paths
- **Mobile:** 16px inputs, tap-to-reveal actions, stacked composer ≤520px
- **Review deck:** lazy `ensureReviewSchema()`; accept inserts into `queue`
- **Workers AI:** `[ai] binding = "AI"`; model
  `@cf/mistralai/mistral-small-3.1-24b-instruct`
- **queue.kind:** null or `'lightning'`
- **fmtCountdown:** sub-minute remaining → `now`
- **DEMO:** `env.DEMO` in `{"1","true",true}` short-circuits `postTweet`

## Verifying changes

Prefer the real deployed endpoint when testing. Don’t fire real posts in tests
unless intentional — that spends X credits.
