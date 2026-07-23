-- 016_landlord_nullable.sql — Allow rooms without a landlord (AssetWise-owned).
ALTER TABLE rooms ALTER COLUMN landlord_id DROP NOT NULL;
