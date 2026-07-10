// src/routes/faqs.js — Admin-managed FAQ knowledge base.
//
// Why these routes exist:
//   The Line bot (AskAboutRoomIntentHandler) calls /api/faqs/search with
//   a free-text Thai question. The endpoint embeds the query with Gemini,
//   runs a pgvector cosine search over the active FAQs, then asks Gemini
//   to rephrase the top match into a friendly Thai reply. If no good
//   match is found, the bot escalates to admin as before.
//
// Admin CRUD lives at /api/faqs and is gated by requireAdmin.
// /api/faqs/search is gated by requireBot (only the bot calls it).
//
// Phase 2.8: dynamic block-based answers.
//   FAQs can be authored as a list of typed blocks (text / count / stat /
//   single / list / link) via /admin/faqs/[new|edit]. The bot's search
//   endpoint renders blocks into Thai text using the live rooms/viewings/
//   tenants tables (via the safe-query whitelist). The plain-text `answer`
//   column is kept as a denormalised render cache so the embedding stays
//   stable.

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/faqs.repo.js'
import * as gemini from '../services/gemini.service.js'
import { renderAnswerBlocks, renderAnswerCache } from '../services/faqBlocks.service.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { requireBot }   from '../middleware/requireBot.js'

export const faqs = Router()

// ---------------------------------------------------------------------------
// Block schemas (mirrored in the client form)
// ---------------------------------------------------------------------------

const opSchema = z.enum(['=', '!=', '<', '<=', '>', '>=', 'IN'])
const condSchema = z.object({
  col:   z.string().max(60),
  op:    opSchema,
  value: z.union([
    z.string().max(200),
    z.number(),
    z.array(z.union([z.string().max(200), z.number()])).max(50),
  ]).optional(),
})
const tableName = z.enum(['rooms', 'viewings', 'tenants'])

const blockText = z.object({
  type: z.literal('text'),
  text: z.string().max(500),
})

const blockCount = z.object({
  type:       z.literal('count'),
  table:      tableName,
  conditions: z.array(condSchema).max(5),
  format:     z.string().max(200),
})

const blockStat = z.object({
  type:       z.literal('stat'),
  table:      tableName,
  aggregate:  z.object({
    fn:   z.enum(['COUNT', 'AVG', 'MIN', 'MAX']),
    col:  z.string().max(60),
  }),
  conditions: z.array(condSchema).max(5),
  format:     z.string().max(200),
})

const blockSingle = z.object({
  type:   z.literal('single'),
  table:  tableName,
  column: z.string().max(60),
  rowKey: z.enum(['roomId', 'viewingId', 'tenantId']),
  format: z.string().max(200),
})

const blockList = z.object({
  type:         z.literal('list'),
  table:        tableName,
  columns:      z.array(z.string().max(60)).min(1).max(6),
  conditions:   z.array(condSchema).max(5),
  orderBy:      z.object({
    column: z.string().max(60),
    dir:    z.enum(['ASC', 'DESC']),
  }).optional(),
  limit:        z.number().int().min(1).max(5),
  itemTemplate: z.string().max(300),
})

const blockLink = z.object({
  type:  z.literal('link'),
  label: z.string().max(200),
  url:   z.string().url().max(500),
})

const block = z.discriminatedUnion('type', [
  blockText, blockCount, blockStat, blockSingle, blockList, blockLink,
])

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

const faqBody = z.object({
  question:     z.string().trim().min(2, 'กรุณากรอกคำถาม').max(2000),
  answer:       z.string().trim().min(2, 'กรุณากรอกคำตอบ').max(5000)
                   .optional().or(z.literal('')),
  answerBlocks: z.array(block).max(20).optional(),
  category:     z.string().trim().max(80).optional().or(z.literal('')),
  keywords:     z.array(z.string().trim().min(1)).max(50).optional(),
  sortOrder:    z.coerce.number().int().min(0).max(9999).optional(),
  isActive:     z.boolean().optional(),
  isDraft:      z.boolean().optional(),
})
const idParam = z.object({ id: z.coerce.number().int().positive() })

// Helper — reconcile (answer, answerBlocks) into a final answer cache.
// `existing` is the row we're updating; used to preserve the current answer
// when the patch body doesn't touch either field.
async function buildAnswerCache({ answer, answerBlocks }, existing) {
  // Prefer the structured blocks if provided and non-empty.
  if (Array.isArray(answerBlocks) && answerBlocks.length > 0) {
    return await renderAnswerCache(answerBlocks)
  }
  // Fall back to the plain text answer (legacy / simple cases).
  if (typeof answer === 'string' && answer.trim().length > 0) return answer.trim()
  // Preserve the existing answer if neither field was supplied.
  if (existing && typeof existing.answer === 'string') return existing.answer
  return ''
}

// Helper — enforce the isDraft/isActive combination.
function validateDraftFlag(isDraft, isActive) {
  if (isDraft === true && isActive === true) {
    throw new AppError(400, 'FAQ_DRAFT_ACTIVE',
      'ไม่สามารถ "บันทึกแบบร่าง" และ "เปิดใช้งาน" พร้อมกันได้ กรุณาเลือกอย่างใดอย่างหนึ่ง')
  }
}

// GET /api/faqs — list (admin). Optional filters: isActive, isDraft, category.
faqs.get('/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const isActive = req.query.isActive === undefined
      ? undefined
      : req.query.isActive === 'true'
    const isDraft  = req.query.isDraft === undefined
      ? undefined
      : req.query.isDraft === 'true'
    const items = await repo.list({
      isActive,
      isDraft,
      category: req.query.category || undefined,
    })
    res.json(items)
  }),
)

// POST /api/faqs — create (admin). Generates the embedding inline if Gemini
// is configured; the row is saved first so the user always sees the FAQ
// immediately even if the embedding call later fails (then we mark it
// `hasEmbedding: false` and the UI shows a "regenerate" button).
faqs.post('/',
  requireAdmin,
  validate({ body: faqBody }),
  asyncHandler(async (req, res) => {
    validateDraftFlag(req.body.isDraft, req.body.isActive)

    const answer = await buildAnswerCache({
      answer:       req.body.answer,
      answerBlocks: req.body.answerBlocks,
    })
    if (!answer) {
      throw new AppError(400, 'FAQ_EMPTY_ANSWER',
        'กรุณากรอกคำตอบ หรือเพิ่มบล็อกคำตอบอย่างน้อย 1 บล็อก')
    }

    const row = await repo.create({
      question:     req.body.question,
      answer,
      answerBlocks: req.body.answerBlocks ?? [],
      category:     req.body.category || null,
      keywords:     req.body.keywords ?? [],
      sortOrder:    req.body.sortOrder ?? 100,
      isActive:     req.body.isActive ?? true,
      isDraft:      req.body.isDraft ?? true,
    })

    // Best-effort embedding. Only published rows get embedded so that
    // vectorSearch() never returns drafts.
    if (gemini.isConfigured() && row.isActive && !row.isDraft) {
      try {
        const emb = await gemini.embedOne(`${row.question}\n${row.answer}`)
        if (emb) await repo.setEmbedding(row.id, emb)
      } catch (err) {
        // Logged inside gemini.service — swallow so the create still succeeds.
      }
    }
    res.status(201).json(await repo.findById(row.id))
  }),
)

// GET /api/faqs/:id — single (admin)
faqs.get('/:id', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const row = await repo.findById(req.params.id)
    if (!row) throw new AppError(404, 'FAQ_NOT_FOUND', 'ไม่พบ FAQ นี้')
    res.json(row)
  }),
)

// PATCH /api/faqs/:id — update (admin). Re-embeds if the rendered answer
// changed AND the row is currently published.
faqs.patch('/:id', requireAdmin, validate({ params: idParam, body: faqBody.partial() }),
  asyncHandler(async (req, res) => {
    const existing = await repo.findById(req.params.id)
    if (!existing) throw new AppError(404, 'FAQ_NOT_FOUND', 'ไม่พบ FAQ นี้')

    const nextIsDraft  = req.body.isDraft  !== undefined ? req.body.isDraft  : existing.isDraft
    const nextIsActive = req.body.isActive !== undefined ? req.body.isActive : existing.isActive
    validateDraftFlag(nextIsDraft, nextIsActive)

    const nextAnswer = await buildAnswerCache({
      answer:       req.body.answer,
      answerBlocks: req.body.answerBlocks,
    }, existing)
    if (!nextAnswer) {
      throw new AppError(400, 'FAQ_EMPTY_ANSWER',
        'กรุณากรอกคำตอบ หรือเพิ่มบล็อกคำตอบอย่างน้อย 1 บล็อก')
    }

    const fields = {
      question:     req.body.question,
      answer:       nextAnswer,
      answerBlocks: req.body.answerBlocks,    // undefined → unchanged (existing repo behaviour)
      category:     req.body.category === '' ? null : req.body.category,
      keywords:     req.body.keywords,
      sortOrder:    req.body.sortOrder,
      isActive:     req.body.isActive,
      isDraft:      req.body.isDraft,
    }
    await repo.update(req.params.id, fields)
    const updated = await repo.findById(req.params.id)

    const willPublish = updated.isActive && !updated.isDraft
    const wasPublished = existing.isActive && !existing.isDraft
    const answerChanged = nextAnswer !== existing.answer
    const questionChanged = req.body.question && req.body.question !== existing.question
    const textChanged = (answerChanged || questionChanged) && willPublish

    // Embed (or re-embed) only when the row is published and its text changed.
    if (textChanged && gemini.isConfigured()) {
      try {
        const emb = await gemini.embedOne(`${updated.question}\n${updated.answer}`)
        if (emb) await repo.setEmbedding(updated.id, emb)
      } catch { /* embedding is best-effort */ }
    }
    // If the row was just published for the first time (was draft, now active),
    // embed it even if text didn't change so the bot can answer.
    if (!wasPublished && willPublish && gemini.isConfigured()) {
      try {
        const emb = await gemini.embedOne(`${updated.question}\n${updated.answer}`)
        if (emb) await repo.setEmbedding(updated.id, emb)
      } catch { /* best-effort */ }
    }

    res.json(updated)
  }),
)

// POST /api/faqs/:id/regenerate-embedding — admin re-runs the embed.
faqs.post('/:id/regenerate-embedding', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    if (!gemini.isConfigured()) {
      throw new AppError(503, 'GEMINI_DISABLED', 'ยังไม่ได้ตั้งค่า GOOGLE_GEMINI_API_KEY')
    }
    const row = await repo.findById(req.params.id)
    if (!row) throw new AppError(404, 'FAQ_NOT_FOUND', 'ไม่พบ FAQ นี้')
    try {
      const emb = await gemini.embedOne(`${row.question}\n${row.answer}`)
      if (!emb) throw new AppError(502, 'GEMINI_EMPTY', 'Gemini ส่ง embedding กลับมาว่าง')
      await repo.setEmbedding(row.id, emb)
      res.json(await repo.findById(row.id))
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError(502, 'GEMINI_FAILED', 'ไม่สามารถสร้าง embedding ได้ในขณะนี้')
    }
  }),
)

// DELETE /api/faqs/:id — delete (admin)
faqs.delete('/:id', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const ok = await repo.remove(req.params.id)
    if (!ok) throw new AppError(404, 'FAQ_NOT_FOUND', 'ไม่พบ FAQ นี้')
    res.status(204).end()
  }),
)

// ---------------------------------------------------------------------------
// Admin: render-preview + sample-ask (no DB writes)
// ---------------------------------------------------------------------------

const contextSchema = z.object({
  roomId:       z.number().int().positive().optional(),
  viewingId:    z.number().int().positive().optional(),
  tenantLineId: z.string().max(80).optional(),
}).optional()

const previewBody = z.object({
  answerBlocks: z.array(block).max(20),
  context:      contextSchema,
})

const sampleAskBody = z.object({
  query:        z.string().trim().min(1).max(2000),
  answerBlocks: z.array(block).max(20),
  context:      contextSchema,
})

// POST /api/faqs/preview — render-only. The marketing admin's live preview
// pane calls this as they edit blocks.
faqs.post('/preview', requireAdmin, validate({ body: previewBody }),
  asyncHandler(async (req, res) => {
    const rendered = await renderAnswerBlocks(
      { answer_blocks: req.body.answerBlocks },
      req.body.context ?? {},
    )
    res.json({ rendered })
  }),
)

// POST /api/faqs/sample-ask — full embed → search → rephrase against the
// in-flight draft. Uses the *draft's* answerBlocks, not the saved row, so
// admin sees the new wording immediately. The bot-facing route handlers
// never call this — this is purely an admin UX surface.
faqs.post('/sample-ask', requireAdmin, validate({ body: sampleAskBody }),
  asyncHandler(async (req, res) => {
    if (!gemini.isConfigured()) {
      throw new AppError(503, 'GEMINI_DISABLED', 'ยังไม่ได้ตั้งค่า GOOGLE_GEMINI_API_KEY')
    }
    const { query: q, answerBlocks, context = {} } = req.body

    let rendered = await renderAnswerBlocks({ answer_blocks: answerBlocks }, context)
    let faqId = null, confidence = null, category = null, found = false

    const emb = await gemini.embedOne(q, { taskType: 'RETRIEVAL_QUERY' })
    if (emb) {
      const matches = await repo.vectorSearch(emb, { topK: 1 })
      if (matches.length) {
        const top = matches[0]
        faqId      = top.id
        confidence = Number(top.similarity.toFixed(4))
        category   = top.category ?? null
        found      = true
        // Override top match's answer with the draft render so admin sees the
        // draft's wording even though it hasn't been saved yet.
        const rephrased = await gemini.rephrase(q, [{ ...top, answer: rendered }])
        if (rephrased) rendered = rephrased
      }
    }
    res.json({ rendered, found, faqId, confidence, category })
  }),
)

// ---------------------------------------------------------------------------
// Bot-facing: vector-search + rephrase
// ---------------------------------------------------------------------------

const searchBody = z.object({
  query:   z.string().trim().min(1).max(2000),
  topK:    z.coerce.number().int().min(1).max(10).optional().default(3),
  context: contextSchema,
})

// POST /api/faqs/search
//   Body:  { query: "ค่าเช่าเท่าไหร่", topK?: 3, context?: {roomId, viewingId} }
//   Reply: { found, answer, faqId, confidence, category }
//
// The bot's AskAboutRoomIntentHandler calls this. If `found` is true the
// bot replies with the (rephrased) `answer`; if false, it escalates to
// admin. `confidence` is the cosine similarity score from pgvector in
// [0, 1] — the bot applies its own threshold.
//
// Phase 2.8: if the top match has `answer_blocks`, render them with the
// bot's context before passing to Gemini rephrase. Legacy rows with no
// blocks fall through to `top.answer` verbatim.
faqs.post('/search', requireBot, validate({ body: searchBody }),
  asyncHandler(async (req, res) => {
    if (!gemini.isConfigured()) {
      throw new AppError(503, 'GEMINI_DISABLED', 'ยังไม่ได้ตั้งค่า GOOGLE_GEMINI_API_KEY')
    }
    const { query: q, topK, context = {} } = req.body

    const queryEmbedding = await gemini.embedOne(q, { taskType: 'RETRIEVAL_QUERY' })
    if (!queryEmbedding) {
      throw new AppError(502, 'GEMINI_EMBED_FAILED', 'ไม่สามารถสร้าง embedding สำหรับคำถามได้')
    }

    const matches = await repo.vectorSearch(queryEmbedding, { topK, minSimilarity: 0 })
    if (matches.length === 0) {
      return res.json({ found: false, answer: null, faqId: null, confidence: null, category: null })
    }

    const top = matches[0]
    let renderedTopAnswer = null
    if (Array.isArray(top.answerBlocks) && top.answerBlocks.length > 0) {
      try {
        renderedTopAnswer = await renderAnswerBlocks(
          { answer_blocks: top.answerBlocks },
          context,
        )
      } catch (err) {
        renderedTopAnswer = null   // fall through to legacy path
      }
    }

    const matchesForRephrase = matches.map((m, i) => (
      i === 0 && renderedTopAnswer
        ? { ...m, answer: renderedTopAnswer }
        : m
    ))

    const rephrased = await gemini.rephrase(q, matchesForRephrase)

    return res.json({
      found:      true,
      answer:     rephrased ?? (renderedTopAnswer ?? top.answer),
      faqId:      top.id,
      confidence: Number(top.similarity.toFixed(4)),
      category:   top.category ?? null,
    })
  }),
)