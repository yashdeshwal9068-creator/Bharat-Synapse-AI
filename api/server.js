/**
 * Bharat Nova AI — /api/server (Vercel Edge Function)
 * ─────────────────────────────────────────────────────
 * 14-ENGINE SUPER AI WITH AUTOMATIC HIGH-INTELLIGENCE FAILOVER
 *
 * The client sends ONE request with a chosen "engine".
 * The server tries that engine first (including vision support if image present).
 * If the selected engine fails (or throws vision-not-supported) AND image present,
 * ONLY THEN failover to Gemini as High-Intelligence Backup.
 * Otherwise normal high-intelligence fallback chain.
 *
 * FIXED:
 * 1. All 8 failing engines repaired with correct official base URLs, model IDs, headers, Cloudflare /ai/run path + API_TOKEN.
 * 2. Smart vision logic: NEVER auto-forces Gemini on image upload. Selected engine ALWAYS attempts first.
 *    Vision-capable selected engines receive properly formatted base64 image payloads.
 *    Non-vision selected + image → natural error → ONLY then Gemini backup.
 */

export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PROVIDER_TIMEOUT_MS = 9000;
const TOTAL_BUDGET_MS = 22000;
const MIN_REMAINING_MS = 1800;

async function fetchWithTimeout(url, options, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function flattenMessages(messages) {
  return (messages || [])
    .filter(m => m && m.role && m.content != null)
    .map(m => ({ role: m.role, content: String(m.content) }));
}

async function readErrorDetail(res) {
  try { return (await res.text()).slice(0, 220); } catch { return ''; }
}

/* Vision message builder for OpenAI-compatible vision models */
function buildVisionMessages(messages, attachment) {
  const flat = flattenMessages(messages);
  if (!flat.length || !attachment || !attachment.data || !attachment.mimeType) return flat;

  const cleanData = String(attachment.data).replace(/^data:[^;]+;base64,/, '');
  const imageUrl = `data:${attachment.mimeType};base64,${cleanData}`;

  let lastUserIdx = -1;
  for (let i = flat.length - 1; i >= 0; i--) {
    if (flat[i].role === 'user') { lastUserIdx = i; break; }
  }

  const visionContent = [
    { type: 'text', text: flat[lastUserIdx >= 0 ? lastUserIdx : flat.length - 1].content },
    { type: 'image_url', image_url: { url: imageUrl } }
  ];

  const newMsgs = [...flat];
  if (lastUserIdx >= 0) {
    newMsgs[lastUserIdx] = { role: 'user', content: visionContent };
  } else {
    newMsgs.push({ role: 'user', content: visionContent });
  }
  return newMsgs;
}

function ensureNoVisionForTextEngine(attachment, label) {
  if (attachment && attachment.data) {
    throw new Error(`${label}: Vision/image input not supported by this engine.`);
  }
}

/* ════════════════════════════════════════════════════
   GENERIC OpenAI-COMPATIBLE CALLER (with vision support)
════════════════════════════════════════════════════ */
async function callOpenAICompatible({ url, apiKey, model, messages, temperature, max_tokens, extraHeaders, label, timeoutMs, attachment, supportsVision = false }) {
  if (!apiKey) {
    throw new Error(`${label}: API key not set on the server (check Vercel env vars).`);
  }

  let outgoingMessages;
  if (attachment && attachment.data && attachment.mimeType) {
    if (!supportsVision) {
      throw new Error(`${label}: Vision/image input not supported by this engine.`);
    }
    outgoingMessages = buildVisionMessages(messages, attachment);
  } else {
    outgoingMessages = flattenMessages(messages);
  }

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
   GOOGLE GEMINI — native REST
════════════════════════════════════════════════════ */
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

async function callGemini(messages, temperature, max_tokens, timeoutMs, attachment) {
  const primaryKey = process.env.GEMINI_API_KEY;
  const backupKey  = process.env.GEMINI_API_KEY_2;

  if (!primaryKey) throw new Error('Gemini: API key not set on the server (GEMINI_API_KEY missing).');

  let systemText = '';
  const contents = [];
  for (const m of flattenMessages(messages)) {
    if (m.role === 'system') { systemText += m.content + '\n'; continue; }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  if (!contents.length && !attachment) throw new Error('Gemini: no readable message content.');

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

  try {
    return await callGeminiWithKey(primaryKey, body, timeoutMs);
  } catch (primaryErr) {
    if (!backupKey) throw primaryErr;
    console.log('Primary key failed, switching to backup key...', primaryErr?.message || String(primaryErr));
  }

  try {
    return await callGeminiWithKey(backupKey, body, timeoutMs);
  } catch (backupErr) {
    throw new Error(`Gemini: both API keys failed. Last error: ${backupErr?.message || 'unknown'}`);
  }
}

/* ════════════════════════════════════════════════════
   COHERE — v2 Chat API
════════════════════════════════════════════════════ */
async function callCohere(messages, temperature, max_tokens, timeoutMs, attachment) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error('Cohere: API key not set on the server.');

  ensureNoVisionForTextEngine(attachment, 'Cohere');

  const outgoingMessages = flattenMessages(messages);
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
   PROVIDER REGISTRY — 14-Engine Super AI (FIXED)
════════════════════════════════════════════════════ */
const PROVIDERS = {
  gemini: {
    name: 'Gemini',
    vision: true,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callGemini(messages, temperature, max_tokens, timeoutMs, attachment),
  },
  openrouter: {
    name: 'OpenRouter',
    vision: true,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: process.env.OPENROUTER_API_KEY,
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages, temperature, max_tokens, timeoutMs, attachment,
      extraHeaders: { 'HTTP-Referer': 'https://bharat-nova-ai.vercel.app', 'X-Title': 'Bharat Nova AI' },
      supportsVision: true,
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
      supportsVision: false,
      label: 'DeepSeek',
    }),
  },
  mistral: {
    name: 'Mistral',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.mistral.ai/v1/chat/completions',
      apiKey: process.env.MISTRAL_API_KEY,
      model: 'mistral-small-latest',
      messages, temperature, max_tokens, timeoutMs, attachment,
      supportsVision: false,
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
      supportsVision: false,
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
      supportsVision: false,
      label: 'Zai AI',
    }),
  },
  cloudflare: {
    name: 'Cloudflare',
    vision: false,
    call: async (messages, temperature, max_tokens, timeoutMs, attachment) => {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY;
      if (!accountId) throw new Error('Cloudflare: CLOUDFLARE_ACCOUNT_ID env var not set.');
      if (!apiToken) throw new Error('Cloudflare: CLOUDFLARE_API_TOKEN env var not set.');

      const modelName = '@cf/meta/llama-3.1-8b-instruct';
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelName}`;

      if (attachment && attachment.data) {
        throw new Error('Cloudflare: Vision/image input not supported by this engine.');
      }

      const outgoingMessages = flattenMessages(messages);

      let res;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ messages: outgoingMessages }),
        }, timeoutMs);
      } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`Cloudflare: timed out after ${Math.round((timeoutMs || PROVIDER_TIMEOUT_MS) / 1000)}s.`);
        throw new Error(`Cloudflare: request failed (${err?.message || 'network error'}).`);
      }

      if (!res.ok) {
        const detail = await readErrorDetail(res);
        throw new Error(`Cloudflare: HTTP ${res.status} — ${detail || 'request failed'}`);
      }

      const data = await res.json();
      const content = data?.result?.response || (typeof data?.result === 'string' ? data.result : '');
      if (!content || !String(content).trim()) throw new Error('Cloudflare: returned an empty response.');
      return String(content).trim();
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
      supportsVision: false,
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
      supportsVision: false,
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
      supportsVision: false,
      label: 'Fireworks',
    }),
  },
  cohere: {
    name: 'Cohere',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callCohere(messages, temperature, max_tokens, timeoutMs, attachment),
  },
  groq: {
    name: 'Groq',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY,
      model: 'llama-3.1-8b-instant',
      messages, temperature, max_tokens, timeoutMs, attachment,
      supportsVision: false,
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
      supportsVision: false,
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
      supportsVision: false,
      label: 'Cerebras',
    }),
  },
};

const FALLBACK_ORDER = [
  'gemini', 'openrouter', 'deepseek',
  'mistral', 'nvidia', 'zai',
  'cloudflare', 'siliconflow', 'huggingface',
  'fireworks', 'cohere',
  'groq', 'sambanova', 'cerebras',
];

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

  let attachment = null;
  if (rawAttachment && typeof rawAttachment === 'object' && rawAttachment.data && rawAttachment.mimeType) {
    const data = String(rawAttachment.data);
    if (data.length > 9000000) {
      return new Response(
        JSON.stringify({ error: { message: 'Attachment is too large. Please use a smaller image or file (max ~6MB).' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      );
    }
    attachment = {
      data,
      mimeType: String(rawAttachment.mimeType),
      name: rawAttachment.name ? String(rawAttachment.name).slice(0, 120) : '',
    };
  }

  // FIX 2: Never auto-switch to Gemini. User's current selection tries first.
  const attemptOrder = [requestedEngine, ...FALLBACK_ORDER.filter(k => k !== requestedEngine)];
  const errors = {};
  const triedEngines = [];
  const startedAt = Date.now();

  for (let i = 0; i < attemptOrder.length; i++) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < MIN_REMAINING_MS) break;

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

      const isImageQuery = !!attachment;

      // CRITICAL FIX 2: Selected engine fails + image present → ONLY Gemini backup
      if (isImageQuery && key === requestedEngine && requestedEngine !== 'gemini') {
        console.log(`[${PROVIDERS[key].name}] failed with image. Triggering Gemini High-Intelligence Backup ONLY.`);
        try {
          const geminiReply = await PROVIDERS['gemini'].call(messages, temperature, max_tokens, timeoutMs, attachment);
          return new Response(
            JSON.stringify({
              reply: geminiReply,
              engine: 'gemini',
              engineName: PROVIDERS['gemini'].name,
              requestedEngine,
              requestedEngineName: PROVIDERS[requestedEngine].name,
              fallback: true,
              triedEngines: [requestedEngine, 'gemini'],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS_HEADERS } }
          );
        } catch (gemErr) {
          errors['gemini'] = gemErr?.message || 'Gemini backup failed on image';
          break;
        }
      } else {
        const nextKey = attemptOrder[i + 1];
        const nextName = nextKey ? PROVIDERS[nextKey]?.name : null;
        console.log(
          `[${PROVIDERS[key].name}] failed, automatically transferring to High-Intelligence Backup...` +
          (nextName ? ` Trying: ${nextName}` : ' (no more engines in budget)') +
          ` | Reason: ${err?.message || 'unknown error'}`
        );
        continue;
      }
    }
  }

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
