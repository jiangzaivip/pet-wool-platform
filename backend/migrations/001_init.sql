CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  base_price_cents INTEGER NOT NULL CHECK (base_price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  deposit_percent INTEGER NOT NULL DEFAULT 50 CHECK (deposit_percent BETWEEN 0 AND 100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_translations (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lang TEXT NOT NULL CHECK (lang IN ('zh', 'en', 'ko')),
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  specs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (product_id, lang)
);

CREATE TABLE IF NOT EXISTS faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS faq_translations (
  faq_id UUID NOT NULL REFERENCES faqs(id) ON DELETE CASCADE,
  lang TEXT NOT NULL CHECK (lang IN ('zh', 'en', 'ko')),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  PRIMARY KEY (faq_id, lang)
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no TEXT NOT NULL UNIQUE,
  product_id UUID REFERENCES products(id),
  lang TEXT NOT NULL DEFAULT 'zh',
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  pet_name TEXT NOT NULL DEFAULT '',
  pet_type TEXT NOT NULL DEFAULT '',
  size_option TEXT NOT NULL DEFAULT '',
  payment_type TEXT NOT NULL CHECK (payment_type IN ('deposit', 'balance', 'full')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT NOT NULL DEFAULT '',
  photo_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'crafting', 'preview', 'balance_due', 'shipped', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO admins (email, password_hash)
VALUES ('admin@example.com', 'ac0e7d037817094e9e0b4441f9bae3209d67b02fa484917065f71b16109a1a78')
ON CONFLICT (email) DO NOTHING;

WITH p AS (
  INSERT INTO products (slug, base_price_cents, currency, deposit_percent, sort_order, image_url)
  VALUES
    ('full-body-pet-replica', 65000, 'USD', 50, 1, '/assets/product-full-body.svg'),
    ('mini-pet-portrait', 24800, 'USD', 50, 2, '/assets/product-frame.svg'),
    ('felted-photo-frame', 9450, 'USD', 50, 3, '/assets/product-frame.svg'),
    ('pet-memorial-ornament', 9900, 'USD', 50, 4, '/assets/product-memorial.svg')
  ON CONFLICT (slug) DO NOTHING
  RETURNING id, slug
)
INSERT INTO product_translations (product_id, lang, title, subtitle, description, specs)
SELECT id, 'zh',
  CASE slug
    WHEN 'full-body-pet-replica' THEN '全身羊毛毡宠物定制'
    WHEN 'mini-pet-portrait' THEN '迷你宠物肖像'
    WHEN 'felted-photo-frame' THEN '羊毛毡相框肖像'
    ELSE '宠物纪念挂件'
  END,
  CASE slug
    WHEN 'full-body-pet-replica' THEN '根据照片还原宠物体态、毛色与神情'
    WHEN 'mini-pet-portrait' THEN '小尺寸、高还原度，适合礼物与收藏'
    WHEN 'felted-photo-frame' THEN '把宠物头像做进温暖相框里'
    ELSE '适合钥匙扣、包挂、纪念礼物'
  END,
  '上传宠物照片后，工匠会先确认细节，再开始制作。支持预览确认、局部修改和定金/尾款模式。',
  '["手工针戳羊毛毡", "支持猫狗及其他宠物", "制作周期约 4-8 周"]'::jsonb
FROM p
ON CONFLICT (product_id, lang) DO NOTHING;

INSERT INTO product_translations (product_id, lang, title, subtitle, description, specs)
SELECT id, 'en',
  CASE slug
    WHEN 'full-body-pet-replica' THEN 'Full Body Felted Pet Replica'
    WHEN 'mini-pet-portrait' THEN 'Mini Pet Portrait'
    WHEN 'felted-photo-frame' THEN 'Felted Photo Frame Portrait'
    ELSE 'Pet Memorial Ornament'
  END,
  CASE slug
    WHEN 'full-body-pet-replica' THEN 'A handmade wool sculpture based on your pet photos'
    WHEN 'mini-pet-portrait' THEN 'Small, detailed and gift-ready'
    WHEN 'felted-photo-frame' THEN 'A warm framed portrait made with wool'
    ELSE 'A keepsake for keys, bags or memorial gifts'
  END,
  'Upload pet photos, confirm details with our team, preview the artwork and complete the order with deposit or full payment.',
  '["Needle-felted by hand", "Cats, dogs and other pets", "Typical lead time: 4-8 weeks"]'::jsonb
FROM products
ON CONFLICT (product_id, lang) DO NOTHING;

INSERT INTO product_translations (product_id, lang, title, subtitle, description, specs)
SELECT id, 'ko',
  CASE slug
    WHEN 'full-body-pet-replica' THEN '전신 양모 펠트 반려동물 인형'
    WHEN 'mini-pet-portrait' THEN '미니 반려동물 초상'
    WHEN 'felted-photo-frame' THEN '양모 펠트 액자 초상'
    ELSE '반려동물 추모 오너먼트'
  END,
  CASE slug
    WHEN 'full-body-pet-replica' THEN '사진을 바탕으로 반려동물의 표정과 털색을 표현합니다'
    WHEN 'mini-pet-portrait' THEN '작지만 섬세한 맞춤 선물'
    WHEN 'felted-photo-frame' THEN '따뜻한 액자형 양모 초상'
    ELSE '키링, 가방 장식, 추모 선물에 적합합니다'
  END,
  '사진을 업로드하면 세부 사항을 확인한 뒤 제작을 시작합니다. 미리보기 확인, 부분 수정, 계약금/잔금 결제를 지원합니다.',
  '["수작업 니들 펠팅", "고양이, 강아지 및 기타 반려동물", "제작 기간 약 4-8주"]'::jsonb
FROM products
ON CONFLICT (product_id, lang) DO NOTHING;

WITH f AS (
  INSERT INTO faqs (sort_order)
  VALUES (1), (2), (3), (4)
  ON CONFLICT DO NOTHING
  RETURNING id, sort_order
)
INSERT INTO faq_translations (faq_id, lang, question, answer)
SELECT id, 'zh',
  CASE sort_order
    WHEN 1 THEN '制作和发货需要多久？'
    WHEN 2 THEN '需要提供哪些照片？'
    WHEN 3 THEN '可以使用宠物毛发或骨灰吗？'
    ELSE '下单后还能修改吗？'
  END,
  CASE sort_order
    WHEN 1 THEN '通常制作周期为 4-8 周，复杂造型或节假日可能延长。'
    WHEN 2 THEN '建议提供正面、侧面、背面、毛色细节和有代表性的表情照片。'
    WHEN 3 THEN '可以，建议先与客服确认寄送方式和制作记录要求。'
    ELSE '开始制作前可调整主要信息；制作中支持小范围细节修改。'
  END
FROM f
ON CONFLICT (faq_id, lang) DO NOTHING;

INSERT INTO faq_translations (faq_id, lang, question, answer)
SELECT id, 'en',
  CASE sort_order
    WHEN 1 THEN 'How long does production and shipping take?'
    WHEN 2 THEN 'What photos should I provide?'
    WHEN 3 THEN 'Can you include pet hair or ashes?'
    ELSE 'Can I request changes after ordering?'
  END,
  CASE sort_order
    WHEN 1 THEN 'Typical production takes 4-8 weeks. Complex designs or peak seasons may require extra time.'
    WHEN 2 THEN 'Front, side, back, coat details and expressive photos are recommended.'
    WHEN 3 THEN 'Yes. Please confirm shipping instructions and documentation requirements with support first.'
    ELSE 'Major details can be adjusted before crafting starts. Minor refinements are supported during production.'
  END
FROM faqs
ON CONFLICT (faq_id, lang) DO NOTHING;

INSERT INTO faq_translations (faq_id, lang, question, answer)
SELECT id, 'ko',
  CASE sort_order
    WHEN 1 THEN '제작과 배송은 얼마나 걸리나요?'
    WHEN 2 THEN '어떤 사진이 필요한가요?'
    WHEN 3 THEN '반려동물의 털이나 유골을 넣을 수 있나요?'
    ELSE '주문 후 수정할 수 있나요?'
  END,
  CASE sort_order
    WHEN 1 THEN '일반 제작 기간은 4-8주입니다. 복잡한 디자인이나 성수기에는 더 걸릴 수 있습니다.'
    WHEN 2 THEN '정면, 측면, 뒷모습, 털색 디테일, 특징적인 표정 사진을 권장합니다.'
    WHEN 3 THEN '가능합니다. 먼저 고객지원팀과 발송 방법 및 기록 요청 사항을 확인해 주세요.'
    ELSE '제작 전에는 주요 정보를 수정할 수 있고, 제작 중에는 작은 디테일 수정이 가능합니다.'
  END
FROM faqs
ON CONFLICT (faq_id, lang) DO NOTHING;

INSERT INTO site_settings (key, value)
VALUES
  ('brand', '{"name":"WoolBuddy","email":"","instagram":""}'::jsonb),
  ('theme', '{"defaultTheme":"cream","enabledThemes":["cream","sage","rose","dark"]}'::jsonb),
  ('order', '{"currency":"USD","depositPercent":50,"leadTimeWeeks":"4-8"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
