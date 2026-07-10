// src/db/repositories/faqs.repo.js — FAQ CRUD + vector search.
//
// The FAQ table is the bot's knowledge boundary — anything not in here goes
// to admin. We store Gemini text-embedding-004 vectors (768 dims) and use
// pgvector's `<=>` cosine distance for nearest-neighbour search.
//
// All write methods accept an optional `embedding` (number[] of length 768).
// The route layer is responsible for generating the embedding via the
// Gemini API before calling create/update — that keeps the repo pure-SQL.

import { query } from '../pool.js'

const SELECT_FAQ = `
  SELECT
    id, question, answer, category, keywords, sort_order, is_active,
    answer_blocks, is_draft,
    embedding, embedding_model, embedding_at,
    created_at, updated_at
  FROM faqs
`

function rowToFaq(row) {
  if (!row) return null
  return {
    id:             row.id,
    question:       row.question,
    answer:         row.answer,
    category:       row.category,
    keywords:       row.keywords ?? [],
    sortOrder:      row.sort_order,
    isActive:       row.is_active,
    answerBlocks:   row.answer_blocks ?? [],
    isDraft:        row.is_draft ?? false,
    hasEmbedding:   row.embedding != null,    // expose to admin UI; don't return 768 numbers
    embeddingModel: row.embedding_model,
    embeddingAt:    row.embedding_at,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  }
}

// ----- read ---------------------------------------------------------------

export async function list({ isActive, isDraft, category, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT * FROM faqs
      WHERE ($1::bool IS NULL OR is_active = $1)
        AND ($2::bool IS NULL OR is_draft  = $2)
        AND ($3::text IS NULL OR category  = $3)
      ORDER BY sort_order, id
      LIMIT $4`,
    [
      isActive === undefined ? null : isActive,
      isDraft  === undefined ? null : isDraft,
      category ?? null,
      Math.min(limit, 500),
    ],
  )
  return rows.map(rowToFaq)
}

export async function findById(id) {
  const { rows } = await query(`${SELECT_FAQ} WHERE id = $1`, [id])
  return rowToFaq(rows[0])
}

/**
 * Cosine-similarity search over FAQ embeddings.
 * Returns up to `topK` matches with their `similarity` score (1 - distance,
 * normalised so 1.0 = perfect match, 0.0 = orthogonal).
 *
 * Distance from pgvector's `<=>` is in [0, 2] for cosine (1 = opposite,
 * 2 = identical on opposite-side hypersphere, 0 = identical unit vectors).
 * For normalised vectors (which our embeddings are after RETRIEVAL_DOCUMENT
 * taskType), distance == 1 - cos_sim, so similarity = 1 - distance.
 *
 * The bot MUST NEVER see drafts — `is_draft = FALSE` is added to the WHERE
 * clause as a safety net (the admin UI should also keep drafts unpublished).
 */
export async function vectorSearch(queryEmbedding, { topK = 3, minSimilarity = 0 } = {}) {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length !== 768) return []
  const vecLiteral = `[${queryEmbedding.join(',')}]`
  const { rows } = await query(
    `SELECT id, question, answer, answer_blocks, category,
            (embedding <=> $1::vector) AS distance,
            1 - (embedding <=> $1::vector) AS similarity
       FROM faqs
      WHERE is_active = TRUE
        AND is_draft  = FALSE
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [vecLiteral, topK],
  )
  return rows
    .map((r) => ({
      id:           r.id,
      question:     r.question,
      answer:       r.answer,
      answerBlocks: r.answer_blocks ?? [],
      category:     r.category,
      similarity:   Number(r.similarity),
    }))
    .filter((r) => r.similarity >= minSimilarity)
}

/** Return just the questions/answers for the top-K, for LLM rephrase. */
export async function findActiveQAPairsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const { rows } = await query(
    `SELECT id, question, answer, answer_blocks, category
       FROM faqs WHERE id = ANY($1::int[])`,
    [ids],
  )
  return rows
}

// ----- write --------------------------------------------------------------

const COL_MAP = {
  question:     'question',
  answer:       'answer',
  category:     'category',
  keywords:     'keywords',
  sortOrder:    'sort_order',
  isActive:     'is_active',
  answerBlocks: 'answer_blocks',
  isDraft:      'is_draft',
}

// Columns whose values need JSON.stringify before going to Postgres — pg
// treats JS arrays as Postgres array literals, which breaks JSONB columns.
const JSONB_COLS = new Set(['answer_blocks'])

function toParam(col, v) {
  if (v === undefined || v === null) return v
  if (JSONB_COLS.has(col)) return JSON.stringify(v)
  return v
}

export async function create(fields) {
  const cols = []
  const vals = []
  const i = { v: 1 }

  for (const [k, v] of Object.entries(fields)) {
    const col = COL_MAP[k]
    if (!col) continue
    cols.push(col); vals.push(toParam(col, v)); i.v++
  }
  if (!cols.length) throw new Error('create: no fields')

  const { rows } = await query(
    `INSERT INTO faqs (${cols.join(', ')}) VALUES (${cols.map((_, idx) => `$${idx + 1}`).join(', ')})
     RETURNING id`,
    vals,
  )
  return findById(rows[0].id)
}

export async function update(id, fields, { embedding } = {}) {
  const setParts = []
  const vals = []
  let i = 1
  for (const [k, v] of Object.entries(fields)) {
    // Only update fields that were explicitly provided (not undefined).
    if (v === undefined) continue
    const col = COL_MAP[k]
    if (!col) continue
    setParts.push(`${col} = $${i++}`); vals.push(toParam(col, v))
  }
  // Embedding update path — separated because it's a vector literal.
  if (embedding) {
    setParts.push(`embedding = $${i++}::vector`); vals.push(`[${embedding.join(',')}]`)
    setParts.push(`embedding_at = NOW()`)
  }
  if (!setParts.length) return findById(id)
  vals.push(id)
  const { rowCount } = await query(
    `UPDATE faqs SET ${setParts.join(', ')} WHERE id = $${i}`,
    vals,
  )
  if (rowCount === 0) return null
  return findById(id)
}

export async function setEmbedding(id, embedding, model) {
  if (!Array.isArray(embedding) || embedding.length !== 768) {
    throw new Error('embedding must be 768-dim')
  }
  await query(
    `UPDATE faqs
        SET embedding = $1::vector,
            embedding_model = COALESCE($2, embedding_model),
            embedding_at = NOW()
      WHERE id = $3`,
    [`[${embedding.join(',')}]`, model ?? null, id],
  )
  return findById(id)
}

export async function remove(id) {
  const { rowCount } = await query('DELETE FROM faqs WHERE id = $1', [id])
  return rowCount > 0
}