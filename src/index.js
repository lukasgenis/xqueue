// xqueue Worker.
//
// Two responsibilities:
//   1. fetch()     — serves the static UI (./public) and the /api/* routes the
//                    UI calls to read/modify the queue and interval setting.
//   2. scheduled() — runs hourly (see wrangler.toml [triggers]). Decides whether
//                    enough time has elapsed since the last post (per the interval
//                    setting) and whether we're under X's 17-posts/24h cap, then
//                    posts the oldest queued item to X via OAuth 1.0a.
//
// Auth: every /api/* request must carry `x-app-secret` matching env.APP_SECRET
// (the UI stores it in localStorage and sends it as a header). Put Cloudflare
// Access in front too if you want a second layer — the two are independent.

const X_POST_URL = "https://api.twitter.com/2/tweets";
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CAP = 17; // X Free tier: 17 POST /2/tweets per 24h (per user & per app)
const MAX_ATTEMPTS = 3; // give up on a post after this many failures
const MAX_TWEET_LEN = 280;
// Workers AI model for drafting posts into the Review deck + coach.
const AI_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
const AI_GEN_MIN = 1;
const AI_GEN_MAX = 25; // production Review generate batch size cap
const AI_GEN_DEFAULT = 10;
const AI_GEN_MAX_DEMO = 5; // demo: smaller batches (also saves Neurons)
const AI_GEN_DEFAULT_DEMO = 3;


// X pay-per-use pricing (USD). Estimates always use the plain-text rate.
// X charges ~$0.20 when a post contains a URL (~13x); the UI flags that but
// does not bake it into the number (heuristic billing is easy to get wrong).
const COST_TEXT_USD = 0.015;
const COST_LINK_USD = 0.2; // documented only; not used for estimates

// Display currencies (X bills in USD; we convert for the UI).
const CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "NZD", "JPY"];
const DEFAULT_CURRENCY = "USD";
const DEFAULT_INTERVAL_HOURS = 6; // new installs / missing settings row
// Open demo: cap Workers AI so strangers can't burn the free Neuron pool.
const DEMO_AI_COACH_LIMIT = 5; // coach calls per IP per 24h
const DEMO_AI_GENERATE_LIMIT = 2; // Review generate batches per IP per 24h
const DEMO_AI_WINDOW_MS = DAY_MS;
// Fallback rates (USD → currency) when frankfurter is unreachable.
const DEFAULT_FX = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  AUD: 1.52,
  CAD: 1.36,
  NZD: 1.65,
  JPY: 150,
};
const FX_SYMBOLS = CURRENCIES.filter((c) => c !== "USD").join(",");
const FX_URL = `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${FX_SYMBOLS}`;
const FX_MAX_AGE_MS = 12 * 60 * 60 * 1000; // refetch the rate if older than this

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx, url);
    }

    // Everything else is a static asset (index.html, favicon, etc.).
    return env.ASSETS.fetch(request);
  },

  // Cloudflare invokes this on the cron schedule. waitUntil keeps the worker
  // alive until the (async) posting logic finishes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduler(env));
  },
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(request, env, ctx, url) {
  if (!env.DB) return json({ ok: false, error: "Database not wired up." }, 500);

  // Shared-secret gate with per-IP rate limiting. The passphrase should still be
  // long & random — this is defense-in-depth, not a substitute for entropy.
  // Public DEMO instances stay open (no passphrase) so people can click around.
  if (env.APP_SECRET && !isDemo(env)) {
    const gate = await checkAuth(request, env);
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);
  }

  try {
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/api/state" && method === "GET") {
      return json({ ok: true, ...(await getState(env, request)) });
    }

    // Older history pages for the "Load more" button. Cursor-based on the
    // coalesced timestamp (not OFFSET) so a fresh post at the top never shifts
    // the boundary and causes a skipped/duplicated row.
    if (pathname === "/api/history" && method === "GET") {
      const before = Number(url.searchParams.get("before")) || Date.now();
      const rows = (
        await env.DB.prepare(
          "SELECT id, text, status, tweet_id, error, posted_at, created_at, kind FROM queue " +
            "WHERE status IN ('posted','failed') AND COALESCE(posted_at, created_at) < ?1 " +
            "ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 50"
        )
          .bind(before)
          .all()
      ).results;
      // Mirror getState: recompute per-row cost heuristically so figures match.
      for (const h of rows) {
        if (h.cost_usd == null) h.cost_usd = h.status === "posted" ? postCostUsd(h.text) : 0;
      }
      return json({ ok: true, history: rows });
    }

    if (pathname === "/api/queue" && method === "POST") {
      const body = await request.json();
      return await addToQueue(env, String(body.text || ""), body.kind, request);
    }

    // Bulk import: add many posts at once. Body: { texts: string[] }.
    if (pathname === "/api/queue/bulk" && method === "POST") {
      const body = await request.json();
      return await addBulk(env, Array.isArray(body.texts) ? body.texts : [], request);
    }

    // Shuffle the whole queue into a random order (reorders only; nothing lost).
    if (pathname === "/api/queue/shuffle" && method === "POST") {
      return await shuffleQueue(env, request);
    }

    // /api/queue/:id  (DELETE)
    const del = pathname.match(/^\/api\/queue\/(\d+)$/);
    if (del && method === "DELETE") {
      await env.DB.prepare("DELETE FROM queue WHERE id = ?1 AND status = 'queued'")
        .bind(Number(del[1]))
        .run();
      return json({ ok: true, ...(await getState(env, request)) });
    }

    // Edit the text of a still-queued post. Only 'queued' rows are editable —
    // you can't rewrite something that already posted.
    const edit = pathname.match(/^\/api\/queue\/(\d+)$/);
    if (edit && method === "PATCH") {
      const body = await request.json();
      const text = String(body.text || "").trim();
      if (!text) return json({ ok: false, error: "Empty post." }, 400);
      if (text.length > MAX_TWEET_LEN) {
        return json({ ok: false, error: `Too long (${text.length}/${MAX_TWEET_LEN}).` }, 400);
      }
      const res = await env.DB.prepare(
        "UPDATE queue SET text = ?1 WHERE id = ?2 AND status = 'queued'"
      )
        .bind(text, Number(edit[1]))
        .run();
      if (!res.meta || res.meta.changes === 0) {
        return json({ ok: false, error: "Post not found or already posted." }, 404);
      }
      return json({ ok: true, ...(await getState(env, request)) });
    }

    // Reorder a queued post up/down one slot by swapping timestamps with its
    // neighbor. Body: { dir: "up" | "down" }.
    const mv = pathname.match(/^\/api\/queue\/(\d+)\/move$/);
    if (mv && method === "POST") {
      const body = await request.json();
      return await moveQueued(env, Number(mv[1]), body.dir === "down" ? "down" : "up", request);
    }

    // Post a specific queued item immediately (still respects the daily cap).
    const pn = pathname.match(/^\/api\/queue\/(\d+)\/post-now$/);
    if (pn && method === "POST") {
      return await postQueuedNow(env, Number(pn[1]), request);
    }

    if (pathname === "/api/interval" && method === "POST") {
      const body = await request.json();
      const hours = Number(body.hours);
      // 0 = paused: the queue is halted and the cron never auto-posts (manual
      // "post now" still works). Any other value must be a known cadence.
      if (![0, 1, 3, 6, 9, 12, 24].includes(hours)) {
        return json({ ok: false, error: "Invalid interval." }, 400);
      }
      await env.DB.prepare("UPDATE settings SET interval_hours = ?1 WHERE id = 1")
        .bind(hours)
        .run();
      return json({ ok: true, ...(await getState(env, request)) });
    }

    // Display currency for cost estimates (X prices stay USD under the hood).
    if (pathname === "/api/currency" && method === "POST") {
      const body = await request.json();
      const currency = String(body.currency || "").toUpperCase();
      if (!CURRENCIES.includes(currency)) {
        return json({ ok: false, error: "Invalid currency." }, 400);
      }
      await ensureSettingsSchema(env);
      await env.DB.prepare(
        "UPDATE settings SET display_currency = ?1 WHERE id = 1"
      )
        .bind(currency)
        .run();
      // Force a fresh FX rate for the new currency (isolated failure is fine).
      try {
        await refreshFx(env, { force: true });
      } catch (e) {
        console.error("fx refresh after currency change failed:", e);
      }
      return json({ ok: true, ...(await getState(env, request)) });
    }

    // Post the top of the queue right now (still respects the daily cap).
    if (pathname === "/api/post-now" && method === "POST") {
      const result = await postNext(env, { ignoreInterval: true });
      return json({ ok: true, result, ...(await getState(env, request)) });
    }

    // Post an arbitrary typed post immediately (the "NOW" / POST button), instead
    // of adding it to the queue. Records it in history and counts toward the cap.
    // Body: { text, kind?: "lightning" } - kind is kept for history tracking only.
    if (pathname === "/api/post-text" && method === "POST") {
      const body = await request.json();
      return await postTextNow(env, String(body.text || ""), body.kind, request);
    }

    // ---- Review deck (Tinder-style triage before / instead of bulk import) ----
    if (pathname === "/api/review" && method === "GET") {
      return json({ ok: true, ...(await getState(env, request)) });
    }

    // Seed the deck. Body: { texts: string[], mode: "replace" | "append" }.
    // Empty lines are dropped; over-280 lines are kept (can't accept until edited).
    if (pathname === "/api/review" && method === "POST") {
      const body = await request.json();
      return await seedReview(env, Array.isArray(body.texts) ? body.texts : [], body.mode === "append" ? "append" : "replace", request);
    }

    // AI draft → Review deck. Body: { count?, mode?: "append"|"replace", topic? }.
    // Uses Workers AI (Mistral Small) + recent history/queue as voice samples.
    if (pathname === "/api/review/generate" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      return await generateReviewDrafts(env, body || {}, request);
    }

    // Empty the whole deck (+ clear undo).
    if (pathname === "/api/review" && method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM review_items"),
        env.DB.prepare("UPDATE review_undo SET action = NULL, text = NULL, queue_id = NULL, position = NULL, created_at = NULL WHERE id = 1"),
      ]);
      return json({ ok: true, ...(await getState(env, request)) });
    }

    // Undo the single most recent accept or reject.
    if (pathname === "/api/review/undo" && method === "POST") {
      return await undoReview(env, request);
    }

    const revItem = pathname.match(/^\/api\/review\/(\d+)$/);
    if (revItem && method === "PATCH") {
      const body = await request.json();
      return await editReviewItem(env, Number(revItem[1]), String(body.text || ""), request);
    }
    if (revItem && method === "DELETE") {
      await env.DB.prepare("DELETE FROM review_items WHERE id = ?1").bind(Number(revItem[1])).run();
      return json({ ok: true, ...(await getState(env, request)) });
    }

    const revAccept = pathname.match(/^\/api\/review\/(\d+)\/accept$/);
    if (revAccept && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const override = body && body.text != null ? String(body.text) : null;
      return await acceptReviewItem(env, Number(revAccept[1]), override, request);
    }

    const revReject = pathname.match(/^\/api\/review\/(\d+)\/reject$/);
    if (revReject && method === "POST") {
      return await rejectReviewItem(env, Number(revReject[1]), request);
    }

    // ---- Sparks (vault): feeling-first drafts, separate from the queue factory ----
    if (pathname === "/api/sparks" && method === "GET") {
      await ensureSparkSchema(env);
      return json({ ok: true, ...(await getState(env, request)) });
    }

    // Save a lightning draft. Body: { text, cool_minutes? } — cool_minutes > 0
    // sets status cooling until now + minutes; otherwise draft.
    if (pathname === "/api/sparks" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      return await createSpark(env, body || {}, request);
    }

    // Live writing coach (Mistral). Body: { text }. Not for virality — honesty/specificity.
    if (pathname === "/api/spark/coach" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      return await coachSpark(env, body || {}, request);
    }

    const sparkItem = pathname.match(/^\/api\/sparks\/(\d+)$/);
    if (sparkItem && method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      return await updateSpark(env, Number(sparkItem[1]), body || {}, request);
    }
    if (sparkItem && method === "DELETE") {
      await ensureSparkSchema(env);
      await env.DB.prepare("DELETE FROM sparks WHERE id = ?1")
        .bind(Number(sparkItem[1]))
        .run();
      return json({ ok: true, ...(await getState(env, request)) });
    }

    const sparkQueue = pathname.match(/^\/api\/sparks\/(\d+)\/queue$/);
    if (sparkQueue && method === "POST") {
      return await queueSpark(env, Number(sparkQueue[1]), request);
    }

    const sparkPost = pathname.match(/^\/api\/sparks\/(\d+)\/post$/);
    if (sparkPost && method === "POST") {
      return await postSparkNow(env, Number(sparkPost[1]), request);
    }

    return json({ ok: false, error: "Not found." }, 404);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
  }
}

function normalizeKind(kind) {
  return String(kind || "").toLowerCase() === "lightning" ? "lightning" : null;
}

async function ensureQueueKindColumn(env) {
  try {
    await env.DB.prepare("ALTER TABLE queue ADD COLUMN kind TEXT").run();
  } catch (_) {
    /* column already exists */
  }
}

async function addToQueue(env, text, kind, request = null) {
  text = text.trim();
  if (!text) return json({ ok: false, error: "Empty post." }, 400);
  if (text.length > MAX_TWEET_LEN) {
    return json({ ok: false, error: `Too long (${text.length}/${MAX_TWEET_LEN}).` }, 400);
  }
  await ensureQueueKindColumn(env);
  const k = normalizeKind(kind);
  await env.DB.prepare(
    "INSERT INTO queue (text, status, created_at, kind) VALUES (?1, 'queued', ?2, ?3)"
  )
    .bind(text, Date.now(), k)
    .run();
  return json({ ok: true, ...(await getState(env, request)) });
}

// Post a specific queued item right now, bypassing queue order and the interval
// (still respects the daily cap). On success it becomes a 'posted' row and resets
// the interval clock; on failure it stays queued so nothing is lost.
async function postQueuedNow(env, id, request = null) {
  const item = await env.DB.prepare(
    "SELECT id, text FROM queue WHERE id = ?1 AND status = 'queued'"
  ).bind(id).first();
  if (!item) return json({ ok: false, error: "Post not found or already posted." }, 404);
  if ((await countRecentPosts(env)) >= DAILY_CAP) {
    return json({ ok: false, error: `Daily cap reached (${DAILY_CAP}/24h).` }, 429);
  }
  const now = Date.now();
  try {
    const tweetId = await postTweet(env, item.text);
    await env.DB.prepare(
      "UPDATE queue SET status = 'posted', posted_at = ?1, tweet_id = ?2, error = NULL, cost_usd = ?3 WHERE id = ?4"
    ).bind(now, tweetId, postCostUsd(item.text), item.id).run();
    await env.DB.prepare("UPDATE settings SET last_posted_at = ?1 WHERE id = 1").bind(now).run();
    return json({ ok: true, result: { posted: true, tweet_id: tweetId }, ...(await getState(env, request)) });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 502);
  }
}

// Swap a queued post with its adjacent neighbor (by created_at) to reorder it.
// Ordering is by created_at ASC, so "up" = earlier timestamp, "down" = later.
async function moveQueued(env, id, dir, request = null) {
  const item = await env.DB.prepare(
    "SELECT id, created_at FROM queue WHERE id = ?1 AND status = 'queued'"
  ).bind(id).first();
  if (!item) return json({ ok: false, error: "Post not found or already posted." }, 404);

  const neighbor = await env.DB.prepare(
    dir === "up"
      ? "SELECT id, created_at FROM queue WHERE status = 'queued' AND created_at < ?1 ORDER BY created_at DESC LIMIT 1"
      : "SELECT id, created_at FROM queue WHERE status = 'queued' AND created_at > ?1 ORDER BY created_at ASC LIMIT 1"
  ).bind(item.created_at).first();

  // Already at the top/bottom — nothing to do.
  if (neighbor) {
    await env.DB.batch([
      env.DB.prepare("UPDATE queue SET created_at = ?1 WHERE id = ?2").bind(neighbor.created_at, item.id),
      env.DB.prepare("UPDATE queue SET created_at = ?1 WHERE id = ?2").bind(item.created_at, neighbor.id),
    ]);
  }
  return json({ ok: true, ...(await getState(env, request)) });
}

// Randomise the order of the entire queue. Ordering is defined purely by
// created_at ASC (moveQueued reorders by swapping timestamps), so we permute
// the queued rows' EXISTING created_at values across the rows with a
// Fisher-Yates shuffle. Reusing the same timestamp multiset keeps ordering
// stable relative to posted rows and never invents colliding values.
async function shuffleQueue(env, request = null) {
  const rows = (
    await env.DB.prepare(
      "SELECT id, created_at FROM queue WHERE status = 'queued' ORDER BY created_at ASC"
    ).all()
  ).results;
  if (rows.length > 1) {
    const times = rows.map((r) => r.created_at);
    for (let i = times.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [times[i], times[j]] = [times[j], times[i]];
    }
    await env.DB.batch(
      rows.map((r, k) =>
        env.DB.prepare("UPDATE queue SET created_at = ?1 WHERE id = ?2").bind(times[k], r.id)
      )
    );
  }
  return json({ ok: true, ...(await getState(env, request)) });
}

// Bulk insert. Validates each entry; too-long / empty ones are skipped and
// counted so the UI can report them. created_at is spaced by 1ms per item so
// paste order is preserved in the queue.
async function addBulk(env, texts, request = null) {
  const clean = [];
  let skippedEmpty = 0;
  let skippedLong = 0;
  for (let t of texts) {
    t = String(t == null ? "" : t).trim();
    if (!t) { skippedEmpty++; continue; }
    if (t.length > MAX_TWEET_LEN) { skippedLong++; continue; }
    clean.push(t);
  }
  if (clean.length) {
    const now = Date.now();
    const stmts = clean.map((t, i) =>
      env.DB.prepare(
        "INSERT INTO queue (text, status, created_at) VALUES (?1, 'queued', ?2)"
      ).bind(t, now + i)
    );
    await env.DB.batch(stmts);
  }
  return json({
    ok: true,
    added: clean.length,
    skippedEmpty,
    skippedLong,
    ...(await getState(env, request)),
  });
}

// Post typed text right now, bypassing the queue. Respects the daily cap. On
// success it's recorded as a 'posted' row (so it shows in history and counts
// toward the 24h cap) and resets the interval clock so the queue keeps spacing.
// kind "lightning" is stored for personal tracking (⚡ badge in history).
async function postTextNow(env, text, kind, request = null) {
  text = text.trim();
  if (!text) return json({ ok: false, error: "Empty post." }, 400);
  if (text.length > MAX_TWEET_LEN) {
    return json({ ok: false, error: `Too long (${text.length}/${MAX_TWEET_LEN}).` }, 400);
  }
  if ((await countRecentPosts(env)) >= DAILY_CAP) {
    return json({ ok: false, error: `Daily cap reached (${DAILY_CAP}/24h).` }, 429);
  }
  await ensureQueueKindColumn(env);
  const k = normalizeKind(kind);
  const now = Date.now();
  try {
    const tweetId = await postTweet(env, text);
    await env.DB.prepare(
      "INSERT INTO queue (text, status, created_at, posted_at, tweet_id, cost_usd, kind) VALUES (?1, 'posted', ?2, ?2, ?3, ?4, ?5)"
    )
      .bind(text, now, tweetId, postCostUsd(text), k)
      .run();
    await env.DB.prepare("UPDATE settings SET last_posted_at = ?1 WHERE id = 1")
      .bind(now)
      .run();
    return json({ ok: true, result: { posted: true, tweet_id: tweetId }, ...(await getState(env, request)) });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 502);
  }
}

// Everything the UI needs in one call: the queued list (oldest first = next to
// post), recent history, current interval, 24h usage, and when the next post is
// eligible to go out.
async function getState(env, request = null) {
  // Ensure review tables + optional kind column exist.
  await ensureReviewSchema(env);
  await ensureQueueKindColumn(env);
  if (isDemo(env)) {
    try {
      await ensureDemoSeed(env);
    } catch (e) {
      console.error("demo seed failed:", e);
    }
  }
  const settings = await getSettings(env);

  const queued = (
    await env.DB.prepare(
      "SELECT id, text, created_at, kind FROM queue WHERE status = 'queued' ORDER BY created_at ASC"
    ).all()
  ).results;

  const history = (
    await env.DB.prepare(
      "SELECT id, text, status, tweet_id, error, posted_at, created_at, kind FROM queue " +
        "WHERE status IN ('posted','failed') ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 50"
    ).all()
  ).results;

  const historyTotal = (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM queue WHERE status IN ('posted','failed')"
    ).first()
  ).n;

  // Cost estimates use the plain-text X rate only ($0.015). Links are flagged
  // in the UI but not priced into the number.
  let queueEstimateUsd = 0;
  for (const q of queued) {
    q.cost_usd = postCostUsd(q.text);
    queueEstimateUsd += q.cost_usd;
  }
  for (const h of history) {
    if (h.cost_usd == null) h.cost_usd = h.status === "posted" ? postCostUsd(h.text) : 0;
  }
  const totalSpentUsd = (
    await env.DB.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM queue WHERE status = 'posted'"
    ).first()
  ).s;
  const spentPosts = (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM queue WHERE status = 'posted'"
    ).first()
  ).n;

  const count24h = await countRecentPosts(env);
  const now = Date.now();
  // interval_hours === 0 means paused — there is no next eligible time.
  const intervalMs = settings.interval_hours * 60 * 60 * 1000;
  const nextEligibleAt = settings.interval_hours
    ? Math.max(now, (settings.last_posted_at || 0) + intervalMs)
    : null;

  const review = await getReviewState(env);
  const displayCurrency = normalizeCurrency(settings.display_currency);
  const fxRate = resolveFxRate(settings, displayCurrency);

  const result = {
    interval_hours: settings.interval_hours,
    last_posted_at: settings.last_posted_at,
    next_eligible_at: nextEligibleAt,
    count24h,
    daily_cap: DAILY_CAP,
    queued,
    history,
    historyTotal,
    // Currency for cost display (X still bills in USD).
    display_currency: displayCurrency,
    currencies: CURRENCIES,
    fx_rate: fxRate,
    // Legacy field kept so older clients don't break; same as fx_rate when AUD.
    fx_usd_aud: displayCurrency === "AUD" ? fxRate : DEFAULT_FX.AUD,
    cost_text_usd: COST_TEXT_USD,
    cost_link_usd: COST_LINK_USD,
    queue_estimate_usd: queueEstimateUsd,
    total_spent_usd: totalSpentUsd,
    spent_posts: spentPosts,
    review,
    demo: isDemo(env),
    // Review AI generate batch bounds (UI number selector + server clamp).
    ai_gen: {
      min: AI_GEN_MIN,
      max: isDemo(env) ? AI_GEN_MAX_DEMO : AI_GEN_MAX,
      default: isDemo(env) ? AI_GEN_DEFAULT_DEMO : AI_GEN_DEFAULT,
    },
  };
  // Per-IP demo AI usage only when we have the request (omit otherwise so
  // clients can keep their last known remaining counts).
  if (isDemo(env) && request) {
    result.demo_ai = await getDemoAiUsage(env, request);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sparks vault + writing coach
// ---------------------------------------------------------------------------

let sparkSchemaReady = false;
const SPARK_COOL_DEFAULT_MIN = 60;
const SPARK_MAX_TEXT = 4000; // body can be messy; ship path still enforces 280

async function ensureSparkSchema(env) {
  if (sparkSchemaReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS sparks (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "text TEXT NOT NULL, " +
      "status TEXT NOT NULL DEFAULT 'draft', " + // draft | cooling | private | queued | posted
      "cool_until INTEGER, " +
      "created_at INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      "posted_at INTEGER, " +
      "queue_id INTEGER)"
  ).run();
  try {
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_sparks_status ON sparks (status, updated_at)"
    ).run();
  } catch (_) { /* exists */ }
  sparkSchemaReady = true;
}

async function getSparkState(env) {
  try {
    const now = Date.now();
    // Auto-promote cooling → draft when timer elapsed (cheap, on every state read).
    await env.DB.prepare(
      "UPDATE sparks SET status = 'draft', cool_until = NULL, updated_at = ?1 " +
        "WHERE status = 'cooling' AND cool_until IS NOT NULL AND cool_until <= ?1"
    )
      .bind(now)
      .run();

    const items = (
      await env.DB.prepare(
        "SELECT id, text, status, cool_until, created_at, updated_at, posted_at, queue_id " +
          "FROM sparks WHERE status IN ('draft','cooling','private') " +
          "ORDER BY updated_at DESC LIMIT 100"
      ).all()
    ).results;
    const openCount = (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM sparks WHERE status IN ('draft','cooling','private')"
      ).first()
    ).n;
    return {
      items: items || [],
      count: openCount || 0,
    };
  } catch (_) {
    return { items: [], count: 0 };
  }
}

async function createSpark(env, body, request = null) {
  await ensureSparkSchema(env);
  let text = String(body.text || "").trim();
  if (!text) return json({ ok: false, error: "Empty spark." }, 400);
  if (text.length > SPARK_MAX_TEXT) {
    return json({ ok: false, error: `Too long (${text.length}/${SPARK_MAX_TEXT}).` }, 400);
  }
  let coolMin = Number(body.cool_minutes);
  if (!Number.isFinite(coolMin) || coolMin < 0) coolMin = 0;
  coolMin = Math.min(24 * 60, Math.round(coolMin));
  const now = Date.now();
  const status = coolMin > 0 ? "cooling" : "draft";
  const coolUntil = coolMin > 0 ? now + coolMin * 60 * 1000 : null;
  const res = await env.DB.prepare(
    "INSERT INTO sparks (text, status, cool_until, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)"
  )
    .bind(text, status, coolUntil, now)
    .run();
  const id = res.meta && res.meta.last_row_id;
  return json({
    ok: true,
    spark_id: id,
    status,
    cool_until: coolUntil,
    ...(await getState(env, request)),
  });
}

async function updateSpark(env, id, body, request = null) {
  await ensureSparkSchema(env);
  const row = await env.DB.prepare(
    "SELECT id, status FROM sparks WHERE id = ?1"
  )
    .bind(id)
    .first();
  if (!row) return json({ ok: false, error: "Spark not found." }, 404);
  if (row.status === "queued" || row.status === "posted") {
    return json({ ok: false, error: "Spark already shipped." }, 400);
  }

  const now = Date.now();
  const sets = [];
  const binds = [];
  let n = 0;
  const ph = () => "?" + ++n;

  if (body.text != null) {
    const text = String(body.text || "").trim();
    if (!text) return json({ ok: false, error: "Empty spark." }, 400);
    if (text.length > SPARK_MAX_TEXT) {
      return json({ ok: false, error: `Too long (${text.length}/${SPARK_MAX_TEXT}).` }, 400);
    }
    sets.push("text = " + ph());
    binds.push(text);
  }

  if (body.status != null) {
    const st = String(body.status);
    if (!["draft", "cooling", "private"].includes(st)) {
      return json({ ok: false, error: "Invalid status." }, 400);
    }
    sets.push("status = " + ph());
    binds.push(st);
    if (st === "cooling") {
      let coolMin = Number(body.cool_minutes);
      if (!Number.isFinite(coolMin) || coolMin <= 0) coolMin = SPARK_COOL_DEFAULT_MIN;
      coolMin = Math.min(24 * 60, Math.round(coolMin));
      sets.push("cool_until = " + ph());
      binds.push(now + coolMin * 60 * 1000);
    } else {
      sets.push("cool_until = NULL");
    }
  } else if (body.cool_minutes != null) {
    let coolMin = Number(body.cool_minutes);
    if (Number.isFinite(coolMin) && coolMin > 0) {
      coolMin = Math.min(24 * 60, Math.round(coolMin));
      sets.push("status = 'cooling'");
      sets.push("cool_until = " + ph());
      binds.push(now + coolMin * 60 * 1000);
    }
  }

  if (!sets.length) return json({ ok: false, error: "Nothing to update." }, 400);
  sets.push("updated_at = " + ph());
  binds.push(now);
  const idPh = ph();
  binds.push(id);

  await env.DB.prepare("UPDATE sparks SET " + sets.join(", ") + " WHERE id = " + idPh)
    .bind(...binds)
    .run();

  return json({ ok: true, ...(await getState(env, request)) });
}

function sparkShipText(text) {
  text = String(text || "").trim();
  if (!text) return { error: "Empty spark." };
  if (text.length > MAX_TWEET_LEN) {
    return {
      error: `Too long for X (${text.length}/${MAX_TWEET_LEN}). Shorten before queueing or posting.`,
    };
  }
  return { text };
}

async function queueSpark(env, id, request = null) {
  await ensureSparkSchema(env);
  const row = await env.DB.prepare(
    "SELECT id, text, status, cool_until FROM sparks WHERE id = ?1"
  )
    .bind(id)
    .first();
  if (!row) return json({ ok: false, error: "Spark not found." }, 404);
  if (row.status === "queued" || row.status === "posted") {
    return json({ ok: false, error: "Already shipped." }, 400);
  }
  if (row.status === "cooling" && row.cool_until && row.cool_until > Date.now()) {
    return json(
      {
        ok: false,
        error: "Still cooling — wait or clear cool-off first.",
        cool_until: row.cool_until,
      },
      400
    );
  }
  const ship = sparkShipText(row.text);
  if (ship.error) return json({ ok: false, error: ship.error }, 400);

  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO queue (text, status, created_at) VALUES (?1, 'queued', ?2)"
  )
    .bind(ship.text, now)
    .run();
  // Grab the row we just inserted (same text + created_at).
  const qrow = await env.DB.prepare(
    "SELECT id FROM queue WHERE status = 'queued' AND created_at = ?1 AND text = ?2 ORDER BY id DESC LIMIT 1"
  )
    .bind(now, ship.text)
    .first();

  await env.DB.prepare(
    "UPDATE sparks SET status = 'queued', queue_id = ?1, cool_until = NULL, updated_at = ?2 WHERE id = ?3"
  )
    .bind(qrow ? qrow.id : null, now, id)
    .run();

  return json({ ok: true, queued: true, ...(await getState(env, request)) });
}

async function postSparkNow(env, id, request = null) {
  await ensureSparkSchema(env);
  const row = await env.DB.prepare(
    "SELECT id, text, status, cool_until FROM sparks WHERE id = ?1"
  )
    .bind(id)
    .first();
  if (!row) return json({ ok: false, error: "Spark not found." }, 404);
  if (row.status === "posted") {
    return json({ ok: false, error: "Already posted." }, 400);
  }
  if (row.status === "cooling" && row.cool_until && row.cool_until > Date.now()) {
    return json(
      {
        ok: false,
        error: "Still cooling — wait or clear cool-off first.",
        cool_until: row.cool_until,
      },
      400
    );
  }
  const ship = sparkShipText(row.text);
  if (ship.error) return json({ ok: false, error: ship.error }, 400);
  if ((await countRecentPosts(env)) >= DAILY_CAP) {
    return json({ ok: false, error: `Daily cap reached (${DAILY_CAP}/24h).` }, 429);
  }

  const now = Date.now();
  try {
    const tweetId = await postTweet(env, ship.text);
    const ins = await env.DB.prepare(
      "INSERT INTO queue (text, status, created_at, posted_at, tweet_id, cost_usd) VALUES (?1, 'posted', ?2, ?2, ?3, ?4)"
    )
      .bind(ship.text, now, tweetId, postCostUsd(ship.text))
      .run();
    const queueId = ins.meta && ins.meta.last_row_id;
    await env.DB.prepare("UPDATE settings SET last_posted_at = ?1 WHERE id = 1")
      .bind(now)
      .run();
    await env.DB.prepare(
      "UPDATE sparks SET status = 'posted', posted_at = ?1, queue_id = ?2, cool_until = NULL, updated_at = ?1 WHERE id = ?3"
    )
      .bind(now, queueId || null, id)
      .run();
    return json({
      ok: true,
      result: { posted: true, tweet_id: tweetId },
      ...(await getState(env, request)),
    });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 502);
  }
}

// Writing coach: X-native craft. Question + cuts always from AI.
async function coachSpark(env, body, request) {
  if (!env.AI) {
    return json(
      {
        ok: false,
        error: "Workers AI is not bound. Redeploy with [ai] binding = \"AI\" in wrangler.toml.",
      },
      500
    );
  }
  const text = String(body.text || "").trim();
  if (!text) return json({ ok: false, error: "Empty text." }, 400);
  if (text.length > SPARK_MAX_TEXT) {
    return json({ ok: false, error: `Too long (${text.length}/${SPARK_MAX_TEXT}).` }, 400);
  }

  // Cheap lint only (flags / rough scores). Never used as the question source.
  const lint = localCoachLint(text);

  // Demo: 5 coach calls per IP / 24h (server-side). Count only successful runs.
  let demoAi = null;
  if (isDemo(env) && request) {
    demoAi = await getDemoAiUsage(env, request);
    if (demoAi.coach_remaining <= 0) {
      return json(
        {
          ok: false,
          error:
            "Demo coach limit reached (5 per day for your network). Self-host xqueue for unlimited coach.",
          lint,
          demo_ai: demoAi,
        },
        429
      );
    }
  }

  const system = [
    "You are an elite X (Twitter) writing coach. You understand how the platform actually works in 2025-2026: what people stop for, reply to, quote, and repost.",
    "",
    "HOW X WORKS (internalize this):",
    "- People do not share 'smart'. They share something they felt in under 2 seconds, or a line that says what their tribe already believes better than they can.",
    "- Top-performing posts are usually: one clear idea, high emotion or recognition (humor, awe, grief, rage, absurdity, nostalgia, pride), concrete detail, and self-contained enough to screenshot without the author's bio.",
    "- Formats that travel: sharp one-liners, punchy observations about the world, punchlines, open loops, quote-tweet energy, specific scenes, pattern interrupts. Not essays. Not advice threads disguised as tweets.",
    "- Identity beats autobiography. 'us/you/they/this' often spreads harder than diary 'I'. First person is fine WHEN the draft is already personal; never force I/me/my into a draft that is about culture, product, tech, news, humor, or an observation.",
    "- Specific beats abstract. A camera-ready detail beats 'growth', 'mindset', 'journey', 'lesson learned', founder-speak, LinkedIn voice.",
    "- Reply bait is good when it is natural (debatable take, incomplete frame, recognition). Do not add empty CTAs, hashtag spam, or 'thoughts?'.",
    "- Algorithm reality (use for craft, not for sleazy hacks): early replies and quote-worthiness matter more than polishing for 'likes'. Clarity and a strong first line matter more than length.",
    "",
    "YOUR JOB:",
    "- Make THIS draft more likely to land on X as it is: sharper, more specific, more feelable, more shareable.",
    "- Match the draft's POV. If it is not about the author, do NOT ask 'where are you in this' or rewrite it into a personal confession.",
    "- Personal/raw is one lane (lightning posts). Observation, humor, cultural take, tech take, and dry recognition are equal lanes.",
    "- Never push LinkedIn, hustle-bro, generic AI influencer, or corporate brand voice.",
    "- Prefer one emotion or one claim. Cut second ideas.",
    "- Questions should unlock a better LINE for the timeline, not therapy homework. Ask about the missing concrete, the sharper angle, the thing people would quote.",
    "- Cuts must sound like something a human would actually post and others would steal. Same voice as the draft (including whether it uses I or not).",
    "",
    "OUTPUT: a single JSON object only. No markdown fences. No prose outside JSON.",
    "Required keys:",
    '- honesty: "vague" | "personal" | "raw"  (raw = sharp and specific truth; does NOT require first person)',
    '- hook_type: "thesis" | "feeling" | "observation" | "punchline" | "question" | "other"',
    "- single_emotion: boolean",
    "- abstract_flags: string[] (fluffy/abstract words you noticed, max 8, may be empty)",
    "- bone: integer 0-10 (specificity + charge + single idea + screenshot-worthiness; 10 = bone-deep X banger)",
    "- question: string (ONE concrete question, max 22 words, normal capitalization and ? ok). Must improve THIS draft for the timeline. Never generic. Never default to 'make it about you' unless the draft is already personal and under-specified.",
    "- cuts: string[] (EXACTLY 1 or 2 alternate lines). Required. CRITICAL QUALITY BAR FOR CUTS:",
    "  · Each cut must be a FINISHED post you would ship as-is, not a half-step rewrite",
    "  · Each cut must score bone 8-10 if you re-scored it yourself: specific, charged, one idea, screenshotable",
    "  · If you cannot beat the draft on bone, return the draft tightened (still house style) rather than a weaker line",
    "  · Do not output soft, vague, or 'safer' versions that would fail your own bone meter - that creates an endless rewrite loop",
    "  · FORM MATCH (non-negotiable): preserve the draft's rhetorical form",
    "    - If the draft is a question or mostly questions, EVERY cut must stay a question (end with ?). Never convert Qs into hot-take statements.",
    "    - If the draft is a statement, cuts stay statements (unless a question is clearly sharper and the draft already invites one).",
    "    - If the draft mixes forms, keep the dominant form; do not flatten curiosity into a lecture.",
    "    - Questions on X often outperform statements of the same idea because they invite replies. Do not 'fix' a good question into a claim.",
    "  · Under 280 chars each",
    "  · House style for cuts ONLY:",
    "    - ALWAYS all lowercase (no capitals, even for names/brands, unless a URL requires it)",
    "    - NEVER end a cut with a full stop/period. Mid-line periods between sentences are fine; ? and ! are fine when they carry tone. Ellipsis (...) is fine",
    "    - NEVER use em dashes or en dashes; use a comma, period, or hyphen (-) instead",
    "    - Keep the draft's point of view; do not inject fake autobiography",
    "- note: string (one short craft note about X-readiness: hook, specificity, charge, or clarity. No engagement-hacking jargon.)",
  ].join("\n");

  const draftIsQuestion =
    /\?/.test(text) &&
    (text.match(/\?/g) || []).length >= Math.max(1, (text.match(/[.!]/g) || []).length);
  const formHint = draftIsQuestion
    ? "FORM: this draft is question-led. Your cuts MUST remain questions (end with ?). Do not rewrite into statements."
    : "FORM: match the draft (statement vs question). Do not change form without a clear win.";

  const user = [
    "Coach this draft for X. Return JSON only.",
    "Optimize for real timeline behavior (stop, feel, quote, reply), not for making it a diary entry.",
    "Your cuts will replace the draft when the author taps them. They must already be high-bone finished posts, not drafts that will score poorly next pass.",
    formHint,
    "",
    "DRAFT:",
    text,
    "",
    text.length > MAX_TWEET_LEN
      ? `(${text.length} chars - over ${MAX_TWEET_LEN}; at least one cut must be a single post-ready line under ${MAX_TWEET_LEN}.)`
      : `(${text.length}/${MAX_TWEET_LEN} chars)`,
  ].join("\n");

  // guided_json forces valid structure — avoids "Couldn't parse" on drafts that end
  // with punctuation (models otherwise often emit prose or broken JSON).
  const coachSchema = {
    type: "object",
    properties: {
      honesty: { type: "string", enum: ["vague", "personal", "raw"] },
      hook_type: {
        type: "string",
        enum: ["thesis", "feeling", "observation", "punchline", "question", "other"],
      },
      single_emotion: { type: "boolean" },
      abstract_flags: { type: "array", items: { type: "string" } },
      bone: { type: "integer", minimum: 0, maximum: 10 },
      question: { type: "string" },
      cuts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
      note: { type: "string" },
    },
    required: ["honesty", "hook_type", "bone", "question", "cuts", "note"],
  };

  let raw;
  try {
    raw = await env.AI.run(AI_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 900,
      temperature: 0.45,
      guided_json: coachSchema,
    });
  } catch (err) {
    // Retry once without guided_json if the runtime rejects the schema param.
    const msg = String(err && err.message ? err.message : err);
    if (/guided|schema|json|parameter|invalid/i.test(msg)) {
      try {
        raw = await env.AI.run(AI_MODEL, {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: 900,
          temperature: 0.45,
        });
      } catch (err2) {
        const msg2 = String(err2 && err2.message ? err2.message : err2);
        if (/neuron|quota|limit|429/i.test(msg2)) {
          return json(
            { ok: false, error: "AI quota hit (Neurons). Try again later.", lint },
            429
          );
        }
        return json({ ok: false, error: "AI request failed: " + msg2, lint }, 502);
      }
    } else if (/neuron|quota|limit|429/i.test(msg)) {
      return json(
        { ok: false, error: "AI quota hit (Neurons). Try again later.", lint },
        429
      );
    } else {
      return json({ ok: false, error: "AI request failed: " + msg, lint }, 502);
    }
  }

  const extracted = extractAiText(raw);
  const parsed = parseCoachJson(extracted, lint);
  if (!parsed || !parsed.question) {
    return json(
      {
        ok: false,
        error: "Couldn't parse coach response. Try again.",
        lint,
        debug: String(extracted || "").slice(0, 280),
      },
      502
    );
  }

  // Enforce form match: question-led drafts must keep ? on every cut (models love
  // turning curiosity into hot-take statements).
  if (draftIsQuestion && parsed.cuts && parsed.cuts.length) {
    parsed.cuts = parsed.cuts
      .map((c) => {
        let line = String(c || "").trim();
        if (!line) return "";
        if (!line.includes("?")) {
          line = line.replace(/[.!]+$/g, "").trim();
          if (line) line = line + "?";
        }
        return normalizeDraftStyle(line);
      })
      .filter(Boolean)
      .slice(0, 2);
  }

  if (isDemo(env) && request) {
    demoAi = await recordDemoAiCall(env, request, "coach");
  }

  return json({
    ok: true,
    coach: { ...parsed, source: "ai" },
    model: AI_MODEL,
    demo_ai: demoAi,
  });
}

// Local lint only — abstract flags + rough scores. No hardcoded questions.
function localCoachLint(text) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  const ABSTRACT = [
    "growth",
    "mindset",
    "journey",
    "hustle",
    "grind",
    "leverage",
    "synergy",
    "optimize",
    "productivity",
    "success",
    "abundance",
    "manifest",
    "unlock",
    "scale",
    "disrupt",
    "value prop",
    "build in public",
    "lessons learned",
    "key takeaway",
    "game changer",
  ];
  const abstract_flags = ABSTRACT.filter((w) => lower.includes(w)).slice(0, 8);
  const hasI = /\b(i|i'm|i’ve|i've|me|my)\b/i.test(t);
  const hasConcrete =
    /\b(\d+|am|pm|today|yesterday|tonight|morning|night|ago|years?|months?|weeks?|days?|hours?)\b/i.test(
      t
    ) || /\b(said|told|walked|sat|stood|looked|heard|felt|cried|laughed)\b/i.test(t);
  // "raw" = sharp + specific, not "must be about me"
  let honesty = "vague";
  if (hasConcrete && abstract_flags.length === 0) honesty = hasI ? "raw" : "personal";
  else if (hasI || (hasConcrete && t.length < 140)) honesty = "personal";
  if (abstract_flags.length && !hasConcrete) honesty = "vague";

  let hook_type = "other";
  if (/\?\s*$/.test(t.trim())) hook_type = "question";
  else if (/^(yeah|honestly|i |my |when |after |before )/i.test(t.trim())) hook_type = "feeling";
  else if (/\b(is|are|means|because)\b/i.test(t) && t.length > 80) hook_type = "thesis";
  else if (t.length < 120) hook_type = "observation";

  let bone = 5;
  if (hasConcrete) bone += 2;
  if (abstract_flags.length) bone -= Math.min(3, abstract_flags.length);
  if (t.length > MAX_TWEET_LEN) bone -= 1;
  if (t.length > 0 && t.length <= 120 && hasConcrete) bone += 1;
  bone = Math.max(0, Math.min(10, bone));

  return {
    honesty,
    hook_type,
    single_emotion: !/\band also\b|\bplus\b|\bhowever\b/i.test(t),
    abstract_flags,
    bone,
  };
}

function parseCoachJson(raw, lint) {
  // Already a coach object (guided_json / structured output)
  if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw.question || raw.cuts)) {
    return finalizeCoachObject(raw, lint);
  }

  let s = String(raw || "").trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Prefer outermost JSON object
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  // Common model glitches
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Smart quotes → plain (sometimes breaks JSON.parse)
  s = s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");

  let o;
  try {
    o = JSON.parse(s);
  } catch (_) {
    // Sometimes models nest the object as a string field
    try {
      const again = JSON.parse(
        String(raw || "")
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim()
      );
      if (again && typeof again === "object" && (again.question || again.cuts)) o = again;
      else return null;
    } catch (__) {
      // Last resort: pull "question":"..." with a regex
      const qm = s.match(/"question"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (qm && qm[1]) {
        o = {
          honesty: lint && lint.honesty,
          hook_type: lint && lint.hook_type,
          bone: lint && lint.bone,
          question: qm[1].replace(/\\"/g, '"').replace(/\\n/g, " "),
          cuts: [],
          note: "",
          abstract_flags: (lint && lint.abstract_flags) || [],
          single_emotion: true,
        };
        const cutsBlock = s.match(/"cuts"\s*:\s*\[([\s\S]*?)\]/);
        if (cutsBlock) {
          const parts = cutsBlock[1].match(/"((?:\\.|[^"\\])*)"/g) || [];
          o.cuts = parts.map((p) => p.slice(1, -1).replace(/\\"/g, '"'));
        }
      } else {
        return null;
      }
    }
  }
  if (!o || typeof o !== "object") return null;
  return finalizeCoachObject(o, lint);
}

function finalizeCoachObject(o, lint) {
  if (!o || typeof o !== "object") return null;

  const honesty = ["vague", "personal", "raw"].includes(o.honesty)
    ? o.honesty
    : lint && lint.honesty
      ? lint.honesty
      : "personal";
  const hook_type = [
    "thesis",
    "feeling",
    "observation",
    "punchline",
    "question",
    "other",
  ].includes(o.hook_type)
    ? o.hook_type
    : lint && lint.hook_type
      ? lint.hook_type
      : "other";
  let bone = Number(o.bone);
  if (!Number.isFinite(bone)) bone = lint && lint.bone != null ? lint.bone : 5;
  bone = Math.max(0, Math.min(10, Math.round(bone)));

  const abstract_flags = Array.isArray(o.abstract_flags)
    ? o.abstract_flags.map((x) => String(x)).filter(Boolean).slice(0, 8)
    : lint && lint.abstract_flags
      ? lint.abstract_flags
      : [];

  // Allow slightly over-280 cuts (trim later in UI if needed); prefer keeping suggestions.
  let cuts = [];
  if (Array.isArray(o.cuts)) {
    cuts = o.cuts.map((x) => String(x || "").trim()).filter(Boolean);
  } else if (typeof o.cuts === "string" && o.cuts.trim()) {
    cuts = [o.cuts.trim()];
  } else if (o.suggestion) {
    cuts = [String(o.suggestion).trim()].filter(Boolean);
  } else if (Array.isArray(o.suggestions)) {
    cuts = o.suggestions.map((x) => String(x || "").trim()).filter(Boolean);
  }
  // Enforce the same house style as Review AI drafts: lowercase, no terminal period.
  cuts = cuts
    .map((c) => normalizeDraftStyle(c))
    .map((c) => (c.length > MAX_TWEET_LEN ? c.slice(0, MAX_TWEET_LEN).trim() : c))
    .map((c) => stripTrailingPeriod(c)) // re-strip if length slice reintroduced edge cases
    .filter(Boolean)
    .slice(0, 2);

  const question = String(o.question || o.q || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);
  const note = String(o.note || "")
    .trim()
    .slice(0, 280);

  if (!question) return null;

  return {
    honesty,
    hook_type,
    single_emotion: o.single_emotion !== false,
    abstract_flags,
    bone,
    question,
    cuts,
    note,
  };
}

// ---------------------------------------------------------------------------
// Review deck
// ---------------------------------------------------------------------------

// Per-isolate flag so we don't re-run CREATE IF NOT EXISTS on every /api/state.
let reviewSchemaReady = false;

async function ensureReviewSchema(env) {
  if (reviewSchemaReady) return;
  // Idempotent — safe if schema.sql was already applied.
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS review_items (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "text TEXT NOT NULL, " +
        "position INTEGER NOT NULL, " +
        "created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS review_undo (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), " +
        "action TEXT, " +
        "text TEXT, " +
        "queue_id INTEGER, " +
        "position INTEGER, " +
        "created_at INTEGER)"
    ),
    env.DB.prepare("INSERT OR IGNORE INTO review_undo (id) VALUES (1)"),
  ]);
  try {
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_review_position ON review_items (position, id)"
    ).run();
  } catch (_) { /* already exists */ }
  reviewSchemaReady = true;
}

async function getReviewState(env) {
  try {
    const items = (
      await env.DB.prepare(
        "SELECT id, text, position, created_at FROM review_items ORDER BY position ASC, id ASC"
      ).all()
    ).results;
    const undo = await env.DB.prepare(
      "SELECT action, text, queue_id, position, created_at FROM review_undo WHERE id = 1"
    ).first();
    let overCount = 0;
    for (const it of items) {
      if (String(it.text || "").length > MAX_TWEET_LEN) overCount++;
    }
    return {
      items: items || [],
      count: (items || []).length,
      overCount,
      canUndo: !!(undo && undo.action),
    };
  } catch (_) {
    // Tables not created yet — treat as empty deck.
    return { items: [], count: 0, overCount: 0, canUndo: false };
  }
}

// Draft N posts with Workers AI, using recent posted + queued text as voice samples.
// Lands in the Review deck (append by default) so you can swipe/edit before queueing.
async function generateReviewDrafts(env, body, request) {
  if (!env.AI) {
    return json(
      { ok: false, error: "Workers AI is not bound. Redeploy with [ai] binding = \"AI\" in wrangler.toml." },
      500
    );
  }

  // Demo: small generate cap per IP / 24h (separate from coach's 5).
  if (isDemo(env) && request) {
    const demoAi = await getDemoAiUsage(env, request);
    if (demoAi.generate_remaining <= 0) {
      return json(
        {
          ok: false,
          error:
            "Demo AI generate limit reached (2 per day for your network). Self-host for unlimited generate.",
          demo_ai: demoAi,
        },
        429
      );
    }
  }

  const genMax = isDemo(env) ? AI_GEN_MAX_DEMO : AI_GEN_MAX;
  const genDefault = isDemo(env) ? AI_GEN_DEFAULT_DEMO : AI_GEN_DEFAULT;
  let count = Number(body.count);
  if (!Number.isFinite(count)) count = genDefault;
  count = Math.max(AI_GEN_MIN, Math.min(genMax, Math.round(count)));
  const mode = body.mode === "replace" ? "replace" : "append";
  const topic = String(body.topic || "").trim().slice(0, 400);

  const posted = (
    await env.DB.prepare(
      "SELECT text FROM queue WHERE status = 'posted' ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 40"
    ).all()
  ).results;
  const queued = (
    await env.DB.prepare(
      "SELECT text FROM queue WHERE status = 'queued' ORDER BY created_at DESC LIMIT 25"
    ).all()
  ).results;
  const pending = (
    await env.DB.prepare(
      "SELECT text FROM review_items ORDER BY position ASC LIMIT 20"
    ).all()
  ).results;

  const fmtBlock = (rows, label) => {
    if (!rows || !rows.length) return `(no ${label} yet)`;
    return rows
      .map((r, i) => `${i + 1}. ${String(r.text || "").trim()}`)
      .filter((line) => line.length > 3)
      .join("\n");
  };

  const system = [
    "You write original X/Twitter posts for a single private account.",
    "Match the author's voice, tone, humor, length, and topics from the samples.",
    "Rules:",
    `- Exactly ${count} separate posts. Never merge two ideas into one post.`,
    `- Each post is ONE idea only. If you have two jokes or two observations, they are TWO posts.`,
    `- Each post under ${MAX_TWEET_LEN} characters (hard limit). Prefer one short line per post.`,
    "- NEVER repeat the same sentence twice inside one post.",
    "- ALWAYS all lowercase. Never use capital letters (not even at the start of a sentence or for names/brands unless a URL requires it).",
    "- NEVER use em dashes (—) or en dashes (–). Use a comma, period, or a normal hyphen (-) instead.",
    "- No trailing full stop/period at the end of a post. End clean — mid-post periods between sentences are fine; ? and ! are fine when they carry tone.",
    "- No numbering in the post body. No hashtag spam. No 'thread 1/n'. No emojis unless samples use them often.",
    "- Do not copy samples verbatim. Do not invent fake URLs.",
    "- Avoid links unless samples clearly use them (links cost more to post).",
    "- Output format: return JSON only, shape {\"posts\":[\"post one\",\"post two\",...]} with exactly " +
      count +
      " strings. No markdown fences, no commentary.",
  ].join("\n");

  const userParts = [
    "=== Recent posted (newest first) ===",
    fmtBlock(posted, "posted history"),
    "",
    "=== Currently queued (not yet posted) ===",
    fmtBlock(queued, "queued posts"),
    "",
    "=== Already in review deck (avoid near-duplicates) ===",
    fmtBlock(pending, "review drafts"),
    "",
    topic
      ? `Theme / direction for this batch: ${topic}`
      : "Theme: continue in the same vein as the samples — fresh angles, same personality.",
    "",
    `Write exactly ${count} new posts now as JSON: {"posts":["..."]} with ${count} separate one-idea strings.`,
  ];

  const genSchema = {
    type: "object",
    properties: {
      posts: {
        type: "array",
        items: { type: "string" },
        minItems: count,
        maxItems: count,
      },
    },
    required: ["posts"],
  };

  let raw;
  try {
    raw = await env.AI.run(AI_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: userParts.join("\n") },
      ],
      max_tokens: Math.min(4096, 80 + count * 140),
      temperature: 0.85,
      guided_json: genSchema,
    });
  } catch (err) {
    // Retry once without guided_json if the runtime rejects the schema param.
    const msg = String(err && err.message ? err.message : err);
    if (/guided|schema|json|parameter|invalid/i.test(msg)) {
      try {
        raw = await env.AI.run(AI_MODEL, {
          messages: [
            { role: "system", content: system },
            { role: "user", content: userParts.join("\n") },
          ],
          max_tokens: Math.min(4096, 80 + count * 140),
          temperature: 0.85,
        });
      } catch (err2) {
        const msg2 = String(err2 && err2.message ? err2.message : err2);
        if (/neuron|quota|limit|429/i.test(msg2)) {
          return json(
            { ok: false, error: "AI quota hit (Neurons). Try again tomorrow or upgrade Workers Paid." },
            429
          );
        }
        return json({ ok: false, error: "AI request failed: " + msg2 }, 502);
      }
    } else if (/neuron|quota|limit|429/i.test(msg)) {
      return json(
        { ok: false, error: "AI quota hit (Neurons). Try again tomorrow or upgrade Workers Paid." },
        429
      );
    } else {
      return json({ ok: false, error: "AI request failed: " + msg }, 502);
    }
  }

  let text = extractAiText(raw);
  // guided_json may return { posts: [...] } as an object
  if (text && typeof text === "object") {
    if (Array.isArray(text.posts)) {
      text = JSON.stringify({ posts: text.posts });
    } else if (Array.isArray(text)) {
      text = JSON.stringify({ posts: text });
    } else {
      text = JSON.stringify(text);
    }
  }
  text = String(text || "");
  if (!text.trim()) {
    return json({ ok: false, error: "AI returned empty text. Try again." }, 502);
  }

  const posts = parseGeneratedPosts(text, count);
  if (!posts.length) {
    return json(
      { ok: false, error: "Couldn't parse posts from AI output. Try again or lower the count." },
      502
    );
  }

  // Reuse seed path; surface generated list for debugging/toasts.
  const seeded = await seedReview(env, posts, mode, request);
  // seedReview returns a Response — re-wrap with generate metadata.
  const data = await seeded.json();
  let demoAi = null;
  if (isDemo(env) && request) {
    demoAi = await recordDemoAiCall(env, request, "generate");
  }
  return json({
    ...data,
    generated: posts.length,
    model: AI_MODEL,
    topic: topic || null,
    demo_ai: demoAi,
  });
}

function extractAiText(result) {
  if (result == null) return "";
  // Structured coach object (guided_json may return fields at top level)
  if (typeof result === "object" && !Array.isArray(result) && (result.question || result.cuts)) {
    return result;
  }
  if (typeof result === "string") return result;
  if (typeof result.response === "string") return result.response;
  if (result.response && typeof result.response === "object") return result.response;
  if (typeof result.text === "string") return result.text;
  if (typeof result.output_text === "string") return result.output_text;
  if (result.result != null) {
    if (typeof result.result === "string") return result.result;
    if (typeof result.result.response === "string") return result.result.response;
    if (typeof result.result.text === "string") return result.result.text;
    if (typeof result.result === "object" && (result.result.question || result.result.cuts)) {
      return result.result;
    }
  }
  // Some runtimes return message content arrays
  if (result.message) {
    if (typeof result.message.content === "string") return result.message.content;
    if (Array.isArray(result.message.content)) {
      return result.message.content
        .map((p) => (typeof p === "string" ? p : p && p.text != null ? String(p.text) : ""))
        .join("");
    }
  }
  if (Array.isArray(result.output)) {
    return result.output
      .map((chunk) => {
        if (typeof chunk === "string") return chunk;
        if (chunk && typeof chunk.content === "string") return chunk.content;
        if (chunk && Array.isArray(chunk.content)) {
          return chunk.content
            .map((p) => (typeof p === "string" ? p : p && p.text != null ? String(p.text) : ""))
            .join("");
        }
        return "";
      })
      .join("");
  }
  try {
    return JSON.stringify(result);
  } catch (_) {
    return "";
  }
}

// Pull discrete posts out of model output (JSON {posts}, array, blank-line blocks, or lines).
function parseGeneratedPosts(text, want) {
  text = String(text || "").trim();
  // Strip common markdown fences
  text = text.replace(/^```(?:json|text)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let candidates = [];

  // JSON object { "posts": ["...", ...] } (preferred)
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (obj && Array.isArray(obj.posts)) {
        candidates = obj.posts.map((x) =>
          typeof x === "string" ? x : x && x.text != null ? String(x.text) : String(x)
        );
      } else if (obj && Array.isArray(obj.items)) {
        candidates = obj.items.map((x) =>
          typeof x === "string" ? x : x && x.text != null ? String(x.text) : String(x)
        );
      }
    } catch (_) { /* fall through */ }
  }

  // JSON array of strings
  if (!candidates.length && text.startsWith("[")) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        candidates = arr.map((x) =>
          typeof x === "string" ? x : x && x.text != null ? String(x.text) : String(x)
        );
      }
    } catch (_) { /* fall through */ }
  }

  // Loose recovery: "posts":[ ... ] buried in prose
  if (!candidates.length) {
    const m = text.match(/"posts"\s*:\s*(\[[\s\S]*\])/);
    if (m) {
      try {
        const arr = JSON.parse(m[1]);
        if (Array.isArray(arr)) {
          candidates = arr.map((x) =>
            typeof x === "string" ? x : x && x.text != null ? String(x.text) : String(x)
          );
        }
      } catch (_) { /* fall through */ }
    }
  }

  if (!candidates.length) {
    // Blank-line separated blocks
    const blocks = text.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length >= 2) {
      candidates = blocks.map((b) =>
        b
          .replace(/^\s*[-*•]\s+/gm, "")
          .replace(/^\s*\d+[.)]\s+/gm, "")
          .trim()
      );
    } else {
      // One-per-line fallback
      candidates = text
        .split(/\r?\n/)
        .map((l) =>
          l
            .replace(/^\s*[-*•]\s+/, "")
            .replace(/^\s*\d+[.)]\s+/, "")
            .trim()
        )
        .filter(Boolean);
    }
  }

  // Expand blobs where the model jammed two posts into one (multi-line or near-dupe).
  const expanded = [];
  for (const c of candidates) {
    for (const part of explodeMergedPost(c)) expanded.push(part);
  }
  candidates = expanded;

  const out = [];
  const seen = new Set();
  for (let t of candidates) {
    t = String(t || "").trim();
    if (!t) continue;
    // Drop leftover labels
    if (/^(here are|posts?:|output:)/i.test(t) && t.length < 40) continue;
    // Models often insert markdown horizontal rules as separators (---, ***, ___).
    if (/^[-–—*_=~]{2,}$/.test(t)) continue;
    // Unwrap model wrapper quotes only when both ends match (keeps real edge quotes).
    t = unwrapOuterQuotes(t);
    // Drop repeated sentences inside one post (common model glitch).
    t = dedupeNearDuplicateSentences(t);
    // House style: always lowercase; no em/en dashes (model may ignore prompt rules).
    t = normalizeDraftStyle(t);
    if (!t) continue;
    // Re-check after normalize (em dashes may collapse into ---)
    if (/^[-–—*_=~]{2,}$/.test(t)) continue;
    if (t.length > MAX_TWEET_LEN) t = t.slice(0, MAX_TWEET_LEN).trim();
    const key = t.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    // Near-duplicate of an earlier post (typo variants)
    let dupe = false;
    for (const prev of seen) {
      if (nearDuplicateText(prev, key)) {
        dupe = true;
        break;
      }
    }
    if (dupe) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= want) break;
  }
  return out;
}

// If the model put two posts in one string (newline-separated standalone lines), split them.
function explodeMergedPost(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const lines = t
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s+/, "").replace(/^\s*\d+[.)]\s+/, "").trim())
    .filter(Boolean);
  if (lines.length >= 2) {
    // Each line looks like its own post (not a soft wrap of one thought).
    const standalone = lines.every(
      (l) => l.length >= 24 && l.length <= MAX_TWEET_LEN && !/^(and|or|but|so|because|which)\b/i.test(l)
    );
    if (standalone) return lines;
  }
  return [t];
}

// Remove consecutive / near-duplicate sentences the model pasted twice in one post.
function dedupeNearDuplicateSentences(text) {
  let s = String(text || "").trim();
  if (!s) return s;
  // Split on sentence end while keeping simple structure
  const parts = s.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    // Also handle "idea. idea" without relying on lookbehind if empty split
    return s;
  }
  const kept = [];
  for (const p of parts) {
    const norm = p.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    let isDupe = false;
    for (const k of kept) {
      const kn = k.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      if (nearDuplicateText(kn, norm)) {
        isDupe = true;
        break;
      }
    }
    if (!isDupe) kept.push(p);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

function nearDuplicateText(a, b) {
  a = String(a || "").toLowerCase().replace(/\s+/g, " ").trim();
  b = String(b || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  // One contains the other and lengths are close
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 20 && longer.includes(shorter) && longer.length - shorter.length < shorter.length * 0.4) {
    return true;
  }
  // Token Jaccard for typo-ish repeats ("instrcutor" vs "instructor")
  const tok = (s) =>
    new Set(
      s
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  const j = inter / union;
  return j >= 0.72 && Math.min(a.length, b.length) >= 24;
}

// Models often wrap each post in quotes ("…", '…', “…”). Only strip when BOTH
// ends are a matching pair so intentional leading/trailing quotes stay put —
// e.g. `"never bet…" is still true` or `he said "we're done"`.
function unwrapOuterQuotes(text) {
  let s = String(text || "").trim();
  if (s.length < 2) return s;

  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ["\u201c", "\u201d"], // “ ”
    ["\u2018", "\u2019"], // ‘ ’
  ];

  // Unwrap at most a couple of layers (e.g. ""post"").
  for (let layer = 0; layer < 2; layer++) {
    let peeled = false;
    for (const [open, close] of pairs) {
      if (s.length < open.length + close.length + 1) continue;
      if (!s.startsWith(open) || !s.endsWith(close)) continue;
      const inner = s.slice(open.length, s.length - close.length).trim();
      if (!inner) continue;
      s = inner;
      peeled = true;
      break;
    }
    if (!peeled) break;
  }
  return s;
}

// Enforce xqueue draft house style after the model responds.
function normalizeDraftStyle(text) {
  return stripTrailingPeriod(
    String(text || "")
      .replace(/[\u2014\u2013]/g, "-") // em dash / en dash → hyphen
      .replace(/\s+-\s+/g, " - ") // tidy spaced hyphens
      .toLowerCase()
      .trim()
  );
}

// House style: no obligatory terminal full stop. Keeps ellipsis (... / …),
// ? and !, and any internal periods between sentences.
function stripTrailingPeriod(text) {
  const s = String(text || "");
  if (!s.endsWith(".")) return s;
  // Preserve deliberate ellipsis
  if (s.endsWith("...") || s.endsWith("…")) return s;
  // "word…." or "word...." — leave multi-dot endings alone
  if (/\.\.$/.test(s)) return s;
  return s.slice(0, -1).trimEnd();
}

async function seedReview(env, texts, mode, request = null) {
  const clean = [];
  let skippedEmpty = 0;
  let overCount = 0;
  for (let t of texts) {
    t = String(t == null ? "" : t).trim();
    if (!t) {
      skippedEmpty++;
      continue;
    }
    if (t.length > MAX_TWEET_LEN) overCount++;
    clean.push(t);
  }

  if (mode === "replace") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM review_items"),
      env.DB.prepare(
        "UPDATE review_undo SET action = NULL, text = NULL, queue_id = NULL, position = NULL, created_at = NULL WHERE id = 1"
      ),
    ]);
  }

  if (clean.length) {
    let startPos = 0;
    if (mode === "append") {
      const row = await env.DB.prepare(
        "SELECT COALESCE(MAX(position), -1) AS m FROM review_items"
      ).first();
      startPos = (row && typeof row.m === "number" ? row.m : -1) + 1;
    }
    const now = Date.now();
    // D1 batch has a practical size limit; chunk inserts.
    const CHUNK = 50;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const slice = clean.slice(i, i + CHUNK);
      await env.DB.batch(
        slice.map((t, j) =>
          env.DB.prepare(
            "INSERT INTO review_items (text, position, created_at) VALUES (?1, ?2, ?3)"
          ).bind(t, startPos + i + j, now + i + j)
        )
      );
    }
  }

  return json({
    ok: true,
    added: clean.length,
    skippedEmpty,
    overCount,
    ...(await getState(env, request)),
  });
}

async function editReviewItem(env, id, text, request = null) {
  // Deck may hold over-280 drafts (import or mid-edit). Empty is not allowed.
  text = String(text == null ? "" : text);
  // Preserve intentional whitespace only at ends via trim for emptiness check,
  // but store the trimmed form so accept validation is consistent.
  text = text.trim();
  if (!text) return json({ ok: false, error: "Empty post." }, 400);
  const res = await env.DB.prepare(
    "UPDATE review_items SET text = ?1 WHERE id = ?2"
  )
    .bind(text, id)
    .run();
  if (!res.meta || res.meta.changes === 0) {
    return json({ ok: false, error: "Review item not found." }, 404);
  }
  return json({ ok: true, ...(await getState(env, request)) });
}

async function acceptReviewItem(env, id, overrideText, request = null) {
  const item = await env.DB.prepare(
    "SELECT id, text, position FROM review_items WHERE id = ?1"
  )
    .bind(id)
    .first();
  if (!item) return json({ ok: false, error: "Review item not found." }, 404);

  let text = overrideText != null ? String(overrideText).trim() : String(item.text || "").trim();
  if (!text) return json({ ok: false, error: "Empty post." }, 400);
  if (text.length > MAX_TWEET_LEN) {
    return json(
      { ok: false, error: `Too long (${text.length}/${MAX_TWEET_LEN}). Edit it down first.` },
      400
    );
  }

  // If the client sent a final edit, persist it on the item first (in case accept fails later).
  if (overrideText != null && text !== item.text) {
    await env.DB.prepare("UPDATE review_items SET text = ?1 WHERE id = ?2")
      .bind(text, id)
      .run();
  }

  const now = Date.now();
  const ins = await env.DB.prepare(
    "INSERT INTO queue (text, status, created_at) VALUES (?1, 'queued', ?2)"
  )
    .bind(text, now)
    .run();
  // D1 returns last_row_id on meta for inserts; fall back to a lookup if missing.
  let queueId =
    ins && ins.meta
      ? ins.meta.last_row_id != null
        ? ins.meta.last_row_id
        : ins.meta.lastRowId
      : null;
  if (queueId == null) {
    const found = await env.DB.prepare(
      "SELECT id FROM queue WHERE status = 'queued' AND text = ?1 AND created_at = ?2 LIMIT 1"
    )
      .bind(text, now)
      .first();
    queueId = found ? found.id : null;
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM review_items WHERE id = ?1").bind(id),
    env.DB.prepare(
      "UPDATE review_undo SET action = ?1, text = ?2, queue_id = ?3, position = ?4, created_at = ?5 WHERE id = 1"
    ).bind("accept", text, queueId != null ? queueId : null, item.position, now),
  ]);

  return json({ ok: true, ...(await getState(env, request)) });
}

async function rejectReviewItem(env, id, request = null) {
  const item = await env.DB.prepare(
    "SELECT id, text, position FROM review_items WHERE id = ?1"
  )
    .bind(id)
    .first();
  if (!item) return json({ ok: false, error: "Review item not found." }, 404);

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM review_items WHERE id = ?1").bind(id),
    env.DB.prepare(
      "UPDATE review_undo SET action = ?1, text = ?2, queue_id = NULL, position = ?3, created_at = ?4 WHERE id = 1"
    ).bind("reject", item.text, item.position, now),
  ]);

  return json({ ok: true, ...(await getState(env, request)) });
}

async function undoReview(env, request = null) {
  const undo = await env.DB.prepare(
    "SELECT action, text, queue_id, position, created_at FROM review_undo WHERE id = 1"
  ).first();
  if (!undo || !undo.action) {
    return json({ ok: false, error: "Nothing to undo." }, 400);
  }

  const now = Date.now();

  if (undo.action === "accept") {
    // Only undo if the queued row is still waiting (not posted/deleted).
    if (undo.queue_id != null) {
      const row = await env.DB.prepare(
        "SELECT id FROM queue WHERE id = ?1 AND status = 'queued'"
      )
        .bind(undo.queue_id)
        .first();
      if (!row) {
        await env.DB.prepare(
          "UPDATE review_undo SET action = NULL, text = NULL, queue_id = NULL, position = NULL, created_at = NULL WHERE id = 1"
        ).run();
        return json(
          { ok: false, error: "Already posted or removed — can't undo." },
          409
        );
      }
      await env.DB.prepare("DELETE FROM queue WHERE id = ?1 AND status = 'queued'")
        .bind(undo.queue_id)
        .run();
    }
  }

  // Put the card back at the front of the deck so it's shown again immediately.
  const minRow = await env.DB.prepare(
    "SELECT MIN(position) AS m FROM review_items"
  ).first();
  const frontPos =
    minRow && minRow.m != null ? Number(minRow.m) - 1 : undo.position != null ? undo.position : 0;

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO review_items (text, position, created_at) VALUES (?1, ?2, ?3)"
    ).bind(undo.text || "", frontPos, now),
    env.DB.prepare(
      "UPDATE review_undo SET action = NULL, text = NULL, queue_id = NULL, position = NULL, created_at = NULL WHERE id = 1"
    ),
  ]);

  return json({ ok: true, ...(await getState(env, request)) });
}

// ---------------------------------------------------------------------------
// Scheduler (cron) + posting
// ---------------------------------------------------------------------------

async function runScheduler(env) {
  // Housekeeping: drop stale rate-limit rows so the table stays tiny.
  try {
    await env.DB.prepare("DELETE FROM auth_attempts WHERE ts < ?1")
      .bind(Date.now() - AUTH_WINDOW_MS)
      .run();
  } catch (e) {
    console.error("auth_attempts cleanup failed:", e);
  }
  try {
    await env.DB.prepare("DELETE FROM demo_ai_calls WHERE ts < ?1")
      .bind(Date.now() - DEMO_AI_WINDOW_MS)
      .run();
  } catch (e) {
    // Table may not exist yet on older DBs until first AI call.
    if (!/no such table/i.test(String(e && e.message ? e.message : e))) {
      console.error("demo_ai_calls cleanup failed:", e);
    }
  }
  // Keep the USD->AUD rate fresh (isolated so an FX outage never blocks posting).
  try {
    await refreshFx(env);
  } catch (e) {
    console.error("fx refresh failed:", e);
  }
  try {
    return await postNext(env, { ignoreInterval: false });
  } catch (err) {
    console.error("scheduler error:", err);
    return { skipped: "error", error: String(err) };
  }
}

// Core posting decision. Shared by the cron and the manual "post now" button.
async function postNext(env, { ignoreInterval }) {
  const settings = await getSettings(env);
  const now = Date.now();

  // 1. Enough time elapsed since the last post? (cron only)
  if (!ignoreInterval) {
    // Paused (interval_hours === 0): the cron never auto-posts. Manual "post
    // now" paths pass ignoreInterval, so they still fire while paused.
    if (!settings.interval_hours) return { skipped: "paused" };
    const intervalMs = settings.interval_hours * 60 * 60 * 1000;
    if (now - (settings.last_posted_at || 0) < intervalMs) {
      return { skipped: "interval" };
    }
  }

  // 2. Under the daily cap? Protects even the 1h toggle from hitting X's wall.
  if ((await countRecentPosts(env)) >= DAILY_CAP) {
    return { skipped: "daily_cap" };
  }

  // 3. Anything to post?
  const item = (
    await env.DB.prepare(
      "SELECT id, text, attempts FROM queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
    ).first()
  );
  if (!item) return { skipped: "empty" };

  // 4. Post it.
  try {
    const tweetId = await postTweet(env, item.text);
    await env.DB.prepare(
      "UPDATE queue SET status = 'posted', posted_at = ?1, tweet_id = ?2, error = NULL, cost_usd = ?3 WHERE id = ?4"
    )
      .bind(now, tweetId, postCostUsd(item.text), item.id)
      .run();
    await env.DB.prepare("UPDATE settings SET last_posted_at = ?1 WHERE id = 1")
      .bind(now)
      .run();
    return { posted: true, id: item.id, tweet_id: tweetId };
  } catch (err) {
    const attempts = (item.attempts || 0) + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    // On failure we do NOT advance last_posted_at, so a transient error retries
    // on the next cron. After MAX_ATTEMPTS we mark it failed so it stops
    // blocking the queue.
    await env.DB.prepare(
      "UPDATE queue SET attempts = ?1, error = ?2, status = ?3 WHERE id = ?4"
    )
      .bind(attempts, String(err && err.message ? err.message : err), failed ? "failed" : "queued", item.id)
      .run();
    return { posted: false, id: item.id, error: String(err), failed };
  }
}

async function countRecentPosts(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM queue WHERE status = 'posted' AND posted_at > ?1"
  )
    .bind(Date.now() - DAY_MS)
    .first();
  return row ? row.n : 0;
}

async function getSettings(env) {
  await ensureSettingsSchema(env);
  const s = await env.DB.prepare(
    "SELECT interval_hours, last_posted_at, fx_usd_aud, fx_updated_at, display_currency, fx_rate FROM settings WHERE id = 1"
  ).first();
  return (
    s || {
      interval_hours: DEFAULT_INTERVAL_HOURS,
      last_posted_at: null,
      fx_usd_aud: null,
      fx_updated_at: null,
      display_currency: DEFAULT_CURRENCY,
      fx_rate: 1,
    }
  );
}

let settingsSchemaReady = false;

// Lazy columns for currency (CREATE IF NOT EXISTS won't add columns).
async function ensureSettingsSchema(env) {
  if (settingsSchemaReady) return;
  try {
    await env.DB.prepare(
      "ALTER TABLE settings ADD COLUMN display_currency TEXT"
    ).run();
  } catch (_) {
    /* already exists */
  }
  try {
    await env.DB.prepare("ALTER TABLE settings ADD COLUMN fx_rate REAL").run();
  } catch (_) {
    /* already exists */
  }
  // Default currency to USD when null (existing installs may have AUD-era rows).
  try {
    await env.DB.prepare(
      "UPDATE settings SET display_currency = ?1 WHERE id = 1 AND (display_currency IS NULL OR display_currency = '')"
    )
      .bind(DEFAULT_CURRENCY)
      .run();
  } catch (_) {
    /* ignore */
  }
  settingsSchemaReady = true;
}

function normalizeCurrency(code) {
  const c = String(code || "").toUpperCase();
  return CURRENCIES.includes(c) ? c : DEFAULT_CURRENCY;
}

function resolveFxRate(settings, currency) {
  const cur = normalizeCurrency(currency);
  if (cur === "USD") return 1;
  if (settings && typeof settings.fx_rate === "number" && settings.fx_rate > 0) {
    // fx_rate is for the currently selected display_currency.
    if (normalizeCurrency(settings.display_currency) === cur) return settings.fx_rate;
  }
  // Legacy: only AUD rate was cached as fx_usd_aud.
  if (cur === "AUD" && settings && typeof settings.fx_usd_aud === "number" && settings.fx_usd_aud > 0) {
    return settings.fx_usd_aud;
  }
  return DEFAULT_FX[cur] || 1;
}

function isDemo(env) {
  const v = env && env.DEMO;
  return v === "1" || v === "true" || v === true;
}

function clientIp(request) {
  if (!request || !request.headers) return "unknown";
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

let demoAiSchemaReady = false;

async function ensureDemoAiSchema(env) {
  if (demoAiSchemaReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS demo_ai_calls (" +
      "ip TEXT NOT NULL, " +
      "kind TEXT NOT NULL, " +
      "ts INTEGER NOT NULL)"
  ).run();
  try {
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_demo_ai_ip_kind_ts ON demo_ai_calls (ip, kind, ts)"
    ).run();
  } catch (_) {
    /* exists */
  }
  demoAiSchemaReady = true;
}

// request may be null when called from getState without a request context —
// then we only return limits (used=0). Prefer passing request for real counts.
async function getDemoAiUsage(env, request) {
  await ensureDemoAiSchema(env);
  const ip = request ? clientIp(request) : null;
  const since = Date.now() - DEMO_AI_WINDOW_MS;
  let coachUsed = 0;
  let generateUsed = 0;
  if (ip) {
    const coach = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM demo_ai_calls WHERE ip = ?1 AND kind = 'coach' AND ts > ?2"
    )
      .bind(ip, since)
      .first();
    const gen = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM demo_ai_calls WHERE ip = ?1 AND kind = 'generate' AND ts > ?2"
    )
      .bind(ip, since)
      .first();
    coachUsed = coach ? coach.n : 0;
    generateUsed = gen ? gen.n : 0;
  }
  return {
    coach_used: coachUsed,
    coach_limit: DEMO_AI_COACH_LIMIT,
    coach_remaining: Math.max(0, DEMO_AI_COACH_LIMIT - coachUsed),
    generate_used: generateUsed,
    generate_limit: DEMO_AI_GENERATE_LIMIT,
    generate_remaining: Math.max(0, DEMO_AI_GENERATE_LIMIT - generateUsed),
    window_hours: 24,
  };
}

async function recordDemoAiCall(env, request, kind) {
  await ensureDemoAiSchema(env);
  const ip = clientIp(request);
  const k = kind === "generate" ? "generate" : "coach";
  await env.DB.prepare(
    "INSERT INTO demo_ai_calls (ip, kind, ts) VALUES (?1, ?2, ?3)"
  )
    .bind(ip, k, Date.now())
    .run();
  return getDemoAiUsage(env, request);
}

// One-time sample queue for public demos so the UI isn't empty.
async function ensureDemoSeed(env) {
  await ensureReviewSchema(env);
  const now = Date.now();

  // Queue: only seed a brand-new empty DB (not after someone drained it).
  const queued = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM queue WHERE status = 'queued'"
  ).first();
  const anyQueue = await env.DB.prepare("SELECT COUNT(*) AS n FROM queue").first();
  if ((!queued || queued.n === 0) && (!anyQueue || anyQueue.n === 0)) {
    const queueSamples = [
      "shipping something small every day beats waiting for the perfect launch",
      "the queue is the product - write once, drip on a schedule",
      "plain text posts stay cheap - save the links for replies",
      "coach on: honesty first, virality never the goal",
      "one idea per post. if it needs a thread, it needs another draft",
    ];
    await env.DB.batch(
      queueSamples.map((text, i) =>
        env.DB.prepare(
          "INSERT INTO queue (text, status, created_at, kind) VALUES (?1, 'queued', ?2, NULL)"
        ).bind(text, now + i)
      )
    );
  }

  // Review deck: seed sample cards when empty so visitors can try swipe triage.
  const review = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM review_items"
  ).first();
  if (!review || review.n === 0) {
    const reviewSamples = [
      "most productivity advice is just anxiety with a checklist",
      "the best feature is the one you did not ship",
      "if the draft needs a thread it probably needs a second idea cut",
      "post the specific number. vague honesty is still vague",
      "your timeline does not owe you a personality arc",
      "delete the second sentence. that was the whole post",
    ];
    await env.DB.batch(
      reviewSamples.map((text, i) =>
        env.DB.prepare(
          "INSERT INTO review_items (text, position, created_at) VALUES (?1, ?2, ?3)"
        ).bind(text, i, now + i)
      )
    );
  }
}

// ---------------------------------------------------------------------------
// X API — OAuth 1.0a user-context POST /2/tweets
// ---------------------------------------------------------------------------

async function postTweet(env, text) {
  // Demo mode: pretend the post succeeded. No X credentials required.
  if (isDemo(env)) {
    return "demo_" + Date.now().toString(36);
  }
  for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) {
    if (!env[k]) throw new Error(`Missing secret ${k}`);
  }
  const authHeader = await buildOAuthHeader(env, "POST", X_POST_URL);
  const res = await fetch(X_POST_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`X API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data && data.data ? data.data.id : null;
}

// Build the OAuth 1.0a Authorization header. For POST /2/tweets the JSON body
// is NOT part of the signature base string — only the method, URL, and oauth_*
// params are signed.
async function buildOAuthHeader(env, method, urlStr) {
  const oauth = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };

  const paramString = Object.keys(oauth)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(oauth[k])}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    pctEncode(urlStr),
    pctEncode(paramString),
  ].join("&");

  const signingKey = `${pctEncode(env.X_API_SECRET)}&${pctEncode(env.X_ACCESS_SECRET)}`;
  oauth.oauth_signature = await hmacSha1(signingKey, baseString);

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`)
      .join(", ")
  );
}

// RFC 3986 percent-encoding (encodeURIComponent leaves !*'() alone).
function pctEncode(str) {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

async function hmacSha1(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ---------------------------------------------------------------------------

// Auth gate: locks out an IP after too many failed passphrase attempts in a
// sliding window, then constant-time compares the provided secret.
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILS = 10;

async function checkAuth(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ?1 AND ts > ?2"
  )
    .bind(ip, now - AUTH_WINDOW_MS)
    .first();
  if (row && row.n >= AUTH_MAX_FAILS) {
    return { ok: false, status: 429, error: "Too many attempts. Try again in a few minutes." };
  }

  const provided = request.headers.get("x-app-secret") || "";
  if (!timingSafeEqual(provided, env.APP_SECRET)) {
    await env.DB.prepare("INSERT INTO auth_attempts (ip, ts) VALUES (?1, ?2)")
      .bind(ip, now)
      .run();
    return { ok: false, status: 401, error: "Incorrect passphrase." };
  }
  return { ok: true };
}

// Heuristic: does a post look like it contains a URL? Used only for UI warnings.
// Cost estimates stay at the plain-text rate regardless.
function hasLink(text) {
  return (
    /(https?:\/\/|www\.)\S+/i.test(text) ||
    /\b[a-z0-9-]+\.(com|net|org|io|co|ai|app|dev|xyz|me|gg|so|to|tv|info|link|page|site|news|blog|store|shop)\b/i.test(text)
  );
}

// Always the plain-text X rate. Not real billing — just a rough estimate.
function postCostUsd(_text) {
  return COST_TEXT_USD;
}

// Refresh the cached USD→display-currency rate (frankfurter / ECB, no key).
// No-op if the cached rate is still fresh (unless force). Failures are for the caller.
async function refreshFx(env, opts = {}) {
  await ensureSettingsSchema(env);
  const s = await getSettings(env);
  const currency = normalizeCurrency(s.display_currency);
  const now = Date.now();

  if (currency === "USD") {
    if (s.fx_rate !== 1 || !s.fx_updated_at) {
      await env.DB.prepare(
        "UPDATE settings SET fx_rate = 1, fx_usd_aud = ?1, fx_updated_at = ?2, display_currency = 'USD' WHERE id = 1"
      )
        .bind(DEFAULT_FX.AUD, now)
        .run();
    }
    return;
  }

  const fresh =
    !opts.force &&
    s.fx_rate &&
    s.fx_updated_at &&
    now - s.fx_updated_at < FX_MAX_AGE_MS &&
    normalizeCurrency(s.display_currency) === currency;
  if (fresh) return;

  const res = await fetch(FX_URL, { headers: { accept: "application/json" } });
  if (!res.ok) return;
  const data = await res.json();
  const rates = (data && data.rates) || {};
  const rate = rates[currency];
  if (typeof rate !== "number" || rate <= 0) return;

  // Keep fx_usd_aud filled for any code still reading the legacy column.
  const audRate =
    typeof rates.AUD === "number" && rates.AUD > 0 ? rates.AUD : DEFAULT_FX.AUD;

  await env.DB.prepare(
    "UPDATE settings SET fx_rate = ?1, fx_usd_aud = ?2, fx_updated_at = ?3 WHERE id = 1"
  )
    .bind(rate, audRate, now)
    .run();
}

// Constant-time string compare (avoids leaking match progress via timing).
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
