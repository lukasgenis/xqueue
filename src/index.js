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
  // Shared-secret gate. If APP_SECRET isn't configured, the API is open — we
  // warn rather than silently allow, since this thing can post to your account.
  if (env.APP_SECRET) {
    const provided = request.headers.get("x-app-secret") || "";
    if (provided !== env.APP_SECRET) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }
  }

  if (!env.DB) return json({ ok: false, error: "Database not wired up." }, 500);

  try {
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/api/state" && method === "GET") {
      return json({ ok: true, ...(await getState(env)) });
    }

    if (pathname === "/api/queue" && method === "POST") {
      const body = await request.json();
      return await addToQueue(env, String(body.text || ""));
    }

    // /api/queue/:id  (DELETE)
    const del = pathname.match(/^\/api\/queue\/(\d+)$/);
    if (del && method === "DELETE") {
      await env.DB.prepare("DELETE FROM queue WHERE id = ?1 AND status = 'queued'")
        .bind(Number(del[1]))
        .run();
      return json({ ok: true, ...(await getState(env)) });
    }

    if (pathname === "/api/interval" && method === "POST") {
      const body = await request.json();
      const hours = Number(body.hours);
      if (![1, 3, 6, 9, 12, 24].includes(hours)) {
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
        "WHERE status IN ('posted','failed') ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 25"
    ).all()
  ).results;

  const count24h = await countRecentPosts(env);
  const now = Date.now();
  const intervalMs = settings.interval_hours * 60 * 60 * 1000;
  const nextEligibleAt = Math.max(now, (settings.last_posted_at || 0) + intervalMs);

  return {
    interval_hours: settings.interval_hours,
    last_posted_at: settings.last_posted_at,
    next_eligible_at: nextEligibleAt,
    count24h,
    daily_cap: DAILY_CAP,
    queued,
    history,
  };
}

// ---------------------------------------------------------------------------
// Scheduler (cron) + posting
// ---------------------------------------------------------------------------

async function runScheduler(env) {
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
      "UPDATE queue SET status = 'posted', posted_at = ?1, tweet_id = ?2, error = NULL WHERE id = ?3"
    )
      .bind(now, tweetId, item.id)
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
    "SELECT interval_hours, last_posted_at FROM settings WHERE id = 1"
  ).first();
  return s || { interval_hours: 3, last_posted_at: null };
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
