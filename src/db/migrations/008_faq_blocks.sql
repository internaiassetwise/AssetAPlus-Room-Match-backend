-- 008_faq_blocks.sql
-- Block-based answer editor. Existing `answer TEXT` stays as a denormalised
-- plain-text cache so (a) embeddings keep working without re-rendering every
-- block, (b) the admin list page still shows a one-line preview, and (c) the
-- legacy `vectorSearch()` SELECT keeps `answer` in its result set unchanged.
--
-- Lifecycle of the two booleans:
--   is_draft=TRUE,  is_active=FALSE  → "บันทึกแบบร่าง" (bot MUST NOT see it)
--   is_draft=FALSE, is_active=TRUE   → "เผยแพร่" (bot sees it)
--   is_draft=FALSE, is_active=FALSE  → soft-off (kept for embedding history;
--                                       admin list can filter)
--   is_draft=TRUE,  is_active=TRUE   → illegal; guard in the route handler.
ALTER TABLE faqs
  ADD COLUMN IF NOT EXISTS answer_blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_draft      BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill existing plain-text FAQs: wrap their answer in one Text block,
-- mark them published (the bot is already answering them).
UPDATE faqs
   SET answer_blocks = jsonb_build_array(
         jsonb_build_object('type', 'text', 'text', answer)
       ),
       is_draft      = FALSE
 WHERE answer_blocks = '[]'::jsonb;

-- Partial index so /api/faqs (admin list) can find drafts cheaply. vectorSearch()
-- already filters is_active=TRUE; the draft filter is enforced in vectorSearch().
CREATE INDEX IF NOT EXISTS idx_faqs_draft
  ON faqs(is_draft) WHERE is_draft = TRUE;
