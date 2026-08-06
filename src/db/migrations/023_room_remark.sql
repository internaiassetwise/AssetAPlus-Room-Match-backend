-- 023_room_remark.sql — internal note per room ("Remark" in the stock sheet).
--
-- ADMIN-ONLY. This is free text typed by staff for staff: owner quirks, access
-- arrangements, why a price moved. It is never shown to tenants, so publicRoom()
-- strips it the same way it strips landlord_id — a room row is read by the public
-- API, the LINE bot and the Gemini agent, and this column must reach none of them.

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS remark text;

COMMENT ON COLUMN rooms.remark IS
  'Internal staff note. Admin-only: must never be returned to public API callers or the bot.';
