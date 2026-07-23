-- 015_room_details.sql — Room detail fields from user feedback.
--
-- Adds: project_name, room_code, building, floor, view_type, room_type
-- These let the form capture granular room info without overloading `title`.

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS project_name TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_code   TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS building     TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor        INTEGER;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS view_type    TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_type    TEXT;
