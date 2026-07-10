// src/linebot/tools/getFaqAnswer.js — RAG answer tool for the chat agent.
//
// Answers general/FAQ questions about renting or listing on Room Match by
// running retrieval-augmented generation over the FAQ knowledge base. Use this
// for policy/process questions such as "ค่าเช่าจ่ายเมื่อไหร่", "ต้องวางมัดจำไหม",
// "วิธีลงห้องให้เช่า" — anything whose answer is documented as a published FAQ.
//
// Pipeline:
//   1. embed the user's Thai question with Gemini text-embedding-004 (768-dim),
//      using the RETRIEVAL_QUERY task type (the query side of asymmetric retrieval)
//   2. cosine-search the `faqs` table via pgvector (top-3, similarity >= 0.3)
//   3. if nothing clears the floor, signal { found:false } so the agent loop
//      escalates to a human admin instead of hallucinating an answer
//   4. render the top match's answer_blocks (dynamic counts/stats/etc.) to text
//   5. rephrase that rendered reference into a friendly Thai reply via Gemini,
//      falling back to the raw rendered text if rephrase is unavailable
//
// The knowledge boundary is the FAQ table: if it isn't in there, we do not
// answer from the model's parametric memory — we return { found:false } and let
// the system prompt route the user to an admin. This keeps the bot truthful.

import { embedOne, rephrase } from '../../services/gemini.service.js'
import { vectorSearch }       from '../../db/repositories/faqs.repo.js'
import { renderAnswerBlocks } from '../../services/faqBlocks.service.js'

// Similarity floor below which we treat the FAQ as "not really a match". 0.3 is
// deliberately lenient so paraphrased Thai questions still hit, but it still
// rejects clearly-unrelated queries so we escalate rather than mis-answer.
const TOP_K = 3
const MIN_SIMILARITY = 0.3

// rephrase emits exactly this phrase when it judges the matched FAQ unrelated
// to the question. Treat it as "not found" so the agent escalates instead of
// relaying a dead-end (which would create no admin ticket).
const REFUSAL_PHRASE = 'รอแอดมินตอบให้นะคะ'

export const name = 'getFaqAnswer'

// CRITICAL: this description is the ONLY text Gemini sees when deciding WHETHER
// to call this tool, so it must state the trigger conditions precisely.
export const description =
  'Answer a general or policy/process question about renting or listing rooms on ' +
  'the Room Match rental platform, using retrieval-augmented generation over the ' +
  'FAQ knowledge base. Use this when the user asks about payment timing, deposits, ' +
  'booking/viewing steps, rules, fees, or any documented FAQ topic ' +
  '(e.g. "ค่าเช่าจ่ายเมื่อไหร่", "ต้องวางมัดจำไหม", "วิธีลงห้องให้เช่า"). ' +
  'Do NOT use it for searching/listing specific rooms, checking a booking, or ' +
  'anything user-account specific. Returns { found, answer, source, category, ' +
  'similarity }; when found is false, the agent should escalate to an admin.'

export const parameters = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The user question in Thai (verbatim or close paraphrase).',
    },
  },
  required: ['question'],
}

/**
 * Run the FAQ RAG pipeline for one user question.
 *
 * @param {{question?: string}} args
 * @param {{lineUserId: string, logger: object}} ctx
 * @returns {Promise<object>} Plain JSON object for Gemini's functionResponse.
 */
export async function handler(args, ctx) {
  const log = ctx?.logger
  const question = args?.question

  // Missing/empty question is a soft failure — let the model re-ask the user.
  if (typeof question !== 'string' || question.trim() === '') {
    log?.warn({ tool: name }, 'getFaqAnswer: missing question arg')
    return { error: 'question required' }
  }

  // 1. Embed the question with the QUERY task type for best recall.
  const vec = await embedOne(question, { taskType: 'RETRIEVAL_QUERY' })
  if (!vec || vec.length !== 768) {
    log?.warn({ tool: name, questionLen: question.length }, 'getFaqAnswer: embedding unavailable')
    return { error: 'embedding unavailable' }
  }

  // 2. Vector search the published FAQ set (drafts are excluded in the repo).
  const matches = await vectorSearch(vec, { topK: TOP_K, minSimilarity: MIN_SIMILARITY })

  // 3. Nothing cleared the floor -> tell the model we have no answer so it can
  //    escalateToAdmin. Do NOT return the nearest low-similarity match.
  if (matches.length === 0) {
    log?.info({ tool: name, questionLen: question.length, minSimilarity: MIN_SIMILARITY },
      'getFaqAnswer: no FAQ above similarity floor')
    return { found: false }
  }

  // 4-5. Render the top match's dynamic answer blocks to plain Thai text.
  const top = matches[0]
  const rendered = await renderAnswerBlocks(
    { answer_blocks: top.answerBlocks, answer: top.answer },
    {},
  )

  // 6. Rephrase the rendered reference into a friendly Thai reply. If the
  //    rephrase step judges the match unrelated it emits REFUSAL_PHRASE — treat
  //    that as "not found" so the agent escalates instead of relaying a dead-end.
  let answer = await rephrase(question, [{ question: top.question, answer: rendered }])
  if (answer && answer.trim().startsWith(REFUSAL_PHRASE)) {
    log?.info({ tool: name, faqId: top.id, similarity: top.similarity },
      'getFaqAnswer: matched FAQ judged unrelated -> found:false (escalate)')
    return { found: false }
  }
  if (!answer) {
    log?.warn({ tool: name, faqId: top.id, similarity: top.similarity },
      'getFaqAnswer: rephrase unavailable, using rendered fallback')
    answer = rendered
  }

  log?.info(
    { tool: name, faqId: top.id, category: top.category, similarity: top.similarity,
      answerLen: answer.length },
    'getFaqAnswer: answered',
  )

  // 7. Hand back the ready-to-relay Thai answer plus provenance. The system
  //    prompt relays `answer` to the user VERBATIM (the rephrase step already
  //    produced the final user-facing text).
  return {
    found:      true,
    answer,
    source:     top.question,
    category:   top.category,
    similarity: top.similarity,
  }
}
