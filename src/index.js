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

// X pay-per-use pricing (USD). A post with a link costs ~13x a plain one.
const COST_TEXT_USD = 0.015;
const COST_LINK_USD = 0.2;
const DEFAULT_FX_USD_AUD = 1.44; // fallback until the cron fetches a live rate
const FX_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD";
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
  if (env.APP_SECRET) {
    const gate = await checkAuth(request, env);
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);
  }

  try {
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/api/state" && method === "GET") {
      return json({ ok: true, ...(await getState(env)) });
    }

    // Older history pages for the "Load more" button. Cursor-based on the
    // coalesced timestamp (not OFFSET) so a fresh post at the top never shifts
    // the boundary and causes a skipped/duplicated row.
    if (pathname === "/api/history" && method === "GET") {
      const before = Number(url.searchParams.get("before")) || Date.now();
      const rows = (
        await env.DB.prepare(
          "SELECT id, text, status, tweet_id, error, posted_at, created_at FROM queue " +
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
      return await addToQueue(env, String(body.text || ""));
    }

    // Bulk import: add many posts at once. Body: { texts: string[] }.
    if (pathname === "/api/queue/bulk" && method === "POST") {
      const body = await request.json();
      return await addBulk(env, Array.isArray(body.texts) ? body.texts : []);
    }

    // /api/queue/:id  (DELETE)
    const del = pathname.match(/^\/api\/queue\/(\d+)$/);
    if (del && method === "DELETE") {
      await env.DB.prepare("DELETE FROM queue WHERE id = ?1 AND status = 'queued'")
        .bind(Number(del[1]))
        .run();
      return json({ ok: true, ...(await getState(env)) });
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
      return json({ ok: true, ...(await getState(env)) });
    }

    // Reorder a queued post up/down one slot by swapping timestamps with its
    // neighbor. Body: { dir: "up" | "down" }.
    const mv = pathname.match(/^\/api\/queue\/(\d+)\/move$/);
    if (mv && method === "POST") {
      const body = await request.json();
      return await moveQueued(env, Number(mv[1]), body.dir === "down" ? "down" : "up");
    }

    // Post a specific queued item immediately (still respects the daily cap).
    const pn = pathname.match(/^\/api\/queue\/(\d+)\/post-now$/);
    if (pn && method === "POST") {
      return await postQueuedNow(env, Number(pn[1]));
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
      return json({ ok: true, ...(await getState(env)) });
    }

    // Post the top of the queue right now (still respects the daily cap).
    if (pathname === "/api/post-now" && method === "POST") {
      const result = await postNext(env, { ignoreInterval: true });
      return json({ ok: true, result, ...(await getState(env)) });
    }

    // Post an arbitrary typed post immediately (the "NOW" / POST button), instead
    // of adding it to the queue. Records it in history and counts toward the cap.
    if (pathname === "/api/post-text" && method === "POST") {
      const body = await request.json();
      return await postTextNow(env, String(body.text || ""));
    }

    return json({ ok: false, error: "Not found." }, 404);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
  }
}

async function addToQueue(env, text) {
  text = text.trim();
  if (!text) return json({ ok: false, error: "Empty post." }, 400);
  if (text.length > MAX_TWEET_LEN) {
    return json({ ok: false, error: `Too long (${text.length}/${MAX_TWEET_LEN}).` }, 400);
  }
  await env.DB.prepare(
    "INSERT INTO queue (text, status, created_at) VALUES (?1, 'queued', ?2)"
  )
    .bind(text, Date.now())
    .run();
  return json({ ok: true, ...(await getState(env)) });
}

// Post a specific queued item right now, bypassing queue order and the interval
// (still respects the daily cap). On success it becomes a 'posted' row and resets
// the interval clock; on failure it stays queued so nothing is lost.
async function postQueuedNow(env, id) {
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
    return json({ ok: true, result: { posted: true, tweet_id: tweetId }, ...(await getState(env)) });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 502);
  }
}

// Swap a queued post with its adjacent neighbor (by created_at) to reorder it.
// Ordering is by created_at ASC, so "up" = earlier timestamp, "down" = later.
async function moveQueued(env, id, dir) {
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
  return json({ ok: true, ...(await getState(env)) });
}

// Bulk insert. Validates each entry; too-long / empty ones are skipped and
// counted so the UI can report them. created_at is spaced by 1ms per item so
// paste order is preserved in the queue.
async function addBulk(env, texts) {
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
    ...(await getState(env)),
  });
}

// Post typed text right now, bypassing the queue. Respects the daily cap. On
// success it's recorded as a 'posted' row (so it shows in history and counts
// toward the 24h cap) and resets the interval clock so the queue keeps spacing.
async function postTextNow(env, text) {
  text = text.trim();
  if (!text) return json({ ok: false, error: "Empty post." }, 400);
  if (text.length > MAX_TWEET_LEN) {
    return json({ ok: false, error: `Too long (${text.length}/${MAX_TWEET_LEN}).` }, 400);
  }
  if ((await countRecentPosts(env)) >= DAILY_CAP) {
    return json({ ok: false, error: `Daily cap reached (${DAILY_CAP}/24h).` }, 429);
  }
  const now = Date.now();
  try {
    const tweetId = await postTweet(env, text);
    await env.DB.prepare(
      "INSERT INTO queue (text, status, created_at, posted_at, tweet_id, cost_usd) VALUES (?1, 'posted', ?2, ?2, ?3, ?4)"
    )
      .bind(text, now, tweetId, postCostUsd(text))
      .run();
    await env.DB.prepare("UPDATE settings SET last_posted_at = ?1 WHERE id = 1")
      .bind(now)
      .run();
    return json({ ok: true, result: { posted: true, tweet_id: tweetId }, ...(await getState(env)) });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 502);
  }
}

// Everything the UI needs in one call: the queued list (oldest first = next to
// post), recent history, current interval, 24h usage, and when the next post is
// eligible to go out.
async function getState(env) {
  const settings = await getSettings(env);

  const queued = (
    await env.DB.prepare(
      "SELECT id, text, created_at FROM queue WHERE status = 'queued' ORDER BY created_at ASC"
    ).all()
  ).results;

  const history = (
    await env.DB.prepare(
      "SELECT id, text, status, tweet_id, error, posted_at, created_at FROM queue " +
        "WHERE status IN ('posted','failed') ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 50"
    ).all()
  ).results;

  const historyTotal = (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM queue WHERE status IN ('posted','failed')"
    ).first()
  ).n;

  // Cost estimates. Per-item cost is attached to each row; queued uses the
  // live heuristic, posted uses the stored charge (falling back to the
  // heuristic for rows saved before cost tracking existed).
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

  return {
    interval_hours: settings.interval_hours,
    last_posted_at: settings.last_posted_at,
    next_eligible_at: nextEligibleAt,
    count24h,
    daily_cap: DAILY_CAP,
    queued,
    history,
    historyTotal,
    fx_usd_aud: settings.fx_usd_aud || DEFAULT_FX_USD_AUD,
    queue_estimate_usd: queueEstimateUsd,
    total_spent_usd: totalSpentUsd,
    spent_posts: spentPosts,
  };
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
  const s = await env.DB.prepare(
    "SELECT interval_hours, last_posted_at, fx_usd_aud, fx_updated_at FROM settings WHERE id = 1"
  ).first();
  return s || { interval_hours: 3, last_posted_at: null, fx_usd_aud: null, fx_updated_at: null };
}

// ---------------------------------------------------------------------------
// X API — OAuth 1.0a user-context POST /2/tweets
// ---------------------------------------------------------------------------

async function postTweet(env, text) {
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

// Heuristic: does a post contain a URL/link? X charges $0.20 for link posts vs
// $0.015 for plain text/media, so this drives the cost estimate.
function hasLink(text) {
  return (
    /(https?:\/\/|www\.)\S+/i.test(text) ||
    /\b[a-z0-9-]+\.(com|net|org|io|co|ai|app|dev|xyz|me|gg|so|to|tv|info|link|page|site|news|blog|store|shop)\b/i.test(text)
  );
}

function postCostUsd(text) {
  return hasLink(text) ? COST_LINK_USD : COST_TEXT_USD;
}

// Refresh the cached USD->AUD rate from a free FX API (ECB data, no key).
// No-op if the cached rate is still fresh. Failures are swallowed by the caller.
async function refreshFx(env) {
  const s = await getSettings(env);
  const now = Date.now();
  if (s.fx_usd_aud && s.fx_updated_at && now - s.fx_updated_at < FX_MAX_AGE_MS) return;
  const res = await fetch(FX_URL, { headers: { accept: "application/json" } });
  if (!res.ok) return;
  const data = await res.json();
  const rate = data && data.rates && data.rates.AUD;
  if (typeof rate === "number" && rate > 0) {
    await env.DB.prepare("UPDATE settings SET fx_usd_aud = ?1, fx_updated_at = ?2 WHERE id = 1")
      .bind(rate, now)
      .run();
  }
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
