/**
 * Bharat Nova AI — /api/server (Vercel Edge Function)
 * ─────────────────────────────────────────────────────
 * 14-ENGINE SUPER AI WITH AUTOMATIC HIGH-INTELLIGENCE FAILOVER
 *
 * The client sends ONE request with a chosen "engine".
 * The server tries that engine first. If it fails (rate
 * limit, bad key, timeout, outage) it AUTOMATICALLY logs
 * the failure and immediately transfers the request to the
 * highest available intelligence provider in FALLBACK_ORDER,
 * and continues down the hierarchy until one succeeds.
 * The response tells the client exactly what happened so
 * the UI can show a "System: X failed → answered via Y" toast.
 *
 * Intelligence hierarchy (FALLBACK_ORDER):
 *   Tier 1 — Gemini, OpenRouter, DeepSeek
 *   Tier 2 — Mistral, NVIDIA, Zai AI
 *   Tier 3 — Cloudflare, SiliconFlow, HuggingFace, Fireworks, Cohere
 *   Tier 4 — Groq, SambaNova, Cerebras
 *
 * ───────────────────────────────────────────────────────
 * ENV VARS (Vercel → Project → Settings → Environment Variables):
 *   GEMINI_API_KEY, GEMINI_API_KEY_2        ← Gemini primary + backup
 *   OPENROUTER_API_KEY
 *   DEEPSEEK_API_KEY
 *   MISTRAL_API_KEY
 *   NVIDIA_API_KEY
 *   ZAI_API_KEY                             ← Zhipu AI / GLM-4-Flash
 *   CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID
 *   SILICONFLOW_API_KEY
 *   HUGGINGFACE_API_KEY
 *   FIREWORKS_API_KEY
 *   COHERE_API_KEY
 *   GROQ_API_KEY
 *   SAMBANOVA_API_KEY
 *   CEREBRAS_API_KEY
 */

export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PROVIDER_TIMEOUT_MS = 9000;  // default per-attempt cap
const TOTAL_BUDGET_MS = 22000;     // whole-request budget so the edge function never hangs even if every engine is tried
const MIN_REMAINING_MS = 1800;     // stop trying more engines once less than this remains

async function fetchWithTimeout(url, options, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* Normalize message content to a plain string — every engine here is
   text-only, and resending full history every turn means any stray
   non-string content would break a provider on every later turn too. */
function flattenMessages(messages) {
  return (messages || [])
    .filter(m => m && m.role && m.content != null)
    .map(m => ({ role: m.role, content: String(m.content) }));
}

async function readErrorDetail(res) {
  try { return (await res.text()).slice(0, 220); } catch { return ''; }
}

/* For engines that are text-only (everything except Gemini): if the
   user attached an image/file, we can't send binary content to a
   /chat/completions endpoint that doesn't accept it. Instead of
   crashing or silently dropping it, append a short, clear note to the
   latest user turn so the model answers gracefully and the user knows
   the engine couldn't actually see the attachment. */
function appendAttachmentNote(messages, attachment, label) {
  const flat = flattenMessages(messages);
  if (!flat.length || !attachment) return flat;
  const note = ` [The user also attached a file (${attachment.mimeType}${attachment.name ? `, "${attachment.name}"` : ''}). ${label} is a text-only engine and cannot view attachments — answer using only the text above, and briefly let the user know the file itself couldn't be viewed.]`;
  const last = flat[flat.length - 1];
  flat[flat.length - 1] = { role: last.role, content: last.content + note };
  return flat;
}

/* ════════════════════════════════════════════════════
   GENERIC OpenAI-COMPATIBLE CALLER
   Covers Groq, OpenRouter, Fireworks, NVIDIA NIM, and
   HuggingFace's router — they all speak the same
   /chat/completions shape.
════════════════════════════════════════════════════ */
async function callOpenAICompatible({ url, apiKey, model, messages, temperature, max_tokens, extraHeaders, label, timeoutMs, attachment }) {
  if (!apiKey) {
    throw new Error(`${label}: API key not set on the server (check Vercel env vars).`);
  }
  const outgoingMessages = attachment ? appendAttachmentNote(messages, attachment, label) : flattenMessages(messages);
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
      body: JSON.stringify({
        model,
        messages: outgoingMessages,
        temperature: temperature !== undefined ? temperature : 0.7,
        max_tokens: max_tokens || 1024,
        stream: false,
      }),
    }, timeoutMs);
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`${label}: timed out after ${Math.round((timeoutMs || PROVIDER_TIMEOUT_MS) / 1000)}s.`);
    throw new Error(`${label}: request failed (${err?.message || 'network error'}).`);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`${label}: HTTP ${res.status} — ${detail || 'request failed'}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error(`${label}: returned an empty response.`);
  return content.trim();
}

/* ════════════════════════════════════════════════════
   GOOGLE GEMINI — native REST generateContent API
   ─────────────────────────────────────────────────
   Key rotation: primary (GEMINI_API_KEY) is tried
   first. On any failure — 429 quota, bad key, network
   error — the error is logged and the EXACT same
   request body is immediately retried with the backup
   key (GEMINI_API_KEY_2). The frontend never sees the
   retry; it only receives the final successful reply.
════════════════════════════════════════════════════ */

/* Low-level helper: fires one HTTP request to Gemini
   with the supplied apiKey and pre-built body object.
   Throws a descriptive Error on any failure so the
   caller can decide whether to retry. */
async function callGeminiWithKey(apiKey, body, timeoutMs) {
  let res;
  try {
    res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      timeoutMs
    );
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Gemini: timed out after ${Math.round((timeoutMs || PROVIDER_TIMEOUT_MS) / 1000)}s.`);
    throw new Error(`Gemini: request failed (${err?.message || 'network error'}).`);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Gemini: HTTP ${res.status} — ${detail || 'request failed'}`);
  }

  const data = await res.json();
  if (data?.promptFeedback?.blockReason) {
    throw new Error(`Gemini: response blocked (${data.promptFeedback.blockReason}).`);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini: returned an empty response.');
  return text;
}

/* Public caller — builds the request body once, then
   delegates to callGeminiWithKey with primary key,
   automatically falling back to the backup key on
   any error before propagating failure to the engine
   loop above. */
async function callGemini(messages, temperature, max_tokens, timeoutMs, attachment) {
  const primaryKey = process.env.GEMINI_API_KEY;
  const backupKey  = process.env.GEMINI_API_KEY_2;

  if (!primaryKey) throw new Error('Gemini: API key not set on the server (GEMINI_API_KEY missing).');

  // ── Build the request body (shared by both key attempts) ──────────
  let systemText = '';
  const contents = [];
  for (const m of flattenMessages(messages)) {
    if (m.role === 'system') { systemText += m.content + '\n'; continue; }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  if (!contents.length && !attachment) throw new Error('Gemini: no readable message content.');

  // Multimodal attachment: Gemini's generateContent API expects the
  // image/file as an inlineData part inside the relevant "user" turn's
  // parts array (alongside the text part), per the official schema:
  //   { role: 'user', parts: [ { text }, { inlineData: { mimeType, data } } ] }
  // We attach it to the most recent user turn, since that's the turn
  // the file belongs to.
  if (attachment && attachment.data && attachment.mimeType) {
    const cleanData = String(attachment.data).replace(/^data:[^;]+;base64,/, '');
    const inlinePart = { inlineData: { mimeType: attachment.mimeType, data: cleanData } };
    let lastUserIdx = -1;
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx >= 0) {
      contents[lastUserIdx].parts.push(inlinePart);
    } else {
      contents.push({ role: 'user', parts: [inlinePart] });
    }
  }

  const body = {
    contents,
    generationConfig: {
      temperature: temperature !== undefined ? temperature : 0.7,
      maxOutputTokens: max_tokens || 1024,
    },
    ...(systemText.trim() ? { systemInstruction: { parts: [{ text: systemText.trim() }] } } : {}),
  };

  // ── Attempt 1: primary key ────────────────────────────────────────
  try {
    return await callGeminiWithKey(primaryKey, body, timeoutMs);
  } catch (primaryErr) {
    // If there is no backup key configured, surface the error immediately
    // rather than logging a confusing "switching to backup" message.
    if (!backupKey) throw primaryErr;
    console.log('Primary key failed, switching to backup key...', primaryErr?.message || String(primaryErr));
  }

  // ── Attempt 2: backup key (GEMINI_API_KEY_2) ──────────────────────
  try {
    return await callGeminiWithKey(backupKey, body, timeoutMs);
  } catch (backupErr) {
    // Both keys exhausted — surface a clear combined error message so
    // the engine-level fallback loop above can try the next provider.
    throw new Error(`Gemini: both API keys failed. Last error: ${backupErr?.message || 'unknown'}`);
  }
}

/* ════════════════════════════════════════════════════
   COHERE — v2 Chat API
════════════════════════════════════════════════════ */
async function callCohere(messages, temperature, max_tokens, timeoutMs, attachment) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error('Cohere: API key not set on the server.');

  const outgoingMessages = attachment ? appendAttachmentNote(messages, attachment, 'Cohere') : flattenMessages(messages);
  let res;
  try {
    res = await fetchWithTimeout('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'command-r-08-2024',
        messages: outgoingMessages,
        temperature: temperature !== undefined ? temperature : 0.7,
        max_tokens: max_tokens || 1024,
      }),
    }, timeoutMs);
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Cohere: timed out after ${Math.round((timeoutMs || PROVIDER_TIMEOUT_MS) / 1000)}s.`);
    throw new Error(`Cohere: request failed (${err?.message || 'network error'}).`);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Cohere: HTTP ${res.status} — ${detail || 'request failed'}`);
  }

  const data = await res.json();
  const text = (data?.message?.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('')
    .trim();
  if (!text) throw new Error('Cohere: returned an empty response.');
  return text;
}

/* ════════════════════════════════════════════════════
   DEEPSEEK — OpenAI-compatible chat API
════════════════════════════════════════════════════ */
/* Uses the standard /v1/chat/completions endpoint.
   DeepSeek-V3 is state-of-the-art for math and coding. */

/* ════════════════════════════════════════════════════
   MISTRAL — OpenAI-compatible chat API
════════════════════════════════════════════════════ */
/* mistral-small-latest is free-tier-safe and strong
   for multilingual and reasoning tasks. */

/* ════════════════════════════════════════════════════
   ZAI AI (Zhipu GLM) — OpenAI-compatible chat API
════════════════════════════════════════════════════ */
/* GLM-4-Flash is Zhipu AI's free, fast, multilingual
   model. Endpoint: open.bigmodel.cn */

/* ════════════════════════════════════════════════════
   CLOUDFLARE WORKERS AI — OpenAI-compatible endpoint
════════════════════════════════════════════════════ */
/* Requires CLOUDFLARE_API_KEY (Bearer token) and
   CLOUDFLARE_ACCOUNT_ID (from Cloudflare dashboard). */

/* ════════════════════════════════════════════════════
   SILICONFLOW — OpenAI-compatible chat API
════════════════════════════════════════════════════ */
/* Qwen2.5-7B-Instruct is free-tier on SiliconFlow.
   Strong open-source model for general tasks. */

/* ════════════════════════════════════════════════════
   SAMBANOVA — OpenAI-compatible chat API
════════════════════════════════════════════════════ */
/* SambaNova's RDU hardware delivers very fast
   Llama 3.1 inference on their free-tier. */

/* ════════════════════════════════════════════════════
   CEREBRAS — OpenAI-compatible chat API
════════════════════════════════════════════════════ */
/* Cerebras chip delivers extremely fast inference.
   llama3.1-8b is available on their free tier. */

/* ════════════════════════════════════════════════════
   PROVIDER REGISTRY — 14-Engine Super AI
════════════════════════════════════════════════════ */
const PROVIDERS = {
  // ── Tier 1: Advanced Reasoning & JEE Specialists ────────────────
  gemini: {
    name: 'Gemini',
    vision: true,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callGemini(messages, temperature, max_tokens, timeoutMs, attachment),
  },
  openrouter: {
    name: 'OpenRouter',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: process.env.OPENROUTER_API_KEY,
      model: 'openrouter/free',
      messages, temperature, max_tokens, timeoutMs, attachment,
      extraHeaders: { 'HTTP-Referer': 'https://bharat-nova-ai.vercel.app', 'X-Title': 'Bharat Nova AI' },
      label: 'OpenRouter',
    }),
  },
  deepseek: {
    name: 'DeepSeek',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: 'deepseek-chat',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'DeepSeek',
    }),
  },
  // ── Tier 2: High-Performance Brains ─────────────────────────────
  mistral: {
    name: 'Mistral',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.mistral.ai/v1/chat/completions',
      apiKey: process.env.MISTRAL_API_KEY,
      model: 'mistral-small-latest',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'Mistral',
    }),
  },
  nvidia: {
    name: 'NVIDIA',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://integrate.api.nvidia.com/v1/chat/completions',
      apiKey: process.env.NVIDIA_API_KEY,
      model: 'meta/llama-3.1-8b-instruct',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'NVIDIA',
    }),
  },
  zai: {
    name: 'Zai AI',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      apiKey: process.env.ZAI_API_KEY,
      model: 'glm-4-flash',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'Zai AI',
    }),
  },
  // ── Tier 3: Global Cloud & Model Hubs ───────────────────────────
  cloudflare: {
    name: 'Cloudflare',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      if (!accountId) throw new Error('Cloudflare: CLOUDFLARE_ACCOUNT_ID env var not set.');
      return callOpenAICompatible({
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
        apiKey: process.env.CLOUDFLARE_API_KEY,
        model: '@cf/meta/llama-3.1-8b-instruct',
        messages, temperature, max_tokens, timeoutMs, attachment,
        label: 'Cloudflare',
      });
    },
  },
  siliconflow: {
    name: 'SiliconFlow',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.siliconflow.cn/v1/chat/completions',
      apiKey: process.env.SILICONFLOW_API_KEY,
      model: 'Qwen/Qwen2.5-7B-Instruct',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'SiliconFlow',
    }),
  },
  huggingface: {
    name: 'HuggingFace',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://router.huggingface.co/v1/chat/completions',
      apiKey: process.env.HUGGINGFACE_API_KEY,
      model: 'meta-llama/Llama-3.1-8B-Instruct',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'HuggingFace',
    }),
  },
  fireworks: {
    name: 'Fireworks',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      apiKey: process.env.FIREWORKS_API_KEY,
      model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'Fireworks',
    }),
  },
  cohere: {
    name: 'Cohere',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callCohere(messages, temperature, max_tokens, timeoutMs, attachment),
  },
  // ── Tier 4: Ultra-Fast Real-Time Engines ────────────────────────
  groq: {
    name: 'Groq',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY,
      model: 'openai/gpt-oss-20b',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'Groq',
    }),
  },
  sambanova: {
    name: 'SambaNova',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.sambanova.ai/v1/chat/completions',
      apiKey: process.env.SAMBANOVA_API_KEY,
      model: 'Meta-Llama-3.1-8B-Instruct',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'SambaNova',
    }),
  },
  cerebras: {
    name: 'Cerebras',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: process.env.CEREBRAS_API_KEY,
      model: 'llama3.1-8b',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'Cerebras',
    }),
  },
};

/* Automatic high-intelligence failover order.
   When a provider fails, the system transfers the request
   to the next highest intelligence tier automatically.
   Tier 1 (most intelligent) first, Tier 4 (fastest) last. */
const FALLBACK_ORDER = [
  'gemini', 'openrouter', 'deepseek',           // Tier 1: Advanced Reasoning
  'mistral', 'nvidia', 'zai',                   // Tier 2: High-Performance
  'cloudflare', 'siliconflow', 'huggingface',   // Tier 3: Global Cloud Hubs
  'fireworks', 'cohere',                        // Tier 3: continued
  'groq', 'sambanova', 'cerebras',              // Tier 4: Ultra-Fast
];

/* ════════════════════════════════════════════════════
   MAIN HANDLER
════════════════════════════════════════════════════ */
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { message: 'Method not allowed' } }),
      { status: 405, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON body' } }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  const { messages, temperature, max_tokens, attachment: rawAttachment } = body || {};
  let requestedEngine = PROVIDERS[body?.engine] ? body.engine : 'groq';

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required field: messages (array)' } }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  // Normalize + validate an optional image/file attachment. We cap the
  // base64 size generously (~6MB raw) to stay well inside Vercel's edge
  // request-body limits and keep response times fast.
  let attachment = null;
  if (rawAttachment && typeof rawAttachment === 'object' && rawAttachment.data && rawAttachment.mimeType) {
    const data = String(rawAttachment.data);
    if (data.length > 9000000) {
      return new Response(
        JSON.stringify({ error: { message: 'Attachment is too large. Please use a smaller image or file (max ~6MB).' } }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      );
    }
    attachment = {
      data,
      mimeType: String(rawAttachment.mimeType),
      name: rawAttachment.name ? String(rawAttachment.name).slice(0, 120) : '',
    };
  }

  // If a file/image is attached but the user's chosen engine can't see
  // it, automatically lock this request to the vision-capable engine
  // (Gemini) instead of ignoring the attachment or letting a text-only
  // provider error out on it.
  if (attachment && !PROVIDERS[requestedEngine].vision) {
    requestedEngine = 'gemini';
  }

  // Try the requested engine first, then automatically transfer to the
  // next highest-intelligence provider in FALLBACK_ORDER. Bounded by a
  // total time budget so the edge function never hangs even if many
  // engines are tried.
  const attemptOrder = [requestedEngine, ...FALLBACK_ORDER.filter(k => k !== requestedEngine)];
  const errors = {};
  const triedEngines = [];
  const startedAt = Date.now();

  for (let i = 0; i < attemptOrder.length; i++) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < MIN_REMAINING_MS) break; // out of time budget — stop trying more engines

    const key = attemptOrder[i];
    const timeoutMs = Math.min(PROVIDER_TIMEOUT_MS, remaining - 300);
    triedEngines.push(key);

    try {
      const reply = await PROVIDERS[key].call(messages, temperature, max_tokens, timeoutMs, attachment);
      return new Response(
        JSON.stringify({
          reply,
          engine: key,
          engineName: PROVIDERS[key].name,
          requestedEngine,
          requestedEngineName: PROVIDERS[requestedEngine].name,
          fallback: key !== requestedEngine,
          triedEngines,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS_HEADERS } }
      );
    } catch (err) {
      errors[key] = err?.message || 'Unknown error';
      // Log the transfer so it's visible in Vercel Function Logs
      const nextKey = attemptOrder[i + 1];
      const nextName = nextKey ? PROVIDERS[nextKey]?.name : null;
      console.log(
        `[${PROVIDERS[key].name}] failed, automatically transferring to High-Intelligence Backup...` +
        (nextName ? ` Trying: ${nextName}` : ' (no more engines in budget)') +
        ` | Reason: ${err?.message || 'unknown error'}`
      );
      continue; // automatic high-intelligence transfer — try the next engine
    }
  }

  // Every attempted engine failed (or the time budget ran out).
  return new Response(
    JSON.stringify({
      error: true,
      message: 'All attempted engines failed. They may be rate-limited or the keys may be missing.',
      requestedEngine,
      triedEngines,
      details: errors,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS_HEADERS } }
  );
}
