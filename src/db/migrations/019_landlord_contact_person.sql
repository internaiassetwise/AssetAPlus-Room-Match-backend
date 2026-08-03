-- Migration 019: who to actually call about a landlord's room.
--
-- The owner on the title deed is often not the person who answers the phone:
-- an adult child registers on a parent's behalf, a spouse handles the viewing,
-- an agent fronts for the owner. Admin was recording that in `note` as free
-- text, where it can't be searched, dialled, or shown next to the room.
--
-- All three columns are nullable — blank means the owner is their own contact,
-- which stays the common case and needs no data migration.

ALTER TABLE landlords ADD COLUMN IF NOT EXISTS contact_name     TEXT;
ALTER TABLE landlords ADD COLUMN IF NOT EXISTS contact_phone    TEXT;
-- 'self' | 'child' | 'spouse' | 'relative' | 'agent' | 'other'.
-- Kept as free text rather than an enum: the list is a UI affordance, and a new
-- relationship should not need a migration to record.
ALTER TABLE landlords ADD COLUMN IF NOT EXISTS contact_relation TEXT;

-- Admin looks people up by whichever number they have in hand — which may be
-- the contact's, not the owner's.
CREATE INDEX IF NOT EXISTS idx_landlords_contact_phone
  ON landlords (contact_phone) WHERE contact_phone IS NOT NULL;
