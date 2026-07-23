// src/db/repositories/_rowToRoom.js — Shared room mapper (Postgres rows → API contract).
//
// Postgres returns amenities as a JSONB array (already parsed), not a string.
export function rowToRoom(row) {
  if (!row) return null
  const amenities = Array.isArray(row.amenities) ? row.amenities : []
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    propertyType: row.property_type,
    roomType: row.room_type ?? null,
    projectName: row.project_name ?? null,
    roomCode: row.room_code ?? null,
    building: row.building ?? null,
    floor: row.floor == null ? null : Number(row.floor),
    viewType: row.view_type ?? null,
    beds: row.bedrooms,
    baths: row.bathrooms,
    sqm: row.size_sqm == null ? null : Number(row.size_sqm),
    price: row.monthly_rent,
    status: row.status,
    availableFrom: row.available_from,
    address: row.address ?? null,
    zone: row.zone_name_th,
    zoneId: row.zone_id,
    image: row.image_url,
    amenities,
    isFeatured: row.is_featured === true,
    createdByLineUserId: row.created_by_line_user_id ?? null,
    approvedAt: row.approved_at ?? null,
    approvedBy: row.approved_by ?? null,
    badge: row.is_featured
      ? 'ยอดนิยม'
      : row.status === 'available'
        ? 'พร้อมเข้าอยู่'
        : 'กำลังจะว่าง',
    badgeTone: row.is_featured ? 'ember' : 'green',
  }
}