// src/services/faqBlocks.service.js — Render a FAQ's `answer_blocks` array
// into a Thai string for the bot to reply with, OR into a denormalised plain
// text for the `answer` cache column.
//
// Block types (mirrors the zod schema in routes/faqs.js):
//   text   — plain Thai copy
//   count  — COUNT(*) over a filtered subset of an allow-listed table
//   stat   — {COUNT|AVG|MIN|MAX}(col) over a filtered subset
//   single — fetch one column from the row keyed by ctx.{roomId,viewingId,tenantId}
//   list   — up to 5 rows, formatted with itemTemplate (auto-numbered 1) 2) …)
//   link   — a labelled URL on its own line
//
// Format mini-spec:
//   {{n}}            — raw numeric value (Count result)
//   {{v}}            — raw value (Stat/Single/List row)
//   {{v:0,000}}      — Thai thousands-separated integer
//   {{v:0.00}}       — 2-decimal number
//   {{v:date}}       — ISO date formatted in Thai (DD MMM BBBB)
//   {{row.<col>}}    — column value inside itemTemplate of a List block
// Unknown placeholders are left visible so typos show up in preview.

import { runSafe } from './safeQuery.service.js'
import { logger } from '../logger.js'

const DEFAULT_SAMPLE_CONTEXT = { roomId: 1, viewingId: 1, tenantLineId: 'U-demo' }

/**
 * Render one FAQ's blocks into a Thai string for the bot reply.
 *
 * @param {{answer_blocks?: any[], answer?: string}} faq
 * @param {{roomId?: number, viewingId?: number, tenantLineId?: string}} [ctx]
 * @returns {Promise<string>}  rendered text. If `answer_blocks` is empty
 *                              or missing, returns `faq.answer` verbatim.
 */
export async function renderAnswerBlocks(faq, ctx = {}) {
  const blocks = Array.isArray(faq?.answer_blocks) ? faq.answer_blocks : []
  if (blocks.length === 0) {
    return faq?.answer ?? ''
  }
  const c = { ...DEFAULT_SAMPLE_CONTEXT, ...ctx }

  const fragments = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    try {
      const frag = await renderBlock(block, c)
      if (frag) fragments.push(frag)
    } catch (err) {
      // Total renderer — return a Thai error fragment so the chat doesn't blow up.
      logger.error({ err, blockIndex: i, blockType: block?.type },
        'renderAnswerBlocks: block failed')
      fragments.push('(ไม่สามารถแสดงผลบล็อกนี้ได้)')
    }
  }
  return fragments.join('\n\n')
}

/**
 * Render every block to plain Thai text for the `answer` cache column.
 * Used on every write so the vector embedding stays stable.
 */
export async function renderAnswerCache(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return ''
  return renderAnswerBlocks({ answer_blocks: blocks }, {})
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function renderBlock(block, ctx) {
  switch (block?.type) {
    case 'text':   return renderText(block)
    case 'count':  return renderCount(block)
    case 'stat':   return renderStat(block)
    case 'single': return renderSingle(block, ctx)
    case 'list':   return renderList(block)
    case 'link':   return renderLink(block)
    default:       return ''
  }
}

// ---------------------------------------------------------------------------
// Per-type renderers
// ---------------------------------------------------------------------------

function renderText(block) {
  if (typeof block?.text !== 'string') return ''
  return block.text.trim()
}

async function renderCount(block) {
  if (!block || typeof block !== 'object') return '(บล็อกไม่ถูกต้อง)'
  const rows = await runSafe({
    table:      block.table,
    aggregate:  { fn: 'COUNT', col: '*' },
    conditions: Array.isArray(block.conditions) ? block.conditions : [],
  })
  const n = Number(rows[0]?.value ?? 0)
  return applyFormat(block.format || '{{n}}', n, 'count')
}

async function renderStat(block) {
  if (!block?.aggregate) return '(บล็อกไม่ถูกต้อง)'
  const rows = await runSafe({
    table:      block.table,
    aggregate:  { fn: block.aggregate.fn, col: block.aggregate.col },
    conditions: Array.isArray(block.conditions) ? block.conditions : [],
  })
  const v = rows[0]?.value
  return applyFormat(block.format || '{{v:0,000}}', v, 'stat')
}

async function renderSingle(block, ctx) {
  if (!block?.table || !block?.column) return '(บล็อกไม่ถูกต้อง)'
  const id = block.rowKey === 'roomId'     ? ctx.roomId
           : block.rowKey === 'viewingId'   ? ctx.viewingId
           : block.rowKey === 'tenantId'    ? ctx.tenantLineId   // best-effort
           : null
  if (!id) return '—'

  const condCol = block.rowKey === 'tenantId' ? 'line_id' : 'id'
  const rows = await runSafe({
    table:     block.table,
    columns:   [block.column],
    conditions: [{ col: condCol, op: '=', value: id }],
    limit:     1,
  })
  const v = rows[0]?.[block.column]
  return applyFormat(block.format || '{{v}}', v, 'stat')
}

async function renderList(block) {
  if (!block?.table || !block?.itemTemplate) return '(บล็อกไม่ถูกต้อง)'
  const columns = Array.isArray(block.columns) && block.columns.length
    ? block.columns
    : null
  const rows = await runSafe({
    table:      block.table,
    columns:    columns ?? undefined,
    conditions: Array.isArray(block.conditions) ? block.conditions : [],
    orderBy:    block.orderBy,
    limit:      block.limit ?? 5,
  })
  if (rows.length === 0) return ''
  return rows
    .map((row, i) => {
      const body = applyListItemTemplate(block.itemTemplate, row)
      return `${i + 1}) ${body}`
    })
    .join('\n')
}

function renderLink(block) {
  if (!block?.label || !block?.url) return ''
  return `${block.label}: ${block.url}`
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Apply a format string to a single value.
 * @param {string} fmt
 * @param {*}      v
 * @param {'count'|'stat'} kind — {{n}} is for Count only; {{v…}} for everything else.
 */
function applyFormat(fmt, v, kind) {
  if (typeof fmt !== 'string' || fmt.length === 0) return String(v ?? '')
  return fmt.replace(/\{\{\s*(n|v)(?::([^}]*))?\s*\}\}/g, (_, key, spec) => {
    if (key === 'n' && kind !== 'count') return '{{n}}'
    if (key === 'v' && kind === 'count') return '{{v}}'
    return formatValue(v, spec)
  })
}

function applyListItemTemplate(template, row) {
  return template.replace(/\{\{\s*row\.([\w]+)(?::([^}]*))?\s*\}\}/g, (_, col, spec) => {
    return formatValue(row?.[col], spec)
  })
}

function formatValue(v, spec) {
  if (v === null || v === undefined) return '—'
  if (spec === 'date') return formatDate(v)
  if (spec === '0,000') return formatThousands(v)
  if (spec === '0.00')  return formatDecimal(v, 2)
  // no spec
  return String(v)
}

function formatThousands(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return n.toLocaleString('en-US')
}

function formatDecimal(v, digits) {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return n.toFixed(digits)
}

function formatDate(v) {
  try {
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return String(v)
    const fmt = new Intl.DateTimeFormat('th-TH', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
    return fmt.format(d)
  } catch {
    return String(v)
  }
}