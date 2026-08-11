# CLAUDE.md — xqueue

Working notes for AI assistants editing this repo. See `README.md` for the
user-facing feature/setup docs.

## What this is

A private, single-user X/Twitter post scheduler. Cloudflare **Worker with static
assets** (NOT Pages) + **D1** + a cron. Live at
`https://xqueue.lukas-genis.workers.dev` (Cloudflare account `lukasgenis@outlook.com`).

## Layout

- `src/index.js` - the whole Worker: `fetch()` (static assets + `/api/*`) and
  `scheduled()` (cron). No framework, no build step.
- `public/index.html` - entire UI: one file, inline CSS + vanilla JS, no deps.
- `schema.sql` - D1 schema (idempotent CREATEs). Column additions to existing
  tables need live `ALTER TABLE` (CREATE IF NOT EXISTS will not add columns).
  The Worker also lazily ensures some columns/tables (e.g. `queue.kind`, review).
- `wrangler.toml` - Worker config, D1 binding (`DB`), AI binding, cron.

## Deploy / workflow

- **Always:** edit → **commit** → **push** to `main`. GitHub
  (`lukasgenis/xqueue`, private) → Cloudflare Git integration → `wrangler deploy`.
  Live ~30-60s after push.
- **Do not** run `npx wrangler deploy` unless the user explicitly asks. Git push
  is the source of truth for versions and production.
- After pushing, verify with a marker on the live URL if needed (static assets
  can lag the worker by a few seconds).
- Secrets in Cloudflare only, never in git: `X_API_KEY`, `X_API_SECRET`,
  `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `APP_SECRET`.

## Product surface (keep docs in sync when changing)

- **Landing composer:** Queue + Post now only. Coach off|on (localStorage
  `xqueue_coach_mode`; old values `pause`/`local` map to `on`).
- **Lightning:** not a vault. When coach is **on** and the user Queues or Posts
  from the **landing** textbox, send `kind: "lightning"`. Show plain ⚡ after
  cost on queue + history. Bulk import and Review accept never set kind.
- **Coach** `POST /api/spark/coach`: X-native craft (specificity, charge, form
  match). Question-led drafts must keep question cuts. Cuts = high-bone finished
  lines (lowercase, no terminal period). Tapping a cut applies it without
  immediately re-coaching into a rewrite loop.
- **Review generate** still uses history/queue as voice samples (separate from
  coach). Same model: `@cf/mistralai/mistral-small-3.1-24b-instruct`.
- No neuron usage meter in the UI (CF free pool is account-wide; we do not fake
  a live remaining balance).
- Avoid em dashes in the frontend UI copy.

## Conventions / gotchas (learned the hard way)

- **`[hidden]` vs `display`**: any element toggled via the `hidden` attribute that
  also has a CSS `display` (flex/grid) needs the `[hidden]` to win. There's a
  global `[hidden] { display: none !important }` guard - keep it. This bit the
  login overlay, the modal, and the tab lists.
- **No native dialogs**: use `confirmDialog()` (custom modal) and the login page,
  never `prompt()`/`confirm()`/`alert()`.
- **Auth**: every `/api/*` call needs the `x-app-secret` header. Backend does
  per-IP rate limiting (`auth_attempts` table) + constant-time compare.
- **X posting**: OAuth 1.0a user-context, signed in-Worker with Web Crypto
  (HMAC-SHA1). The signature base string excludes the JSON body. Verified against
  Twitter's documented test vector - don't "simplify" the pct-encoding or sort.
- **D1 read-after-write lag**: rapid successive writes can read stale (seen with
  the reorder swap and the rate-limit counter). Serialize client actions where it
  matters (see the `moving` guard); each API response is authoritative.
- **Cost/FX**: X prices in USD ($0.015 text / $0.20 link); displayed in AUD via a
  cron-cached `fx_usd_aud` (frankfurter.dev) with a fallback constant. Per-post
  `cost_usd` is stored at post time so totals are a cheap SUM.
- **Daily cap**: `DAILY_CAP = 17` (matches X Free rate limit) is a client-side
  safety throttle enforced in the scheduler and both post-now paths.
- **Mobile**: 16px inputs (iOS zoom), tap-to-reveal per-post actions, keyboard-
  aware edit box, stacked composer actions ≤520px. Test layout changes at ≤520px.
- **Review deck**: tables `review_items` + `review_undo` (single-row undo). Created
  lazily via `ensureReviewSchema()` on `/api/state` so deploys work without a
  manual migration; `schema.sql` still has the canonical DDL. Accept inserts into
  `queue` immediately; reject deletes; over-280 may sit in the deck but accept
  is rejected server-side. Don't drop the 280 cap without a product decision.
- **Workers AI**: `[ai] binding = "AI"` in wrangler.toml. Review generate +
  coach. Free Neurons are daily on the CF account; no API key secret for Workers AI.
- **queue.kind**: lazy `ALTER TABLE` via `ensureQueueKindColumn`. Values: null or
  `'lightning'`. Selected in state/history queries.
- **fmtCountdown**: sub-minute remaining displays as `now` (never `in 0m`).
- Legacy `/api/sparks*` may still be in the Worker; UI does not use a vault.

## Verifying changes

Prefer driving the real deployed endpoint (seed test rows via
`wrangler d1 execute ... --command "INSERT ..."`, exercise the API, assert, then
clean up the test rows). Don't fire real posts in tests - that spends X credits
and hits the live timeline.
