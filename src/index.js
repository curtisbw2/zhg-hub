import Anthropic from "@anthropic-ai/sdk";

const SERVER_INFO = { name: "zhg-hub-worker", version: "1.0.0" };

// CORS: lets the Substack bookmarklet call the hub from substack.com.
// Mutating tools stay protected by QUEUE_TOKEN, so open CORS adds no new risk
// beyond what the already-public endpoint allows.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });

function requireParams(params, names) {
  const missing = names.filter((n) => params[n] === undefined || params[n] === null || params[n] === "");
  if (missing.length) {
    const err = new Error(`Missing required params: ${missing.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const VISION_PROMPT =
  "This is a media asset for The Zero Hour Group, a defense and drone-focused research and media company. " +
  "Describe what you see in detail — any equipment, branding, people, text, or context visible. " +
  "Be specific about any defense or drone-related content.";

async function embedText(env, text) {
  const resp = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [text] });
  const vector = resp?.data?.[0];
  if (!vector || !vector.length) throw new Error("Embedding generation failed");
  return vector;
}

async function describeImage(env, b64, mediaType) {
  if (!env.ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY is not configured on this Worker");
    err.status = 500;
    throw err;
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
          { type: "text", text: VISION_PROMPT }
        ]
      }
    ]
  });
  return message.content.find((b) => b.type === "text")?.text ?? "";
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function searchAssets(env, params) {
  requireParams(params, ["query"]);
  const { query, folder, type, limit = 10 } = params;
  const like = `%${query}%`;

  let sql = "SELECT * FROM assets WHERE (filename LIKE ?1 OR tags LIKE ?1 OR summary LIKE ?1)";
  const bindings = [like];
  if (folder) {
    bindings.push(folder);
    sql += ` AND folder = ?${bindings.length}`;
  }
  if (type) {
    bindings.push(type);
    sql += ` AND type = ?${bindings.length}`;
  }
  bindings.push(Math.min(Number(limit) || 10, 100));
  sql += ` ORDER BY uploaded_at DESC LIMIT ?${bindings.length}`;

  const { results } = await env.ZHG_DB.prepare(sql).bind(...bindings).all();
  return { count: results.length, results };
}

async function getFile(env, params) {
  requireParams(params, ["r2_key"]);
  const { r2_key } = params;

  const obj = await env.ZHG_BUCKET.get(r2_key);
  if (!obj) {
    const err = new Error(`No object found in R2 for key: ${r2_key}`);
    err.status = 404;
    throw err;
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return {
    r2_key,
    filename: r2_key.split("/").pop(),
    content_type: obj.httpMetadata?.contentType || "application/octet-stream",
    size: bytes.length,
    file_base64: bytesToBase64(bytes)
  };
}

async function uploadFile(env, params) {
  requireParams(params, ["filename", "folder", "type", "file_base64", "content_type"]);
  const {
    filename, folder, type,
    tags = "", summary = "", uploaded_by = "",
    file_base64, content_type
  } = params;

  const r2_key = `${folder.replace(/\/+$/, "")}/${filename}`;
  const bytes = base64ToBytes(file_base64);

  await env.ZHG_BUCKET.put(r2_key, bytes, {
    httpMetadata: { contentType: content_type }
  });

  const uploaded_at = new Date().toISOString();
  const row = await env.ZHG_DB.prepare(
    `INSERT INTO assets (filename, r2_key, type, folder, tags, summary, uploaded_at, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(r2_key) DO UPDATE SET
       filename = excluded.filename,
       type = excluded.type,
       folder = excluded.folder,
       tags = excluded.tags,
       summary = excluded.summary,
       uploaded_at = excluded.uploaded_at,
       uploaded_by = excluded.uploaded_by
     RETURNING id, r2_key`
  ).bind(filename, r2_key, type, folder, tags, summary, uploaded_at, uploaded_by).first();

  // Images get an automatic vision description written into the summary column
  let finalSummary = summary;
  let vision_summary = false;
  if (IMAGE_TYPES.has(content_type)) {
    try {
      finalSummary = await describeImage(env, file_base64, content_type);
      await env.ZHG_DB.prepare("UPDATE assets SET summary = ? WHERE id = ?")
        .bind(finalSummary, row.id).run();
      vision_summary = true;
    } catch (e) {
      // Vision failure shouldn't fail the upload; asset keeps the provided summary
    }
  }

  // Embed metadata (+ generated summary) for semantic search
  let embedded = false;
  try {
    const vector = await embedText(env, `${filename} ${folder} ${tags} ${finalSummary}`);
    await env.ZHG_VECTORS.upsert([
      { id: String(row.id), values: vector, metadata: { r2_key, folder, type } }
    ]);
    embedded = true;
  } catch (e) {
    // Embedding failure shouldn't fail the upload
  }

  return { id: row.id, r2_key: row.r2_key, size: bytes.length, uploaded_at, vision_summary, embedded };
}

async function semanticSearch(env, params) {
  requireParams(params, ["query"]);
  const { query, limit = 10 } = params;
  const topK = Math.min(Number(limit) || 10, 20);

  const vector = await embedText(env, query);
  const res = await env.ZHG_VECTORS.query(vector, { topK });
  const matches = res?.matches || [];
  if (!matches.length) return { count: 0, results: [] };

  const ids = matches.map((m) => Number(m.id)).filter(Number.isFinite);
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.ZHG_DB
    .prepare(`SELECT * FROM assets WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all();

  const byId = new Map(results.map((r) => [r.id, r]));
  const ordered = matches
    .map((m) => {
      const row = byId.get(Number(m.id));
      return row ? { ...row, score: m.score } : null;
    })
    .filter(Boolean);

  return { count: ordered.length, results: ordered };
}

async function listRecent(env, params) {
  const { limit = 20, folder, type } = params;

  let sql = "SELECT * FROM assets";
  const bindings = [];
  const where = [];
  if (folder) {
    bindings.push(folder);
    where.push(`folder = ?${bindings.length}`);
  }
  if (type) {
    bindings.push(type);
    where.push(`type = ?${bindings.length}`);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  bindings.push(Math.min(Number(limit) || 20, 100));
  sql += ` ORDER BY uploaded_at DESC LIMIT ?${bindings.length}`;

  const { results } = await env.ZHG_DB.prepare(sql).bind(...bindings).all();
  return { count: results.length, results };
}

// Cap text sent to the summarizer so huge docs don't blow the request
const MAX_SUMMARY_INPUT_CHARS = 100_000;

async function summarizeContent(env, params) {
  requireParams(params, ["r2_key"]);
  const { r2_key } = params;

  if (!env.ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY is not configured on this Worker");
    err.status = 500;
    throw err;
  }

  const obj = await env.ZHG_BUCKET.get(r2_key);
  if (!obj) {
    const err = new Error(`No object found in R2 for key: ${r2_key}`);
    err.status = 404;
    throw err;
  }

  // Images get a vision description instead of text summarization
  const contentType = obj.httpMetadata?.contentType || "";
  if (IMAGE_TYPES.has(contentType)) {
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const summary = await describeImage(env, bytesToBase64(bytes), contentType);
    return { r2_key, summary, kind: "image" };
  }

  let text = await obj.text();
  let truncated = false;
  if (text.length > MAX_SUMMARY_INPUT_CHARS) {
    text = text.slice(0, MAX_SUMMARY_INPUT_CHARS);
    truncated = true;
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Provide a concise summary of the following document. Focus on what it is, what it covers, and any key facts or action items.\n\n<document filename="${r2_key}">\n${text}\n</document>`
      }
    ]
  });

  const summary = message.content.find((b) => b.type === "text")?.text ?? "";
  return { r2_key, summary, truncated, kind: "text" };
}

async function tagAsset(env, params) {
  requireParams(params, ["r2_key", "tags"]);
  const { r2_key, tags } = params;

  const row = await env.ZHG_DB.prepare(
    "UPDATE assets SET tags = ? WHERE r2_key = ? RETURNING *"
  ).bind(tags, r2_key).first();

  if (!row) {
    const err = new Error(`No asset found in D1 for key: ${r2_key}`);
    err.status = 404;
    throw err;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Notes queue (posting pipeline)
// ---------------------------------------------------------------------------

const NOTE_PLATFORMS = ["x", "substack"];
const X_CHAR_LIMIT = 280;
const TCO_URL_LENGTH = 23;

// X counts every URL as 23 chars (t.co wrapping)
function xEffectiveLength(text) {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, "x".repeat(TCO_URL_LENGTH));
  return [...withoutUrls].length;
}

function normalizePlatforms(raw) {
  const list = String(raw || "x,substack")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const bad = list.filter((p) => !NOTE_PLATFORMS.includes(p));
  if (!list.length || bad.length) {
    const err = new Error(`platforms must be a comma-separated subset of: ${NOTE_PLATFORMS.join(", ")}`);
    err.status = 400;
    throw err;
  }
  return [...new Set(list)].join(",");
}

function validateXLength(note) {
  if (!note.platforms.includes("x")) return;
  const text = note.body_x || note.body;
  const len = xEffectiveLength(text);
  if (len > X_CHAR_LIMIT) {
    const err = new Error(
      `X text is ${len} chars (limit ${X_CHAR_LIMIT}). Shorten body_x (or body), or drop x from platforms.`
    );
    err.status = 400;
    throw err;
  }
}

function requireQueueToken(env, params) {
  if (!env.QUEUE_TOKEN) {
    const err = new Error("QUEUE_TOKEN is not configured on this Worker");
    err.status = 500;
    throw err;
  }
  if (params.token !== env.QUEUE_TOKEN) {
    const err = new Error("Invalid or missing queue token");
    err.status = 401;
    throw err;
  }
}

// TEMPORARILY DISABLED: flip to true to restore Discord pings (also requires
// the DISCORD_WEBHOOK_URL secret to be set on the Worker).
const DISCORD_PINGS_ENABLED = false;

function notifyDiscord(env, toolCtx, content) {
  if (!DISCORD_PINGS_ENABLED) return;
  if (!env.DISCORD_WEBHOOK_URL) return;
  const p = fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  }).catch(() => {});
  if (toolCtx?.waitUntil) toolCtx.waitUntil(p);
}

async function getSetting(env, key, fallback) {
  const row = await env.ZHG_DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : fallback;
}

async function setSetting(env, key, value) {
  await env.ZHG_DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

async function queueNote(env, params, toolCtx) {
  requireParams(params, ["body"]);
  const {
    body, body_x = null, body_substack = null,
    scheduled_at = null, topic = null, created_by = null
  } = params;
  const platforms = normalizePlatforms(params.platforms);
  validateXLength({ body, body_x, platforms });

  const created_at = new Date().toISOString();
  const row = await env.ZHG_DB.prepare(
    `INSERT INTO notes_queue (body, body_x, body_substack, platforms, status, topic, scheduled_at, created_at, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
     RETURNING *`
  ).bind(body, body_x, body_substack, platforms, topic, scheduled_at, created_at, created_by).first();

  const preview = body.length > 140 ? `${body.slice(0, 140)}...` : body;
  notifyDiscord(
    env, toolCtx,
    `📝 **New ZHG note draft #${row.id}** (${platforms})\n> ${preview.replace(/\n/g, " ")}\nPost it with: post_note id ${row.id}`
  );

  return row;
}

async function getQueue(env, params) {
  const { status, limit = 50 } = params;
  if (status && !["draft", "scheduled", "approved", "rejected", "posted", "failed"].includes(status)) {
    const err = new Error("status must be one of: draft, scheduled, approved, rejected, posted, failed");
    err.status = 400;
    throw err;
  }

  let sql = "SELECT * FROM notes_queue";
  const bindings = [];
  if (status) {
    bindings.push(status);
    sql += " WHERE status = ?1";
  }
  bindings.push(Math.min(Number(limit) || 50, 200));
  sql += ` ORDER BY id DESC LIMIT ?${bindings.length}`;

  const { results } = await env.ZHG_DB.prepare(sql).bind(...bindings).all();
  const paused = (await getSetting(env, "posting_paused", "0")) === "1";
  return { paused, count: results.length, results };
}

const NOTE_EDITABLE_FIELDS = ["body", "body_x", "body_substack", "platforms", "scheduled_at", "topic"];

async function updateNote(env, params) {
  requireQueueToken(env, params);
  requireParams(params, ["id"]);

  const existing = await env.ZHG_DB.prepare("SELECT * FROM notes_queue WHERE id = ?").bind(params.id).first();
  if (!existing) {
    const err = new Error(`No note found with id ${params.id}`);
    err.status = 404;
    throw err;
  }
  if (!["draft", "approved", "failed"].includes(existing.status)) {
    const err = new Error(`Cannot edit a note with status '${existing.status}'`);
    err.status = 400;
    throw err;
  }

  const updates = {};
  for (const f of NOTE_EDITABLE_FIELDS) {
    if (params[f] !== undefined) updates[f] = params[f];
  }
  if (!Object.keys(updates).length) {
    const err = new Error(`Nothing to update. Editable fields: ${NOTE_EDITABLE_FIELDS.join(", ")}`);
    err.status = 400;
    throw err;
  }
  if (updates.platforms !== undefined) updates.platforms = normalizePlatforms(updates.platforms);

  const merged = { ...existing, ...updates };
  validateXLength(merged);

  const setClauses = Object.keys(updates).map((f, i) => `${f} = ?${i + 1}`);
  const bindings = Object.values(updates);
  bindings.push(params.id);
  const row = await env.ZHG_DB.prepare(
    `UPDATE notes_queue SET ${setClauses.join(", ")} WHERE id = ?${bindings.length} RETURNING *`
  ).bind(...bindings).first();
  return row;
}

async function reviewNote(env, params, toolCtx) {
  requireQueueToken(env, params);
  requireParams(params, ["id", "action"]);
  const { id, action, reviewed_by = null, scheduled_at } = params;

  if (!["approve", "reject"].includes(action)) {
    const err = new Error("action must be 'approve' or 'reject'");
    err.status = 400;
    throw err;
  }

  const existing = await env.ZHG_DB.prepare("SELECT * FROM notes_queue WHERE id = ?").bind(id).first();
  if (!existing) {
    const err = new Error(`No note found with id ${id}`);
    err.status = 404;
    throw err;
  }
  const allowedFrom = action === "approve" ? ["draft", "failed"] : ["draft", "approved", "failed"];
  if (!allowedFrom.includes(existing.status)) {
    const err = new Error(`Cannot ${action} a note with status '${existing.status}'`);
    err.status = 400;
    throw err;
  }
  if (action === "approve") validateXLength(existing);

  const status = action === "approve" ? "approved" : "rejected";
  const reviewed_at = new Date().toISOString();
  const row = await env.ZHG_DB.prepare(
    `UPDATE notes_queue
     SET status = ?, reviewed_at = ?, reviewed_by = ?, error = NULL,
         scheduled_at = COALESCE(?, scheduled_at)
     WHERE id = ? RETURNING *`
  ).bind(status, reviewed_at, reviewed_by, scheduled_at ?? null, id).first();

  if (action === "approve") {
    const when = row.scheduled_at ? `scheduled for ${row.scheduled_at}` : "will post on next cron run";
    notifyDiscord(env, toolCtx, `✅ Note #${id} approved by ${reviewed_by || "reviewer"} (${when})`);
  }
  return row;
}

async function setQueuePaused(env, params, toolCtx) {
  requireQueueToken(env, params);
  requireParams(params, ["paused"]);
  const paused = params.paused === true || params.paused === "true" || params.paused === "1";
  await setSetting(env, "posting_paused", paused ? "1" : "0");
  notifyDiscord(env, toolCtx, paused ? "⏸️ ZHG note posting PAUSED" : "▶️ ZHG note posting resumed");
  return { posting_paused: paused };
}

async function deleteNote(env, params) {
  requireQueueToken(env, params);
  requireParams(params, ["id"]);
  const row = await env.ZHG_DB.prepare(
    "DELETE FROM notes_queue WHERE id = ? RETURNING id, status"
  ).bind(params.id).first();
  if (!row) {
    const err = new Error(`No note found with id ${params.id}`);
    err.status = 404;
    throw err;
  }
  return { deleted: row.id, was_status: row.status };
}

// Record a post that was made outside the worker (e.g. Substack via the
// browser bookmarklet, since Substack blocks Workers-originated requests).
async function markPosted(env, params) {
  requireQueueToken(env, params);
  requireParams(params, ["id", "platform", "url"]);
  const { id, platform, url } = params;
  if (!NOTE_PLATFORMS.includes(platform)) {
    const err = new Error(`platform must be one of: ${NOTE_PLATFORMS.join(", ")}`);
    err.status = 400;
    throw err;
  }

  const note = await env.ZHG_DB.prepare("SELECT * FROM notes_queue WHERE id = ?").bind(id).first();
  if (!note) {
    const err = new Error(`No note found with id ${id}`);
    err.status = 404;
    throw err;
  }

  const urls = note.post_urls ? JSON.parse(note.post_urls) : {};
  urls[platform] = url;
  const allDone = note.platforms.split(",").every((p) => urls[p]);
  const status = allDone ? "posted" : note.status;
  let errors = null;
  if (!allDone && note.error) {
    try {
      const e = JSON.parse(note.error);
      delete e[platform];
      errors = Object.keys(e).length ? JSON.stringify(e) : null;
    } catch {}
  }

  const row = await env.ZHG_DB.prepare(
    `UPDATE notes_queue
     SET post_urls = ?, status = ?, error = ?,
         posted_at = CASE WHEN ? = 'posted' THEN COALESCE(posted_at, ?) ELSE posted_at END
     WHERE id = ? RETURNING *`
  ).bind(JSON.stringify(urls), status, errors, status, new Date().toISOString(), id).first();
  return { id: row.id, status: row.status, post_urls: JSON.parse(row.post_urls) };
}

// ---------------------------------------------------------------------------
// AI rewrite helper (used by the Notes page)
// ---------------------------------------------------------------------------

const NOTE_STYLE_RULES =
  "Write like a sharp, casual trader sharing a quick observation: 2 to 5 punchy sentences, lead with the number or fact that makes it interesting. " +
  "Every company keeps its $TICKER on first mention; never invent a ticker; say a company is private if it has no ticker. " +
  "Keep every factual claim, figure, and source citation from the original exactly as they are. Do not invent, alter, or drop numbers or sources. " +
  "No em dashes. No AI filler: no generic openers, no 'worth noting', no 'not X, but Y' constructions, no adverb padding. Active voice, named actors.";

async function rewriteNote(env, params) {
  requireQueueToken(env, params);
  requireParams(params, ["body"]);
  if (!env.ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY is not configured on this Worker");
    err.status = 500;
    throw err;
  }
  const { body, body_x = "", instruction = "" } = params;

  const task = instruction
    ? `Rewrite the note following this instruction from the editor: "${instruction}"`
    : "Completely regenerate the note: same facts, same story, same source, but fresh wording and structure.";

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content:
          `You are rewriting a short social note for The Zero Hour Group (defense/drone research and media).\n\n` +
          `Style rules:\n${NOTE_STYLE_RULES}\n\n` +
          `Current note (default/Substack version):\n<body>\n${body}\n</body>\n\n` +
          (body_x ? `Current X variant:\n<body_x>\n${body_x}\n</body_x>\n\n` : "") +
          `Task: ${task}\n\n` +
          `Return ONLY valid JSON, no code fences, shaped {"body":"...","body_x":"..."}. ` +
          `body is the full version. body_x must fit X's 280-character limit (every URL counts as 23 characters); if body already fits, body_x may equal body.`
      }
    ]
  });

  const text = message.content.find((b) => b.type === "text")?.text ?? "";
  let out = null;
  try {
    out = JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, "").trim());
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { out = JSON.parse(m[0]); } catch {} }
  }
  if (!out || typeof out.body !== "string" || !out.body.trim()) {
    const err = new Error("The AI returned an unparseable response. Try again.");
    err.status = 502;
    throw err;
  }
  return { body: out.body, body_x: typeof out.body_x === "string" ? out.body_x : "" };
}

// ---------------------------------------------------------------------------
// Platform posting (direct-post mode)
// X: official v2 API with OAuth 1.0a user context (pay-per-use plan)
// Substack Notes: unofficial feed API authenticated by substack.sid cookie
// ---------------------------------------------------------------------------

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1Base64(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return bytesToBase64(new Uint8Array(sig));
}

async function oauth1Header(env, method, url) {
  const oauth = {
    oauth_consumer_key: env.X_CONSUMER_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: "1.0"
  };
  const paramString = Object.keys(oauth).sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(oauth[k])}`).join("&");
  const baseString = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(env.X_CONSUMER_SECRET)}&${percentEncode(env.X_ACCESS_SECRET)}`;
  oauth.oauth_signature = await hmacSha1Base64(signingKey, baseString);
  return "OAuth " + Object.keys(oauth).sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`).join(", ");
}

async function postToX(env, text) {
  const missing = ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`X credentials not configured on this Worker: ${missing.join(", ")}`);
  const url = "https://api.x.com/2/tweets";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: await oauth1Header(env, "POST", url) },
    body: JSON.stringify({ text })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.data?.id) {
    throw new Error(`X API ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return `https://x.com/i/status/${data.data.id}`;
}

// Substack Notes bodies are ProseMirror docs; blank-line-separated text becomes paragraphs
function substackBodyJson(text) {
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  return {
    type: "doc",
    attrs: { schemaVersion: "v1" },
    content: paragraphs.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }))
  };
}

async function postToSubstack(env, text) {
  if (!env.SUBSTACK_SID) throw new Error("SUBSTACK_SID cookie is not configured on this Worker");
  // Browser-like headers: Workers' fetch sends no User-Agent, which trips
  // Substack's bot filtering (403 before auth is even checked).
  const res = await fetch("https://substack.com/api/v1/comment/feed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Origin": "https://substack.com",
      "Referer": "https://substack.com/home",
      Cookie: `substack.sid=${env.SUBSTACK_SID}`
    },
    body: JSON.stringify({
      bodyJson: substackBodyJson(text),
      tabId: "for-you",
      surface: "feed",
      replyMinimumRole: "everyone"
    })
  });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  if (!res.ok || !data?.id) {
    const detail = data ? JSON.stringify(data).slice(0, 300) : raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Substack API ${res.status}: ${detail}`);
  }
  const handle = env.SUBSTACK_HANDLE ? `@${env.SUBSTACK_HANDLE}/` : "";
  return `https://substack.com/${handle}note/c-${data.id}`;
}

// Scheduling helpers. post_urls holds either a real published URL for a
// platform, or a "scheduled:<ISO>" handoff marker (Substack native scheduler).
function isRealUrl(v) { return typeof v === "string" && v.length > 0 && !v.startsWith("scheduled:"); }

function platformsFrom(note) { return note.platforms.split(",").filter(Boolean); }

function allPlatformsHandled(note, urls) {
  return platformsFrom(note).every((p) => urls[p]); // real url OR scheduled: marker
}

async function scheduleNote(env, params, toolCtx) {
  requireQueueToken(env, params);
  requireParams(params, ["id", "scheduled_at"]);
  const { id, scheduled_at } = params;

  const when = new Date(scheduled_at);
  if (isNaN(when.getTime())) { const e = new Error("scheduled_at must be a valid ISO 8601 timestamp"); e.status = 400; throw e; }
  if (when.getTime() < Date.now() - 60000) { const e = new Error("scheduled_at is in the past"); e.status = 400; throw e; }

  const note = await env.ZHG_DB.prepare("SELECT * FROM notes_queue WHERE id = ?").bind(id).first();
  if (!note) { const e = new Error(`No note found with id ${id}`); e.status = 404; throw e; }
  if (!["draft", "scheduled", "failed"].includes(note.status)) {
    const e = new Error(`Cannot schedule a note with status '${note.status}'`); e.status = 400; throw e;
  }
  if (note.platforms.includes("x")) validateXLength(note);

  const row = await env.ZHG_DB.prepare(
    `UPDATE notes_queue SET status = 'scheduled', scheduled_at = ?, error = NULL WHERE id = ? RETURNING *`
  ).bind(when.toISOString(), id).first();
  return { id: row.id, status: row.status, scheduled_at: row.scheduled_at, platforms: row.platforms };
}

async function markScheduled(env, params) {
  requireQueueToken(env, params);
  requireParams(params, ["id", "platform", "trigger_at"]);
  const { id, platform, trigger_at } = params;
  if (!NOTE_PLATFORMS.includes(platform)) { const e = new Error(`platform must be one of: ${NOTE_PLATFORMS.join(", ")}`); e.status = 400; throw e; }

  const note = await env.ZHG_DB.prepare("SELECT * FROM notes_queue WHERE id = ?").bind(id).first();
  if (!note) { const e = new Error(`No note found with id ${id}`); e.status = 404; throw e; }

  const urls = note.post_urls ? JSON.parse(note.post_urls) : {};
  urls[platform] = `scheduled:${trigger_at}`;

  const xTargeted = note.platforms.includes("x");
  const xReal = isRealUrl(urls.x);
  const done = allPlatformsHandled(note, urls) && (!xTargeted || xReal);
  const status = done ? "posted" : "scheduled";
  const posted_at = done ? new Date().toISOString() : null;

  const row = await env.ZHG_DB.prepare(
    `UPDATE notes_queue SET post_urls = ?, status = ?, posted_at = COALESCE(?, posted_at) WHERE id = ? RETURNING *`
  ).bind(JSON.stringify(urls), status, posted_at, id).first();
  return { id: row.id, status: row.status, post_urls: JSON.parse(row.post_urls) };
}

// Cron: publish scheduled X posts whose time has arrived. Substack is handled
// by its own native scheduler (via the bookmarklet), never here.
async function runDueScheduled(env, toolCtx) {
  if ((await getSetting(env, "posting_paused", "0")) === "1") return { skipped: "paused" };
  const now = new Date().toISOString();
  const { results } = await env.ZHG_DB.prepare(
    "SELECT * FROM notes_queue WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?"
  ).bind(now).all();

  let posted = 0, failed = 0;
  for (const note of results) {
    const urls = note.post_urls ? JSON.parse(note.post_urls) : {};
    if (!note.platforms.includes("x") || isRealUrl(urls.x)) continue;
    try {
      urls.x = await postToX(env, note.body_x || note.body);
      const done = allPlatformsHandled(note, urls);
      await env.ZHG_DB.prepare(
        `UPDATE notes_queue SET post_urls = ?, status = ?, posted_at = COALESCE(?, posted_at), error = NULL WHERE id = ?`
      ).bind(JSON.stringify(urls), done ? "posted" : "scheduled", done ? now : null, note.id).run();
      posted++;
      if (done) notifyDiscord(env, toolCtx, `\u{1F680} Scheduled note #${note.id} posted to X\n${urls.x}`);
    } catch (e) {
      await env.ZHG_DB.prepare("UPDATE notes_queue SET status = 'failed', error = ? WHERE id = ?")
        .bind(JSON.stringify({ x: e.message }), note.id).run();
      failed++;
      notifyDiscord(env, toolCtx, `\u{274C} Scheduled note #${note.id} FAILED on X: ${e.message}`);
    }
  }
  return { checked: results.length, posted, failed };
}

async function postNote(env, params, toolCtx) {
  requireQueueToken(env, params);
  requireParams(params, ["id"]);
  const { id } = params;

  if ((await getSetting(env, "posting_paused", "0")) === "1") {
    const err = new Error("Posting is paused (kill switch). Use set_queue_paused to resume.");
    err.status = 409;
    throw err;
  }

  const note = await env.ZHG_DB.prepare("SELECT * FROM notes_queue WHERE id = ?").bind(id).first();
  if (!note) {
    const err = new Error(`No note found with id ${id}`);
    err.status = 404;
    throw err;
  }
  if (!["draft", "approved", "failed"].includes(note.status)) {
    const err = new Error(`Cannot post a note with status '${note.status}'`);
    err.status = 400;
    throw err;
  }

  // Skip platforms that already succeeded on a previous attempt (no double-posting on retry)
  const already = note.post_urls ? JSON.parse(note.post_urls) : {};
  const targets = note.platforms.split(",").filter((p) => !already[p]);
  if (!targets.length) {
    const err = new Error(`Note #${id} has already been posted to all its platforms`);
    err.status = 400;
    throw err;
  }
  if (targets.includes("x")) validateXLength(note);

  const urls = { ...already };
  const errors = {};
  for (const p of targets) {
    try {
      const text = p === "x" ? (note.body_x || note.body) : (note.body_substack || note.body);
      urls[p] = p === "x" ? await postToX(env, text) : await postToSubstack(env, text);
    } catch (e) {
      errors[p] = e.message;
    }
  }

  const ok = Object.keys(errors).length === 0;
  const status = ok ? "posted" : "failed";
  const posted_at = ok ? new Date().toISOString() : null;
  const row = await env.ZHG_DB.prepare(
    `UPDATE notes_queue
     SET status = ?, posted_at = COALESCE(?, posted_at), post_urls = ?, error = ?
     WHERE id = ? RETURNING *`
  ).bind(status, posted_at, JSON.stringify(urls), ok ? null : JSON.stringify(errors), id).first();

  if (ok) {
    const links = Object.entries(urls).map(([p, u]) => `${p}: ${u}`).join("\n");
    notifyDiscord(env, toolCtx, `🚀 Note #${id} posted\n${links}`);
  } else {
    notifyDiscord(env, toolCtx, `❌ Note #${id} post FAILED\n${JSON.stringify(errors)}`);
  }

  return { id: row.id, status: row.status, post_urls: urls, errors: ok ? undefined : errors };
}

// ---------------------------------------------------------------------------
// Tool registry — shared by the MCP protocol layer and the legacy REST shape
// ---------------------------------------------------------------------------

const TOOLS = {
  semantic_search: {
    description:
      "Semantic (meaning-based) search over ZHG assets using vector embeddings. Use this for natural language or topic-based searches like 'photos of people', 'drone footage', or 'contract documents about sponsorships'. Use search_assets instead for exact keyword or tag matches. Returns matching asset metadata rows ranked by similarity score.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language description of what to find" },
        limit: { type: "number", description: "Max results to return (default 10, max 20)" }
      },
      required: ["query"]
    },
    handler: semanticSearch
  },
  search_assets: {
    description:
      "Search the ZHG data hub for assets by exact keyword. Matches against filename, tags, and summary (not file contents). Optionally filter by folder (media, docs, pipeline, structured) and/or type. Use semantic_search instead for natural language or topic-based queries. Returns matching asset metadata rows.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search for in filename, tags, and summary" },
        folder: { type: "string", enum: ["media", "docs", "pipeline", "structured"], description: "Optional folder filter" },
        type: { type: "string", description: "Optional asset type filter, e.g. doc, image, video, audio, data" },
        limit: { type: "number", description: "Max results to return (default 10, max 100)" }
      },
      required: ["query"]
    },
    handler: searchAssets
  },
  get_file: {
    description:
      "Fetch a file from ZHG R2 storage by its key (e.g. docs/contract.pdf). Returns the file as base64 along with filename, content type, and size.",
    inputSchema: {
      type: "object",
      properties: {
        r2_key: { type: "string", description: "The R2 object key, e.g. docs/show-notes.md" }
      },
      required: ["r2_key"]
    },
    handler: getFile
  },
  upload_file: {
    description:
      "Upload a file to the ZHG data hub. Stores the file in R2 at {folder}/{filename} and records metadata in the asset index. Returns the new asset id and R2 key.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename including extension" },
        folder: { type: "string", enum: ["media", "docs", "pipeline", "structured"], description: "Destination folder" },
        type: { type: "string", description: "Coarse asset type, e.g. doc, image, video, audio, data, other" },
        tags: { type: "string", description: "Optional comma-separated tags" },
        summary: { type: "string", description: "Optional short summary of the file" },
        uploaded_by: { type: "string", description: "Optional name of the team member uploading" },
        file_base64: { type: "string", description: "File contents encoded as base64" },
        content_type: { type: "string", description: "MIME type, e.g. text/plain, application/pdf" }
      },
      required: ["filename", "folder", "type", "file_base64", "content_type"]
    },
    handler: uploadFile
  },
  list_recent: {
    description:
      "List the most recently uploaded assets in the ZHG data hub, newest first. Optionally filter by folder (media, docs, pipeline, structured) and/or type.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 20, max 100)" },
        folder: { type: "string", enum: ["media", "docs", "pipeline", "structured"], description: "Optional folder filter" },
        type: { type: "string", description: "Optional asset type filter" }
      }
    },
    handler: listRecent
  },
  summarize_content: {
    description:
      "Fetch a text-based document from ZHG R2 storage and return an AI-generated summary of its contents. Best for docs, notes, and pipeline outputs — not binary media files.",
    inputSchema: {
      type: "object",
      properties: {
        r2_key: { type: "string", description: "The R2 object key of the document to summarize" }
      },
      required: ["r2_key"]
    },
    handler: summarizeContent
  },
  tag_asset: {
    description:
      "Replace the tags on an existing ZHG asset, identified by its R2 key. Returns the updated asset row.",
    inputSchema: {
      type: "object",
      properties: {
        r2_key: { type: "string", description: "The R2 object key of the asset to tag" },
        tags: { type: "string", description: "New comma-separated tags (replaces existing tags)" }
      },
      required: ["r2_key", "tags"]
    },
    handler: tagAsset
  },
  queue_note: {
    description:
      "Add a short-form note (X post / Substack Note) to the ZHG posting queue as a draft awaiting review. Provide 'body' as the default text; optionally provide body_x or body_substack for per-platform variants. Notes targeting X must fit 280 chars (URLs count as 23). Triggers a Discord ping to the reviewer. Returns the created queue row.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Default note text used for all platforms unless a variant is given" },
        body_x: { type: "string", description: "Optional X-specific variant (280 char limit, URLs count as 23)" },
        body_substack: { type: "string", description: "Optional Substack Notes variant" },
        platforms: { type: "string", description: "Comma-separated targets: x, substack (default 'x,substack')" },
        scheduled_at: { type: "string", description: "Optional ISO 8601 UTC time to post at; if omitted, posts on next cron run after approval" },
        topic: { type: "string", description: "Optional topic or source reference for the note" },
        created_by: { type: "string", description: "Who or what drafted this note, e.g. 'claude', 'jt'" }
      },
      required: ["body"]
    },
    handler: queueNote
  },
  get_queue: {
    description:
      "List notes in the ZHG posting queue, newest first, with the global posting_paused flag. Optionally filter by status: draft, scheduled, approved, rejected, posted, failed.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "scheduled", "approved", "rejected", "posted", "failed"], description: "Optional status filter" },
        limit: { type: "number", description: "Max results (default 50, max 200)" }
      }
    },
    handler: getQueue
  },
  update_note: {
    description:
      "Edit a note in the ZHG posting queue (draft, approved, or failed only). Requires the queue review token. Editable fields: body, body_x, body_substack, platforms, scheduled_at, topic.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Queue review token" },
        id: { type: "number", description: "Queue row id" },
        body: { type: "string" },
        body_x: { type: "string" },
        body_substack: { type: "string" },
        platforms: { type: "string" },
        scheduled_at: { type: "string" },
        topic: { type: "string" }
      },
      required: ["token", "id"]
    },
    handler: updateNote
  },
  // -------------------------------------------------------------------------
  // REVIEW FLOW DISABLED (direct-post mode). Uncomment review_note to restore
  // the draft -> approve -> cron pipeline. Handler reviewNote is still defined.
  // -------------------------------------------------------------------------
  // review_note: {
  //   description:
  //     "Approve or reject a queued ZHG note. Requires the queue review token. Approving optionally sets scheduled_at; approved notes are posted by the cron. Failed notes can be re-approved to retry.",
  //   inputSchema: {
  //     type: "object",
  //     properties: {
  //       token: { type: "string", description: "Queue review token" },
  //       id: { type: "number", description: "Queue row id" },
  //       action: { type: "string", enum: ["approve", "reject"] },
  //       reviewed_by: { type: "string", description: "Reviewer name, e.g. 'jt'" },
  //       scheduled_at: { type: "string", description: "Optional ISO 8601 UTC post time (approve only)" }
  //     },
  //     required: ["token", "id", "action"]
  //   },
  //   handler: reviewNote
  // },
  delete_note: {
    description:
      "Permanently delete a note from the ZHG posting queue by id, any status. Requires the queue review token. Removes only the queue record; live posts on the platforms are not affected.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Queue review token" },
        id: { type: "number", description: "Queue row id to delete" }
      },
      required: ["token", "id"]
    },
    handler: deleteNote
  },
  mark_posted: {
    description:
      "Record that a queued ZHG note was posted to a platform outside the worker (e.g. Substack via the browser, which blocks Workers requests). Requires the queue review token. Merges the URL into post_urls, clears that platform's error, and flips status to posted once every target platform has a URL.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Queue review token" },
        id: { type: "number", description: "Queue row id" },
        platform: { type: "string", enum: ["x", "substack"], description: "Platform that was posted" },
        url: { type: "string", description: "Live URL of the post" }
      },
      required: ["token", "id", "platform", "url"]
    },
    handler: markPosted
  },
  rewrite_note: {
    description:
      "AI-rewrite a ZHG note draft's text in the house style. Requires the queue review token. With no instruction, fully regenerates the note (same facts and source, fresh wording). With an instruction, rewrites following it. Returns {body, body_x} without modifying the queue; the caller decides whether to save.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Queue review token" },
        body: { type: "string", description: "Current note text to rewrite" },
        body_x: { type: "string", description: "Current X variant, if any" },
        instruction: { type: "string", description: "Optional editor instruction, e.g. 'shorter and more aggressive'" }
      },
      required: ["token", "body"]
    },
    handler: rewriteNote
  },
  schedule_note: {
    description:
      "Schedule a queued ZHG note to publish at a future time. Requires the queue review token. Sets status to 'scheduled' and stores scheduled_at (ISO 8601). X posts fire automatically via the worker cron at that time; Substack notes must additionally be handed to Substack's native scheduler via the browser bookmarklet.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Queue review token" },
        id: { type: "number", description: "Queue row id" },
        scheduled_at: { type: "string", description: "ISO 8601 UTC time to publish at" }
      },
      required: ["token", "id", "scheduled_at"]
    },
    handler: scheduleNote
  },
  mark_scheduled: {
    description:
      "Record that a platform was handed to its native scheduler outside the worker (Substack via the bookmarklet). Requires the queue review token. Stores a 'scheduled:<trigger_at>' marker in post_urls for that platform. Flips the note to 'posted' once every platform is handled and any X target has a real URL.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Queue review token" },
        id: { type: "number", description: "Queue row id" },
        platform: { type: "string", enum: ["x", "substack"], description: "Platform handed to its scheduler" },
        trigger_at: { type: "string", description: "ISO 8601 UTC time it will publish" }
      },
      required: ["token", "id", "platform", "trigger_at"]
    },
    handler: markScheduled
  },
  post_note: {
    description:
      "Post a queued ZHG note to all of its target platforms immediately (X via official API, Substack Notes via session cookie). Requires the queue review token. Retrying a failed note only posts to the platforms that have not succeeded yet. Returns per-platform post URLs.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Queue review token" },
        id: { type: "number", description: "Queue row id of the note to post" }
      },
      required: ["token", "id"]
    },
    handler: postNote
  },
  set_queue_paused: {
    description:
      "Global kill switch for the ZHG posting pipeline. Requires the queue review token. When paused, the cron posts nothing regardless of queue state.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Queue review token" },
        paused: { type: "boolean", description: "true to pause all posting, false to resume" }
      },
      required: ["token", "paused"]
    },
    handler: setQueuePaused
  }
};

// ---------------------------------------------------------------------------
// MCP protocol (JSON-RPC 2.0 over Streamable HTTP)
// ---------------------------------------------------------------------------

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMcpMessage(env, msg, toolCtx) {
  const { id, method, params } = msg;

  // Notifications (no id) get no response body
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      });
    case "tools/call": {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await tool.handler(env, params?.arguments || {}, toolCtx);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true
        });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMcp(env, body, toolCtx) {
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handleMcpMessage(env, m, toolCtx)))).filter(Boolean);
    if (!responses.length) return new Response(null, { status: 202 });
    return json(responses);
  }
  const response = await handleMcpMessage(env, body, toolCtx);
  if (!response) return new Response(null, { status: 202 });
  return json(response);
}

// ---------------------------------------------------------------------------
// Legacy REST shape ({ tool, params }) — used by the upload UI
// ---------------------------------------------------------------------------

async function handleLegacy(env, body, toolCtx) {
  const { tool, params = {} } = body || {};
  const entry = TOOLS[tool];
  if (!entry) return json({ error: "Unknown tool" }, 400);
  try {
    return json(await entry.handler(env, params, toolCtx));
  } catch (err) {
    return json({ error: err.message }, err.status || 500);
  }
}

export default {
  // Cloudflare Cron Trigger: fire scheduled X posts whose time has arrived.
  async scheduled(event, env, ctx) {
    const toolCtx = { waitUntil: ctx?.waitUntil?.bind(ctx) };
    ctx.waitUntil(runDueScheduled(env, toolCtx));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const toolCtx = { origin: url.origin, waitUntil: ctx?.waitUntil?.bind(ctx) };

    if (url.pathname === "/review.html") {
      return Response.redirect(`${url.origin}/notes`, 301);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ status: "ZHG Hub online" });
    }

    if (url.pathname === "/mcp") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        // No server-initiated SSE stream; Streamable HTTP allows 405 here
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Request body must be valid JSON" }, 400);
      }
      const isJsonRpc =
        (body && body.jsonrpc === "2.0") ||
        (Array.isArray(body) && body.length && body[0]?.jsonrpc === "2.0");
      return isJsonRpc ? handleMcp(env, body, toolCtx) : handleLegacy(env, body, toolCtx);
    }

    return json({ error: "Not found" }, 404);
  }
};
