// src/services/gemini.service.js — Thin wrapper around Google Gemini REST APIs.
//
// We call the REST endpoints directly (no SDK) because:
//   - The official @google/generative-ai npm package adds ~30MB of node_modules
//     for two endpoints we'd call.
//   - We control the exact request/response shape and can surface errors with
//     the right level of detail for our pino logger.
//
// Operations:
//   1) embed(texts[], {taskType}) — text-embedding-004, 768-dim, L2-normalised
//                          (cosine distance in pgvector == inner product for
//                          unit vectors; HNSW index uses cosine).
//                          taskType defaults to RETRIEVAL_DOCUMENT (indexing);
//                          pass RETRIEVAL_QUERY when embedding a user query.
//   2) rephrase(question, faqs[{q, a}]) — gemini-2.5-flash, takes the top-K
//                          matched FAQs and asks the model to draft a short,
//                          friendly Thai reply.
//   3) chatTurn({contents, tools, toolConfig, generationConfig}) — the Phase 4
//                          function-calling call (v1beta only — see below).
//
// All methods are no-ops (and return null) when GOOGLE_GEMINI_API_KEY is
// missing so the server can still boot before the key is set.

import { config } from '../config.js'
import { logger } from '../logger.js'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1'

// 60s timeout is plenty — embeddings come back in <500ms, rephrase in <3s.
const TIMEOUT_MS = 60_000

const isEnabled = () => !!config.GOOGLE_GEMINI_API_KEY

// Retry transient Gemini failures. Gemini intermittently returns 503 under load
// (and occasionally 502/504/429); a short exponential backoff lets a reply land
// instead of failing the user's turn. Non-retryable statuses (400/401/403/404…)
// return immediately so each caller handles them exactly as before.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 4          // 1 initial attempt + up to 3 retries
const MAX_BACKOFF_MS = 4000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function backoffMs(attempt) {
  // ~500ms, ~1s, ~2s (capped) with a little jitter so concurrent retries don't
  // all hit Gemini on the same tick.
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1)) + Math.random() * 250
}

/**
 * POST `bodyStr` to `url` with the Gemini timeout, retrying transient HTTP
 * statuses and transport/timeout errors. Returns the final Response (ok, or the
 * last error status once retries are exhausted) so each caller keeps its own
 * error handling; re-throws only if fetch kept throwing with no Response at all.
 */
export async function geminiFetch(url, bodyStr, tag) {
  let lastResp = null
  let lastErr = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    bodyStr,
        signal:  AbortSignal.timeout(TIMEOUT_MS),
      })
      if (resp.ok || !RETRYABLE_STATUS.has(resp.status)) return resp
      lastResp = resp
      lastErr = null
      logger.warn(
        { tag, status: resp.status, attempt, maxAttempts: MAX_ATTEMPTS },
        `${tag} HTTP ${resp.status}${attempt < MAX_ATTEMPTS ? ' — retrying' : ' — giving up'}`,
      )
      // Drain the body so the socket frees up — but only when another attempt
      // follows (the final attempt leaves the body for the caller to read/log).
      if (attempt < MAX_ATTEMPTS) await resp.text().catch(() => {})
    } catch (err) {
      // fetch() only throws on transport/timeout (HTTP errors arrive as a
      // Response above) — both are retryable.
      lastResp = null
      lastErr = err
      logger.warn(
        { tag, attempt, maxAttempts: MAX_ATTEMPTS, err: err?.message },
        `${tag} transport error${attempt < MAX_ATTEMPTS ? ' — retrying' : ' — giving up'}`,
      )
    }
    if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt))
  }
  if (lastResp) return lastResp
  throw lastErr ?? new Error(`${tag} request failed`)
}

/**
 * Embed one or more texts using Gemini text-embedding-004.
 *
 * @param {string[]} texts
 * @param {{taskType?: string}} [opts]  Gemini task type. Defaults to
 *        'RETRIEVAL_DOCUMENT' (for indexing FAQ content); pass
 *        'RETRIEVAL_QUERY' when embedding a user's search question — Google's
 *        retrieval is asymmetric and using the wrong role hurts recall.
 * @returns {Promise<number[][]|null>} 768-dim vectors, same order as input.
 *                                      Returns null if no API key is set.
 */
export async function embed(texts, { taskType = 'RETRIEVAL_DOCUMENT' } = {}) {
  if (!isEnabled()) return null
  if (!Array.isArray(texts) || texts.length === 0) return []

  const url = `${BASE_URL}/models/${config.GOOGLE_GEMINI_EMBED_MODEL}:batchEmbedContents?key=${config.GOOGLE_GEMINI_API_KEY}`

  const body = {
    requests: texts.map((t) => ({
      model: `models/${config.GOOGLE_GEMINI_EMBED_MODEL}`,
      content: { parts: [{ text: String(t).slice(0, 8000) }] },   // 8k char cap
      outputDimensionality: 768,
      taskType,
    })),
  }

  try {
    const resp = await geminiFetch(url, JSON.stringify(body), 'gemini embed')
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      logger.error({ status: resp.status, body: text.slice(0, 500) }, 'gemini embed failed')
      throw new Error(`gemini embed ${resp.status}`)
    }
    const json = await resp.json()
    return (json.embeddings || []).map((e) => e.values)
  } catch (err) {
    logger.error({ err }, 'gemini embed error')
    throw err
  }
}

/**
 * Embed a single text. Convenience wrapper for the common case where we
 * don't want to batch. Passes opts (e.g. taskType) through to embed().
 */
export async function embedOne(text, opts) {
  const out = await embed([text], opts)
  return out?.[0] ?? null
}

/**
 * Rephrase the top-K FAQ matches into a short, friendly Thai reply.
 *
 * @param {string} question  The user's question (Thai).
 * @param {{question:string, answer:string, category?:string}[]} matches
 *        Top-K matched FAQs (cosine-similarity ordered).
 * @returns {Promise<string|null>} Rephrased Thai text, or null if no key /
 *                                 no matches / Gemini refused / truncated.
 */
export async function rephrase(question, matches) {
  if (!isEnabled()) return null
  if (!Array.isArray(matches) || matches.length === 0) return null

  const systemPrompt = [
    'คุณเป็นแอดมินของเว็บไซต์หาห้องเช่า "Room Match"',
    'หน้าที่ของคุณคือส่งต่อ "คำตอบอ้างอิง" ไปยังผู้ใช้ โดยรักษาเนื้อหาทุกประโยคไว้ครบถ้วน',
    '',
    'กฎสำคัญ (ห้ามละเมิดเด็ดขาด):',
    '1. ห้ามตัดทอน ห้ามย่อ ห้ามสรุปย่อ ต้องส่งทุกประโยค/ตัวเลข/รายละเอียดที่อยู่ในคำตอบอ้างอิง',
    '2. ห้ามเพิ่มข้อมูลที่ไม่มีในคำตอบอ้างอิง (เช่น เบอร์โทร ลิงก์ ราคา สถานที่ หรือเงื่อนไขเพิ่มเติม)',
    '3. ห้ามเปลี่ยนแปลงตัวเลข ชื่อเฉพาะ หรือข้อเท็จจริงใดๆ ในคำตอบอ้างอิง',
    '4. ห้ามเปลี่ยนความหมาย — ถ้าคำตอบอ้างอิงบอก "1-2 เดือน" ต้องตอบ "1-2 เดือน" ไม่ใช่ "ประมาณ 1 เดือน"',
    '',
    'สิ่งที่ทำได้:',
    '- ปรับคำลงท้ายให้เป็นกันเอง ("ค่ะ" หรือ "นะคะ")',
    '- เพิ่มคำทักทายสั้นๆ ตามธรรมชาติ (เช่น "สวัสดีค่ะ" "ขอบคุณที่สอบถามค่ะ") ถ้าเหมาะสม',
    '- เชื่อมประโยคให้อ่านลื่นขึ้น โดยไม่ตัดเนื้อหาออก',
    '',
    'ถ้าคำตอบอ้างอิงไม่เกี่ยวกับคำถามผู้ใช้ ให้ตอบว่า "รอแอดมินตอบให้นะคะ"',
  ].join('\n')

  const userPrompt = [
    `คำถามจากผู้ใช้: ${question}`,
    '',
    'คำถาม-คำตอบที่เกี่ยวข้อง (เรียงตามความใกล้เคียง):',
    ...matches.map((m, i) => `[${i + 1}] Q: ${m.question}\n    A: ${m.answer}`),
    '',
    'ช่วยร่างคำตอบที่เป็นธรรมชาติและเป็นกันเอง โดยอิงจากคำตอบข้างต้น',
  ].join('\n')

  const url = `${BASE_URL}/models/${config.GOOGLE_GEMINI_REPHRASE_MODEL}:generateContent?key=${config.GOOGLE_GEMINI_API_KEY}`

  // v1 stable endpoint doesn't accept `systemInstruction` as a top-level
  // field, so we inline the system prompt into the user content.
  const body = {
    contents: [{
      role: 'user',
      parts: [{
        text: `${systemPrompt}\n\n---\n\n${userPrompt}`,
      }],
    }],
    generationConfig: {
      temperature:     0.4,
      topK:            20,
      topP:            0.9,
      // gemini-2.5-flash is a thinking model: reasoning tokens come out of
      // this same budget, so leave plenty of headroom for long FAQ answers
      // (the caller's contract is "never shorten"). Truncation is handled
      // below by returning null rather than a cut-off string.
      maxOutputTokens: 4096,
    },
  }

  try {
    const resp = await geminiFetch(url, JSON.stringify(body), 'gemini rephrase')
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      logger.error({ status: resp.status, body: text.slice(0, 500) }, 'gemini rephrase failed')
      return null
    }
    const json = await resp.json()
    const txt = json?.candidates?.[0]?.content?.parts?.[0]?.text
    const finish = json?.candidates?.[0]?.finishReason
    if (finish === 'MAX_TOKENS') {
      // A truncated answer violates the "relay verbatim, never shorten"
      // contract — return null so getFaqAnswer falls back to the full raw
      // rendered text instead of sending a cut-off answer to the user.
      logger.warn({ finish, len: txt?.length }, 'gemini rephrase hit max output tokens — returning null (caller falls back to raw)')
      return null
    }
    return typeof txt === 'string' ? txt.trim() : null
  } catch (err) {
    logger.error({ err }, 'gemini rephrase error')
    return null
  }
}

/**
 * Returns true if the Gemini API is configured and ready to use.
 * Routes use this to return 503 with a clear message when the key is missing.
 */
export function isConfigured() {
  return isEnabled()
}

// ---------------------------------------------------------------------------
// Chat agent — function-calling (Phase 4+)
//
// chatTurn() performs ONE generateContent call to the Gemini **v1beta**
// endpoint with optional tools. The multi-turn dispatch LOOP (which executes
// tool handlers) lives in chatAgent.service.js — it is linebot-layer code and
// must not be pulled into this low-level service. chatTurn stays a pure single
// HTTP call with no knowledge of the tool registry.
//
// CRITICAL: function-calling (`tools` / `toolConfig`) is supported ONLY on the
// v1beta endpoint. The v1 stable endpoint returns HTTP 400
//   `Unknown name "tools": Cannot find field`
//   `Unknown name "toolConfig": Cannot find field`
// — exactly the same class of endpoint-quirk that bit us in Phase 3 with the
// top-level `systemInstruction` field. So chatTurn always uses v1beta, even
// for text-only turns. (embed/rephrase stay on v1; they don't need tools.)
//
// Returns a normalised object so the loop never has to paw through raw JSON:
//   { ok:true,  text, functionCalls, finishReason, usage }
//   { ok:false, status?, error }
// `functionCalls` = [{ name, args, thoughtSignature }] from the model turn's
// parts. Gemini 2.5 Flash is a *thinking* model: every functionCall part
// carries an opaque `thoughtSignature` that MUST be echoed back on the matching
// functionResponse part to keep the reasoning chain intact across the
// round-trip (verified empirically — omitting it degrades multi-turn behaviour).
// ---------------------------------------------------------------------------

const V1BETA_URL = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * One Gemini generateContent call, optionally with tools.
 *
 * @param {object} opts
 * @param {Array} opts.contents        Gemini `contents` array (caller-shaped).
 * @param {Array} [opts.tools]         `[{ functionDeclarations: [...] }]`.
 * @param {object}[opts.toolConfig]    e.g. { functionCallingConfig: { mode } }.
 * @param {object}[opts.generationConfig] Overrides (merged over defaults).
 * @returns {Promise<{ok:boolean, text?:string, functionCalls?:Array,
 *                    finishReason?:string, usage?:object, status?:number,
 *                    error?:string}>}
 */
export async function chatTurn({ contents, tools, toolConfig, generationConfig } = {}) {
  if (!isEnabled()) return { ok: false, error: 'gemini not configured' }
  const url = `${V1BETA_URL}/models/${config.GOOGLE_GEMINI_REPHRASE_MODEL}:generateContent?key=${config.GOOGLE_GEMINI_API_KEY}`

  const body = {
    contents,
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    // Thinking models spend output tokens on internal reasoning, so leave a
    // generous ceiling (defaults can be overridden per-call).
    generationConfig: {
      temperature:     0.6,
      topK:            20,
      topP:            0.9,
      maxOutputTokens: 2048,
      ...(generationConfig || {}),
    },
  }

  try {
    const resp = await geminiFetch(url, JSON.stringify(body), 'gemini chatTurn')
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      logger.error({ status: resp.status, body: text.slice(0, 500) }, 'gemini chatTurn failed')
      return { ok: false, status: resp.status, error: `gemini ${resp.status}` }
    }
    const json   = await resp.json()
    const cand   = json?.candidates?.[0] ?? {}
    const parts  = Array.isArray(cand?.content?.parts) ? cand.content.parts : []
    const text   = parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
      .trim()
    const functionCalls = parts
      .filter((p) => p && typeof p.functionCall === 'object' && p.functionCall)
      .map((p) => ({
        name:           p.functionCall.name,
        args:           p.functionCall.args && typeof p.functionCall.args === 'object'
                          ? p.functionCall.args : {},
        thoughtSignature: p.thoughtSignature ?? null,
      }))
    return {
      ok:           true,
      text:         text || null,
      functionCalls,
      finishReason: cand.finishReason ?? null,
      usage:        json?.usageMetadata ?? null,
    }
  } catch (err) {
    logger.error({ err }, 'gemini chatTurn error')
    return { ok: false, error: 'gemini transport error' }
  }
}
