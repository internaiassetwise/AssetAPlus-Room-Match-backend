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
    beds: row.bedrooms,
    baths: row.bathrooms,
    sqm: row.size_sqm == null ? null : Number(row.size_sqm),
    price: row.monthly_rent,
    status: row.status,
    availableFrom: row.available_from,
    zone: row.zone_name_th,
    zoneId: row.zone_id,
    image: row.image_url,
    amenities,
    isFeatured: row.is_featured === true,
    badge: row.is_featured
      ? 'ยอดนิยม'
      : row.status === 'available'
        ? 'พร้อมเข้าอยู่'
        : 'กำลังจะว่าง',
    badgeTone: row.is_featured ? 'ember' : 'green',
  }
}