# CLAUDE.md — xqueue

Working notes for AI assistants editing this repo. See `README.md` for the
user-facing feature/setup docs.

## What this is

A private, single-user X/Twitter post scheduler. Cloudflare **Worker with static
assets** (NOT Pages) + **D1** + an hourly **cron**. Live at
`https://xqueue.lukas-genis.workers.dev` (Cloudflare account `lukasgenis@outlook.com`).

## Layout

- `src/index.js` — the whole Worker: `fetch()` (static assets + `/api/*` routes)
  and `scheduled()` (the hourly cron). No framework, no build step.
- `public/index.html` — the entire UI: one file, inline CSS + vanilla JS, no deps.
- `schema.sql` — D1 schema (idempotent CREATEs). Column additions to existing
  tables must be run as `ALTER TABLE` against the live DB (CREATE IF NOT EXISTS
  won't add columns).
- `wrangler.toml` — Worker config, D1 binding (`DB`), cron `0 * * * *`.

## Deploy / workflow

- **Auto-deploy is on**: pushing to `main` on GitHub (`lukasgenis/xqueue`, private)
  triggers a Cloudflare build that runs `wrangler deploy`. So the normal loop is:
  edit → commit → push → ~30–60s later it's live. `npx wrangler deploy` still
  works for a manual push.
- After pushing, verify by polling the live URL for a marker string, e.g.
  `curl -s https://xqueue.lukas-genis.workers.dev/ | grep <new-code-marker>`, or
  hit a changed endpoint. Static assets can lag the worker by a few seconds.
- Secrets live in Cloudflare, never in git: `X_API_KEY`, `X_API_SECRET`,
  `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `APP_SECRET`.

## Conventions / gotchas (learned the hard way)

- **`[hidden]` vs `display`**: any element toggled via the `hidden` attribute that
  also has a CSS `display` (flex/grid) needs the `[hidden]` to win. There's a
  global `[hidden] { display: none !important }` guard — keep it. This bit the
  login overlay, the modal, and the tab lists.
- **No native dialogs**: use `confirmDialog()` (custom modal) and the login page,
  never `prompt()`/`confirm()`/`alert()`.
- **Auth**: every `/api/*` call needs the `x-app-secret` header. Backend does
  per-IP rate limiting (`auth_attempts` table) + constant-time compare.
- **X posting**: OAuth 1.0a user-context, signed in-Worker with Web Crypto
  (HMAC-SHA1). The signature base string excludes the JSON body. Verified against
  Twitter's documented test vector — don't "simplify" the pct-encoding or sort.
- **D1 read-after-write lag**: rapid successive writes can read stale (seen with
  the reorder swap and the rate-limit counter). Serialize client actions where it
  matters (see the `moving` guard); each API response is authoritative.
- **Cost/FX**: X prices in USD ($0.015 text / $0.20 link); displayed in AUD via a
  cron-cached `fx_usd_aud` (frankfurter.dev) with a fallback constant. Per-post
  `cost_usd` is stored at post time so totals are a cheap SUM.
- **Daily cap**: `DAILY_CAP = 17` (matches X Free rate limit) is a client-side
  safety throttle enforced in the scheduler and both post-now paths.
- **Mobile**: 16px inputs (iOS zoom), tap-to-reveal per-post actions, keyboard-
  aware edit box. Test layout changes at ≤520px.
- **Review deck**: tables `review_items` + `review_undo` (single-row undo). Created
  lazily via `ensureReviewSchema()` on `/api/state` so deploys work without a
  manual migration; `schema.sql` still has the canonical DDL. Accept inserts into
  `queue` immediately; reject deletes; over-280 may sit in the deck but accept
  is rejected server-side. Don't drop the 280 cap without a product decision.
- **Workers AI**: `[ai] binding = "AI"` in wrangler.toml. Generate path is
  `POST /api/review/generate` → `@cf/mistralai/mistral-small-3.1-24b-instruct`
  using recent posted/queued/pending samples, then `seedReview`. Free Neurons
  are daily on the CF account; no API key secret for Workers AI.
- **Sparks vault + coach**: table `sparks` (lazy `ensureSparkSchema` on state).
  Landing composer: Queue | Lightning (→ vault) | Post now. Coach:
  `POST /api/spark/coach` (honesty/bone/question — never virality). Modes
  off/local/pause in localStorage `xqueue_coach_mode`. Vault actions:
  edit, cool 1h, queue, post, delete. Ship paths still enforce 280; vault
  allows up to 4000 for messy drafts.

## Verifying changes

Prefer driving the real deployed endpoint (seed test rows via
`wrangler d1 execute ... --command "INSERT ..."`, exercise the API, assert, then
clean up the test rows). Don't fire real posts in tests — that spends X credits
and hits the live timeline.
