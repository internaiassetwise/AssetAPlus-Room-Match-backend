-- ============================================================
-- Seed data for development / demo (PostgreSQL)
-- Idempotent: uses ON CONFLICT DO NOTHING
-- ============================================================

-- ---------- ZONES ----------
INSERT INTO zones (slug, name_th, name_en, sort_order) VALUES
  ('asoke',    'อโศก',     'Asoke',       10),
  ('phrom',    'พร้อมพงษ์', 'Phrom Phong', 20),
  ('thon',     'ทองหล่อ',   'Thonglor',    30),
  ('ekkamai',  'เอกมัย',    'Ekkamai',     40),
  ('ari',      'อารีย์',    'Ari',         50),
  ('latphrao', 'ลาดพร้าว',  'Lat Phrao',   60),
  ('ratchada', 'รัชดา',     'Ratchada',    70),
  ('bangna',   'บางนา',     'Bang Na',     80),
  ('sathorn',  'สาทร',      'Sathorn',     90),
  ('silom',    'สีลม',      'Silom',      100)
ON CONFLICT (slug) DO NOTHING;

-- ---------- LANDLORDS ----------
INSERT INTO landlords (id, full_name, phone, email, line_id, company_name, note, source)
  OVERRIDING SYSTEM VALUE
VALUES
  (1, 'คุณพลอย สุขสมบูรณ์',  '0891234567', 'ploy@example.com',  'ploy.asset',  NULL, 'เจ้าของคอนโดทองหล่อ 2 ห้อง', 'referral'),
  (2, 'คุณเจมส์ วงศ์ไพศาล', '0812345678', 'james@example.com', 'james.asset', 'JW Holdings', 'นักลงทุนเช่า 5 ห้อง', 'website'),
  (3, 'คุณมิ้น ศรีสวัสดิ์',   '0823456789', 'min@example.com',   'min.asset',   NULL, 'เจ้าของห้องอโศก', 'website')
ON CONFLICT (id) DO NOTHING;

-- Align the identity sequence after explicit inserts
SELECT setval(pg_get_serial_sequence('landlords','id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM landlords), 1));

-- ---------- ROOMS ----------
-- Asoke (zone 1)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (1, 1, 'Aspire อโศก-พร้อมพงษ์', 'ห้องสวย เฟอร์ครบ ใกล้ BTS อโศก 350 ม.', 'condo', 1, 1, 25.5, 15500, 'available', '2026-07-15', '["pool","gym","near-bts","laundry"]'::jsonb, TRUE),
  (1, 1, 'Sukhumvit Suite อโศก',   'วิวเมือง เดินทางสะดวก',                  'condo', 2, 1, 45.0, 28000, 'available', '2026-08-01', '["pool","gym","co-working"]'::jsonb,         FALSE),
  (3, 1, 'The Seed Musee อโศก',    'ห้องใหม่ ไม่เคยอยู่อาศัย',                'condo', 1, 1, 22.0, 12500, 'available', '2026-07-20', '["pool","laundry","security-24h"]'::jsonb,   FALSE);

-- Phrom Phong (zone 2)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (2, 2, 'Ideo Q พร้อมพงษ์',       'ห้องน่าอยู่ ตกแต่งสไตล์โมเดิร์น',        'condo', 1, 1, 28.0, 18500, 'available', '2026-07-10', '["pool","gym","near-bts","co-working"]'::jsonb, TRUE),
  (2, 2, 'The Lumpini 24',          'ห้องสวย วิวสวน ครัวแยก',                 'condo', 1, 1, 32.0, 21000, 'reserved',  '2026-07-25', '["pool","gym","garden","security-24h"]'::jsonb, FALSE),
  (1, 2, 'Siri Residence พร้อมพงษ์', 'ห้องใหญ่ เหมาะครอบครัว',                'condo', 2, 2, 58.0, 35000, 'available', '2026-08-10', '["pool","gym","parking","playground"]'::jsonb, FALSE);

-- Thonglor (zone 3)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (1, 3, 'The Line ทองหล่อ',        'ไฮเอนด์ ครบครัน',                       'condo', 1, 1, 35.0, 27000, 'available', '2026-08-05', '["pool","gym","concierge","parking"]'::jsonb, TRUE),
  (2, 3, 'Noble Remix ทองหล่อ',     'ใกล้ร้านอาหาร คาเฟ่',                     'condo', 2, 2, 65.0, 45000, 'available', '2026-09-01', '["pool","gym","rooftop"]'::jsonb,           FALSE);

-- Sathorn (zone 9)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (2, 9, 'The Line สาทร',          'วิวแม่น้ำ ครบครัน หรูหรา',                'condo', 1, 1, 32.0, 22000, 'available', '2026-07-30', '["pool","gym","river-view","parking"]'::jsonb, TRUE),
  (3, 9, 'Sathorn Park',            'ห้องเงียบสงบ เหมาะทำงาน',                  'condo', 2, 2, 60.0, 38000, 'available', '2026-08-15', '["pool","gym","park"]'::jsonb,                  FALSE);

-- Silom (zone 10)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (2, 10, 'Nantana สีลม',           'ใกล้ BTS ศาลาแดง',                         'condo', 1, 1, 30.0, 16000, 'available', '2026-08-01', '["pool","near-bts","security-24h"]'::jsonb,     FALSE);

-- Ekkamai (zone 4)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (1, 4, 'Beatniq เอกมัย',         'ห้องดีไซน์ ครบเฟอร์',                       'condo', 1, 1, 27.0, 19500, 'available', '2026-07-20', '["pool","gym","co-working"]'::jsonb,            FALSE);

-- Ratchada (zone 7)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (3, 7, 'Centric รัชดา',          'ใกล้ MRT ห้วยขวาง',                         'condo', 1, 1, 26.0, 13500, 'available', '2026-08-01', '["pool","near-mrt","laundry"]'::jsonb,          FALSE);

-- Bang Na (zone 8)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (2, 8, 'B-Hive บางนา',           'ทางด่วนเข้าเมืองสะดวก',                     'condo', 2, 1, 40.0, 18000, 'available', '2026-07-25', '["pool","parking","security-24h"]'::jsonb,      FALSE);

-- Lat Phrao (zone 6)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (3, 6, 'Lumpini Place ลาดพร้าว', 'ห้องใหม่ ไม่เคยอยู่',                       'condo', 1, 1, 24.0, 11000, 'available', '2026-08-10', '["laundry","security-24h","near-mrt"]'::jsonb, FALSE);

-- Ari (zone 5)
INSERT INTO rooms (landlord_id, zone_id, title, description, property_type, bedrooms, bathrooms, size_sqm, monthly_rent, status, available_from, amenities, is_featured) VALUES
  (1, 5, 'La Vie Ari',              'คาเฟ่และร้านอร่อยรอบห้อง',                   'condo', 1, 1, 30.0, 17500, 'available', '2026-08-05', '["near-bts","co-working","laundry"]'::jsonb,    FALSE);

-- ---------- ROOM IMAGES ----------
INSERT INTO room_images (room_id, url, alt_text, sort_order) VALUES
  (1, '/images/room-navy.jpg',    'ห้องนอน',    1),
  (1, '/images/room-cloud.jpg',   'ห้องนั่งเล่น', 2),
  (4, '/images/room-studio.jpg',  'ห้องสตูดิโอ', 1),
  (4, '/images/room-modern.jpg',  'ห้องครัว',     2),
  (7, '/images/room-modern.jpg',  'The Line ทองหล่อ', 1),
  (9, '/images/room-navy-2.jpg',  'The Line สาทร', 1),
  (9, '/images/hero-pool.jpg',    'วิวสระ',      2);

-- ---------- TENANTS ----------
INSERT INTO tenants (full_name, phone, email, occupation, monthly_income, move_in_date, has_pets, smoker, source) VALUES
  ('คุณนนท์ ใจดี',  '0851112222', 'non@example.com',  'professional',  45000, '2026-08-01', FALSE, FALSE, 'website'),
  ('คุณแนน มั่นคง', '0853334444', 'nan@example.com',  'professional',  60000, '2026-07-15', TRUE,  FALSE, 'referral'),
  ('คุณบอส กล้าหาญ','0855556666', 'boss@example.com', 'business_owner',120000,'2026-09-01', FALSE, FALSE, 'line');

-- ---------- PREFERENCES ----------
INSERT INTO preferences (tenant_id, role, zone_ids, property_types, min_bedrooms, max_bedrooms, min_rent, max_rent, min_size_sqm, note) VALUES
  (1, 'tenant', 'asoke,phrom',    'condo', 1, 1, 12000, 20000, 22, 'อยากใกล้ BTS'),
  (2, 'tenant', 'phrom,thon',     'condo', 1, 2, 18000, 35000, 28, 'มีแมว 1 ตัว'),
  (3, 'tenant', 'thon,sathorn',   'condo', 2, 3, 30000, 60000, 45, 'ต้องการที่จอดรถ');

INSERT INTO preferences (landlord_id, role, zone_ids, property_types, min_bedrooms, max_bedrooms, min_rent, max_rent, min_size_sqm, note) VALUES
  (1, 'landlord', 'thon,asoke,phrom',     'condo', 1, 2, 0, 0, 0, 'ห้อง 2 ห้อง'),
  (2, 'landlord', 'asoke,phrom,sathorn',  'condo', 1, 1, 0, 0, 0, 'เช่าระยะยาว 1 ปีขึ้นไป');

-- ---------- MATCHES ----------
INSERT INTO matches (tenant_id, room_id, status, match_score, agent_note) VALUES
  (1, 1, 'suggested',  92.5, 'ตรงทำเล ราคาพอดี'),
  (1, 4, 'suggested',  88.0, 'ตรง preference'),
  (2, 4, 'contacted',  90.5, 'ผู้เช่าติดต่อกลับแล้ว'),
  (2, 7, 'viewing',    85.0, 'นัดชมห้อง 14/07'),
  (3, 7, 'suggested',  80.0, 'รายได้ดี')
ON CONFLICT (tenant_id, room_id) DO NOTHING;

-- ---------- REVIEWS ----------
INSERT INTO reviews (reviewer_name, reviewer_role, avatar_emoji, rating, body, is_featured) VALUES
  ('คุณพลอย', 'เจ้าของคอนโด ทองหล่อ',  '👩🏻‍💼', 5, 'ฝากห้องไว้ 2 เดือน ได้ผู้เช่าเข้าทันที ดูแลดีมากค่ะ มีรายงานทุกเดือน', TRUE),
  ('คุณเจมส์', 'นักลงทุน เช่าหลายห้อง', '🧑🏻‍💼', 5, 'จากห้องว่าง 3 ห้อง ตอนนี้เต็มหมดใน 45 วัน ลดความยุ่งยากไปเยอะเลย', TRUE),
  ('คุณมิ้น',  'เจ้าของห้อง อโศก',      '👩🏻',   5, 'ประทับใจทีมงานมาก ใส่ใจทุกรายละเอียด ผู้เช่าก็คัดมาให้ดี', TRUE),
  ('คุณต้น',  'เจ้าของห้อง รัชดา',      '🧑🏻',   5, 'ลูกค้าต่างชาติที่หาให้ ดูแลดี ไม่มีปัญหาเลย',                   FALSE);

-- ---------- CONTACT MESSAGES (sample) ----------
INSERT INTO contact_messages (name, phone, email, message, source_page, status) VALUES
  ('คุณเอ', '0890001111', 'a@example.com', 'มีห้องให้เช่า 2 ห้อง แถวอโศก', 'home', 'new'),
  ('คุณบี', '0890002222', 'b@example.com', 'สนใจเป็นผู้เช่า',                'home', 'new');