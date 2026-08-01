import { readFile, writeFile } from 'node:fs/promises'

const storePath = new URL('../api-node/data/store.json', import.meta.url)
const store = JSON.parse(await readFile(storePath, 'utf8'))

function applyTranslations(item, translations) {
  item.translations ||= {}
  for (const [lang, values] of Object.entries(translations)) {
    item.translations[lang] = { ...(item.translations[lang] || {}), ...values }
  }
  const zh = translations.zh || {}
  for (const field of ['title', 'subtitle', 'description', 'seo_title', 'seo_description', 'alt_text', 'specs']) {
    if (zh[field] != null) item[field] = zh[field]
  }
}

const categoryCopy = {
  '3d-pet-frame-portraits': {
    zh: { title: '3D 羊毛毡相框肖像', description: '用一张照片制作世上独一无二的手工羊毛毡相框肖像，适合生日、纪念和家居展示。', seo_title: '3D 羊毛毡相框肖像 | WoolBuddy', seo_description: '根据宠物照片手工制作 3D 羊毛毡相框肖像。' },
    en: { title: '3D Wool Felt Frame Portraits', description: 'A one-of-a-kind handmade wool felt frame portrait made from a single photo, for birthdays, memorials and home display.', seo_title: '3D Wool Felt Frame Portraits | WoolBuddy', seo_description: 'Handmade 3D wool felt frame portraits made from your pet photos.' },
    ko: { title: '3D 양모펠트 액자 초상', description: '사진 한 장으로 제작하는\n세상에 하나뿐인 수제 양모펠트 액자 초상.\n\n생일 선물,\n메모리얼 기념,\n집 인테리어까지 모두 어울립니다.', seo_title: '3D 양모펠트 액자 초상 | WoolBuddy', seo_description: '반려동물 사진 한 장으로 만드는 맞춤 수제 3D 양모펠트 액자 초상입니다.' }
  },
  '3d-full-body-pet-portraits': {
    zh: { title: '3D 羊毛毡全身肖像', description: '细致还原宠物姿态、体型、表情和毛色的手工全身作品。', seo_title: '3D 羊毛毡全身肖像 | WoolBuddy', seo_description: '根据照片手工定制宠物 3D 羊毛毡全身肖像。' },
    en: { title: '3D Wool Felt Full-Body Portraits', description: 'Handmade full-body works that recreate your pet’s posture, shape, expression and coat.', seo_title: '3D Wool Felt Full-Body Portraits | WoolBuddy', seo_description: 'Custom handmade 3D wool felt full-body pet portraits made from photos.' },
    ko: { title: '3D 양모펠트 전신 초상', description: '반려동물의 자세와 특징, 체형과 털색까지 그대로 담아 제작합니다.', seo_title: '3D 양모펠트 전신 초상 | WoolBuddy', seo_description: '사진을 바탕으로 자세와 특징을 재현하는 맞춤 수제 양모펠트 전신 초상입니다.' }
  },
  'pet-memorial-gifts': {
    zh: { title: '宠物纪念作品', description: '把珍贵回忆长久保存为相框或全身羊毛毡纪念作品。', seo_title: '宠物羊毛毡纪念作品 | WoolBuddy', seo_description: '定制宠物纪念相框和羊毛毡全身纪念作品。' },
    en: { title: 'Pet Memorial Works', description: 'Keep precious memories in a wool felt memorial frame or full-body work.', seo_title: 'Pet Wool Felt Memorial Works | WoolBuddy', seo_description: 'Custom wool felt pet memorial frames and full-body works.' },
    ko: { title: '메모리얼 선물', description: '소중한 추억을 오래 간직할 수 있는 특별한 양모펠트 기념 작품입니다.', seo_title: '반려동물 메모리얼 양모펠트 | WoolBuddy', seo_description: '소중한 반려동물의 추억을 오래 간직하는 맞춤 메모리얼 작품입니다.' }
  },
  'dog-frame-portrait': {
    zh: { title: '狗狗羊毛毡相框', description: '根据狗狗照片制作 3D 羊毛毡头像相框。' },
    en: { title: 'Dog Wool Felt Frame', description: 'A 3D wool felt frame portrait made from your dog’s photos.' },
    ko: { title: '강아지 양모펠트 액자', description: '강아지 사진으로 제작하는 3D 양모펠트 액자 작품입니다.' }
  },
  'cat-frame-portrait': {
    zh: { title: '猫咪羊毛毡相框', description: '还原猫咪眼神、毛色和脸型的相框作品。' },
    en: { title: 'Cat Wool Felt Frame', description: 'A frame work preserving your cat’s eyes, coat and face shape.' },
    ko: { title: '고양이 양모펠트 액자', description: '고양이의 눈빛, 털색과 얼굴형을 담는 액자 작품입니다.' }
  },
  'rabbit-frame-portrait': {
    zh: { title: '兔子羊毛毡相框', description: '适合兔子等小型宠物的相框纪念作品。' },
    en: { title: 'Rabbit Wool Felt Frame', description: 'A framed keepsake for rabbits and other small pets.' },
    ko: { title: '토끼 양모펠트 액자', description: '토끼 등 소형 반려동물을 위한 액자 기념 작품입니다.' }
  },
  'dog-full-body-portrait': {
    zh: { title: '狗狗羊毛毡全身像', description: '还原狗狗坐姿、站姿、毛色和体态比例。' },
    en: { title: 'Dog Full-Body Wool Felt', description: 'Recreates your dog’s seated or standing pose, coat and proportions.' },
    ko: { title: '강아지 양모펠트 전신', description: '강아지의 앉은 자세, 선 자세, 털색과 체형을 재현합니다.' }
  },
  'cat-full-body-portrait': {
    zh: { title: '猫咪羊毛毡全身像', description: '适合还原猫咪坐姿、趴姿和特色花纹。' },
    en: { title: 'Cat Full-Body Wool Felt', description: 'Recreates your cat’s pose and distinctive markings.' },
    ko: { title: '고양이 양모펠트 전신', description: '고양이의 자세와 특징적인 무늬를 재현합니다.' }
  },
  'multi-pet-group-portrait': {
    zh: { title: '多宠物羊毛毡作品', description: '把多只宠物制作成同一组手工纪念作品。' },
    en: { title: 'Multi-Pet Wool Felt', description: 'Combines several pets into one handmade keepsake group.' },
    ko: { title: '다중 반려동물 양모펠트', description: '여러 반려동물을 하나의 수제 기념 작품으로 제작합니다.' }
  },
  'memorial-frame': {
    zh: { title: '宠物纪念相框', description: '把宠物照片制作成适合长期陈列的纪念相框。' },
    en: { title: 'Memorial Frame', description: 'Turns a pet photo into a memorial frame for lasting display.' },
    ko: { title: '메모리얼 액자', description: '반려동물 사진을 오래 전시할 수 있는 메모리얼 액자로 제작합니다.' }
  },
  'memorial-full-body-portrait': {
    zh: { title: '宠物纪念全身作品', description: '以完整形态留住宠物熟悉的身影和姿态。' },
    en: { title: 'Memorial Full-Body Work', description: 'Preserves your pet’s familiar full shape and posture.' },
    ko: { title: '메모리얼 전신 작품', description: '반려동물의 익숙한 모습과 자세를 온전히 간직합니다.' }
  }
}

for (const category of store.categories || []) {
  if (categoryCopy[category.slug]) applyTranslations(category, categoryCopy[category.slug])
  for (const child of category.children || []) {
    if (categoryCopy[child.slug]) applyTranslations(child, categoryCopy[child.slug])
  }
}

const productCopy = {
  'full-body-pet-replica': {
    zh: { title: '3D 宠物全身肖像', subtitle: '从一张照片细致还原宠物的姿态、表情和毛发纹理。', description: '发送照片后，由手作师逐一还原宠物的表情、毛发纹理和独特特征。\n\n我们提供制作前照片确认、发货前成品预览和局部修改服务。', alt_text: 'WoolBuddy 手工 3D 宠物全身羊毛毡肖像', seo_title: '3D 宠物全身羊毛毡肖像 | WoolBuddy', seo_description: '根据照片手工制作 3D 宠物全身羊毛毡肖像，支持定金、预览确认和全球配送。' },
    en: { title: '3D Full-Body Pet Portrait', subtitle: 'A detailed recreation of your pet’s pose, expression and coat from one photo.', description: 'Send your photos and our artisan will recreate your pet’s expression, coat texture and defining features by hand.\n\nPhoto confirmation, a final preview and minor revisions are included.', alt_text: 'WoolBuddy handmade 3D full-body wool felt pet portrait', seo_title: '3D Full-Body Wool Felt Pet Portrait | WoolBuddy', seo_description: 'Handmade 3D full-body wool felt pet portrait with deposit payment, preview approval and worldwide shipping.' },
    ko: { title: '3D 반려동물 전신 초상', subtitle: '사진 한 장으로\n반려동물의 자세와 표정,\n털결까지 정교하게 재현합니다.', description: '사진을 보내주시면\n장인의 수작업으로\n반려동물의 표정과 털결,\n특징까지 하나하나 재현합니다.\n\n제작 전 사진 확인,\n출고 전 미리보기,\n부분 수정 서비스를 제공합니다.', alt_text: 'WoolBuddy 수제 3D 반려동물 전신 양모펠트 초상', seo_title: '3D 반려동물 전신 양모펠트 초상 | WoolBuddy', seo_description: '사진으로 제작하는 맞춤 3D 반려동물 전신 양모펠트 초상. 계약금, 미리보기 확인과 해외 배송을 지원합니다.' }
  },
  'felted-photo-frame': {
    zh: { title: '3D 宠物相框肖像', subtitle: '把珍贵宠物的样子制作成温暖相框作品，长久珍藏。', description: '发送照片后，由手作师逐一还原宠物的表情、毛发纹理和独特特征。\n\n我们提供制作前照片确认、发货前成品预览和局部修改服务。', alt_text: 'WoolBuddy 手工 3D 宠物羊毛毡相框肖像', seo_title: '3D 宠物羊毛毡相框肖像 | WoolBuddy', seo_description: '根据照片手工制作 3D 宠物羊毛毡相框肖像，支持预览确认和全球配送。' },
    en: { title: '3D Pet Frame Portrait', subtitle: 'Keep your beloved pet close in a warm, handmade framed work.', description: 'Send your photos and our artisan will recreate your pet’s expression, coat texture and defining features by hand.\n\nPhoto confirmation, a final preview and minor revisions are included.', alt_text: 'WoolBuddy handmade 3D wool felt pet frame portrait', seo_title: '3D Wool Felt Pet Frame Portrait | WoolBuddy', seo_description: 'Handmade 3D wool felt pet frame portrait with preview approval and worldwide shipping.' },
    ko: { title: '3D 반려동물 액자 초상', subtitle: '소중한 반려동물의 모습을\n따뜻한 액자 작품으로\n오래 간직하세요.', description: '사진을 보내주시면\n장인의 수작업으로\n반려동물의 표정과 털결,\n특징까지 하나하나 재현합니다.\n\n제작 전 사진 확인,\n출고 전 미리보기,\n부분 수정 서비스를 제공합니다.', alt_text: 'WoolBuddy 수제 3D 반려동물 양모펠트 액자 초상', seo_title: '3D 반려동물 양모펠트 액자 초상 | WoolBuddy', seo_description: '사진으로 제작하는 맞춤 3D 반려동물 양모펠트 액자 초상. 미리보기 확인과 해외 배송을 지원합니다.' }
  },
  'pet-memorial-ornament': {
    zh: { title: '3D 宠物纪念作品', subtitle: '小巧却可以长久保存的宠物回忆纪念作品。', description: '发送照片后，由手作师逐一还原宠物的表情、毛发纹理和独特特征。\n\n我们提供制作前照片确认、发货前成品预览和局部修改服务。', alt_text: 'WoolBuddy 手工 3D 宠物羊毛毡纪念作品', seo_title: '3D 宠物羊毛毡纪念作品 | WoolBuddy', seo_description: '根据照片手工制作小型宠物羊毛毡纪念作品，支持预览确认和全球配送。' },
    en: { title: '3D Pet Memorial Keepsake', subtitle: 'A small pet memorial keepsake made to last.', description: 'Send your photos and our artisan will recreate your pet’s expression, coat texture and defining features by hand.\n\nPhoto confirmation, a final preview and minor revisions are included.', alt_text: 'WoolBuddy handmade 3D wool felt pet memorial keepsake', seo_title: '3D Wool Felt Pet Memorial Keepsake | WoolBuddy', seo_description: 'A small handmade wool felt pet memorial keepsake with preview approval and worldwide shipping.' },
    ko: { title: '3D 반려동물 메모리얼 기념품', subtitle: '작지만 오래 간직할 수 있는\n반려동물 추억 기념품입니다.', description: '사진을 보내주시면\n장인의 수작업으로\n반려동물의 표정과 털결,\n특징까지 하나하나 재현합니다.\n\n제작 전 사진 확인,\n출고 전 미리보기,\n부분 수정 서비스를 제공합니다.', alt_text: 'WoolBuddy 수제 3D 반려동물 양모펠트 메모리얼 작품', seo_title: '3D 반려동물 양모펠트 메모리얼 | WoolBuddy', seo_description: '사진으로 제작하는 맞춤 반려동물 양모펠트 메모리얼 기념품. 미리보기와 해외 배송을 지원합니다.' }
  }
}

const standardTags = ['Handmade', '100% Custom', 'Birthday Gift', 'Memorial', 'Handcrafted', 'Wool Felt', 'Pet Portrait', 'Housewarming Gift', 'Keepsake']
const standardUseCases = ['Birthday Gift', 'Anniversary Gift', 'Memorial Gift', 'Christmas Gift', 'Housewarming Gift', 'Parents Gift']
const standardSpecs = {
  zh: ['100% 手工针毡制作', '支持猫、狗及其他宠物', '制作周期约 4-8 周'],
  en: ['100% needle-felted by hand', 'Cats, dogs and other pets', 'Typical production: 4-8 weeks'],
  ko: ['100% 수제 니들펠트', '강아지, 고양이 및 다양한 반려동물', '제작 기간 약 4-8주']
}
const categoryBySlug = new Map((store.categories || []).map(category => [category.slug, category]))
const productCategory = {
  'full-body-pet-replica': ['3d-full-body-pet-portraits', 'dog-full-body-portrait'],
  'felted-photo-frame': ['3d-pet-frame-portraits', 'dog-frame-portrait'],
  'pet-memorial-ornament': ['pet-memorial-gifts', 'memorial-frame']
}
for (const product of store.products || []) {
  if (!productCopy[product.slug]) continue
  applyTranslations(product, productCopy[product.slug])
  product.specs = standardSpecs.zh
  for (const lang of ['zh', 'en', 'ko']) product.translations[lang].specs = standardSpecs[lang]
  product.tags = standardTags
  product.use_cases = standardUseCases
  const [categorySlug, subcategorySlug] = productCategory[product.slug]
  product.category_id = categoryBySlug.get(categorySlug)?.id || product.category_id
  product.subcategory_slug = subcategorySlug
  delete product.category
}

const policyTranslations = {
  zh: {
    care: '• 本作品为 100% 手工羊毛毡作品，仅供装饰和纪念。\n• 请勿作为玩具使用。\n• 避免阳光直射、水、潮湿和强烈碰撞。\n• 建议放在玻璃展示盒或少尘处保存。\n• 表面浮毛可用小剪刀轻轻修整，请勿使用普通梳子或刷子。\n• 触摸作品前请清洁双手，并尽量减少触碰细节部位。',
    shipping: '• 确认最终作品和配送信息后发货。\n• 一般制作周期约 4-8 周。\n• 复杂姿势、多宠物、大型作品或旺季订单可能延长。\n• 发货后通过邮件提供物流单号。\n• 配送时长、关税及进口税按目的地国家政策执行。',
    refund: '1. 制作开始前可取消订单。\n2. 客户确认开始制作后，定制商品不接受无理由退款。\n3. 制作过程中会充分进行照片确认和沟通。\n4. 最终确认完成的作品不属于退款范围。\n5. 如作品与确认要求明显不符，优先提供免费修改或重制。\n6. 手工作品的细微差异属于正常范围。\n7. 因客户提供照片质量导致的差异不构成退款理由。\n8. 运输破损请在收货后 48 小时内附照片联系。\n9. 地址错误或拒收产生的费用由客户承担。\n10. 海外清关延误不构成退款理由。\n11. 发起 PayPal 争议前请先联系客服。\n12. 本政策与 PayPal 买家保护政策共同适用。'
  },
  en: {
    care: '• This is a 100% handmade wool felt work for display and remembrance.\n• Do not use it as a toy.\n• Avoid direct sunlight, water, humidity and impact.\n• Store it in a glass case or low-dust area when possible.\n• Trim loose fibers gently with small scissors; do not use a regular comb or brush.\n• Clean your hands before touching and avoid frequent contact with fine details.',
    shipping: '• We ship after final work and delivery details are approved.\n• Typical production takes about 4-8 weeks.\n• Complex poses, multiple pets, large pieces and peak seasons may take longer.\n• Tracking is provided by email after dispatch.\n• Transit time, customs duties and import taxes follow destination-country rules.',
    refund: '1. Orders may be cancelled before production starts.\n2. Change-of-mind refunds are unavailable after custom production is approved.\n3. We confirm photos and communicate throughout production.\n4. A finally approved work is not refundable.\n5. If the work clearly differs from approved requirements, free revision or remake is prioritized.\n6. Minor handmade variations are normal.\n7. Differences caused by low-quality customer photos are not grounds for refund.\n8. Report shipping damage with photos within 48 hours.\n9. Costs caused by address errors or refusal are the customer’s responsibility.\n10. Customs delays are not grounds for refund.\n11. Contact support before opening a PayPal dispute.\n12. This policy applies together with PayPal Buyer Protection.'
  },
  ko: {
    care: '• 본 작품은 100% 수작업 양모펠트 작품으로 장식 및 기념용입니다.\n• 장난감으로 사용하지 마십시오.\n• 직사광선, 물, 습기 및 강한 충격을 피해주세요.\n• 유리 케이스 또는 먼지가 적은 곳에 보관하는 것을 권장합니다.\n• 표면에 잔털이 생기면 작은 가위로 살짝 정리해 주세요.\n• 일반 빗이나 브러시는 사용하지 마십시오.\n• 먼지는 입으로 살짝 불어내거나 약한 바람의 드라이어를 사용해 제거할 수 있습니다.\n• 작품을 만지기 전에는 손을 깨끗이 씻어주세요.\n• 세부 부위는 자주 만지지 않는 것을 권장합니다.',
    shipping: '• 최종 작품 확인 및 배송 정보를 확인한 후 발송됩니다.\n• 일반 제작 기간은 약 4-8주입니다.\n• 복잡한 자세, 여러 마리, 대형 작품 및 성수기에는 제작 기간이 연장될 수 있습니다.\n• 발송 후 이메일로 운송장 번호를 안내해드립니다.\n• 국가별 통관 및 배송 상황에 따라 배송 기간은 달라질 수 있습니다.\n• 관세 및 수입세는 해당 국가 정책에 따릅니다.',
    refund: '1. 주문 후 제작 시작 전에는 주문 취소가 가능합니다.\n2. 고객 확인 후 제작이 시작되면 맞춤 제작 상품 특성상 단순 변심에 의한 환불은 불가합니다.\n3. 제작 중 고객과 충분한 사진 확인 및 상담을 진행합니다.\n4. 완성 후 최종 확인을 받은 작품은 환불 대상이 아닙니다.\n5. 작품이 주문 내용과 명확하게 다른 경우 무료 수정 또는 재제작을 우선 제공합니다.\n6. 수작업 특성상 미세한 차이는 정상 범위입니다.\n7. 고객이 제공한 사진 품질로 인해 발생하는 차이는 환불 사유가 아닙니다.\n8. 배송 중 파손된 경우 수령 후 48시간 이내 사진과 함께 연락해 주세요.\n9. 배송 완료 후 주소 오류 및 수취 거부로 발생한 비용은 고객 부담입니다.\n10. 해외 통관 지연은 환불 사유가 아닙니다.\n11. PayPal 분쟁 접수 전 반드시 고객센터로 먼저 문의해 주세요.\n12. 본 정책은 PayPal 구매자 보호 정책과 함께 적용됩니다.'
  }
}

store.site.policies = {
  care: policyTranslations.zh.care,
  shipping: policyTranslations.zh.shipping,
  refund: policyTranslations.zh.refund,
  translations: policyTranslations
}

const faqRows = [
  ['production', '制作周期多久？', '一般制作周期为 4-8 周。复杂姿势、多宠物、大型作品或旺季订单可能延长。', 'How long does production take?', 'Typical production takes 4-8 weeks. Complex poses, multiple pets, large works or peak seasons may take longer.', '제작 기간은 얼마나 걸리나요?', '일반적으로 제작 기간은 4-8주입니다. 작품 크기, 자세, 여러 마리 제작 및 주문량에 따라 기간이 연장될 수 있습니다.'],
  ['photos', '需要上传多少张、什么样的照片？', '建议提供正面、侧面、背面、全身、眼睛和毛色细节等 5-10 张清晰照片。', 'How many and what kind of photos should I upload?', 'Please send 5-10 clear front, side, back, full-body, eye and coat-detail photos.', '어떤 사진을 몇 장 보내야 하나요?', '정면, 측면, 뒷모습, 전신, 눈, 털색과 무늬가 잘 보이는 선명한 사진 5-10장을 권장합니다.'],
  ['deposit', '可以只先支付定金吗？', '可以。默认支付 50% 定金开始制作，确认成品照片后支付尾款，也可以选择全款。', 'Can I pay a deposit first?', 'Yes. A 50% deposit starts production and the balance is paid after final photo approval. Full payment is also available.', '계약금만 먼저 결제할 수 있나요?', '네. 기본적으로 50% 계약금으로 제작을 시작하며 전액 결제도 가능합니다. 잔금은 완성 사진 확인 후 결제합니다.'],
  ['paypal', '可以使用 PayPal 吗？', '可以，网站支持安全的 PayPal 国际支付，可追踪订单和付款记录。', 'Can I pay with PayPal?', 'Yes. Secure international PayPal payment is supported with order and payment records.', 'PayPal 결제가 가능한가요?', '네. PayPal을 통한 안전한 국제 결제를 지원하며 주문 진행 상황과 결제 내역을 확인하실 수 있습니다.'],
  ['preview', '发货前可以确认作品吗？', '可以。我们会先发送成品照片，得到确认后再安排发货。', 'Can I review the work before shipping?', 'Yes. We send final photos and ship only after your approval.', '제작 전에 작품을 확인할 수 있나요?', '네. 완성 후 사진을 먼저 보내드리며 고객님의 확인 후 배송을 진행합니다.'],
  ['revision', '制作中可以修改吗？', '可以。制作中会在必要时发送照片，可调整的部分会尽量修改；包含一次免费局部修改。', 'Can I request revisions?', 'Yes. We share progress when needed and include one free minor revision for feasible changes.', '제작 중 수정이 가능한가요?', '가능합니다. 제작 과정에서 필요한 경우 사진을 보내드리며 수정 가능한 부분은 최대한 반영합니다. 무료 부분 수정 1회가 포함됩니다.'],
  ['multiple', '可以制作多只宠物吗？', '可以。请分别提供每只宠物的清晰照片，多宠物作品的时间和价格会单独确认。', 'Can you make multiple pets?', 'Yes. Send clear photos of each pet. Timing and pricing are confirmed separately.', '여러 마리도 제작 가능한가요?', '네. 각 반려동물의 선명한 사진을 보내주세요. 여러 마리 작품은 기간과 가격을 별도로 확인합니다.'],
  ['cats', '猫咪也可以制作吗？', '可以，狗狗、猫咪及多种宠物均可根据照片定制。', 'Can you make cats?', 'Yes. Dogs, cats and many other pets can be custom made from photos.', '고양이도 가능한가요?', '네. 강아지, 고양이 및 다양한 반려동물을 사진으로 맞춤 제작할 수 있습니다.'],
  ['coat', '毛色能如实表现吗？', '会根据不同光线下的清晰照片尽量还原毛色、花纹和质感。', 'Can you match the coat color?', 'We use clear photos in different light to recreate coat color, markings and texture as closely as possible.', '털 색상도 그대로 표현되나요?', '서로 다른 조명에서 촬영한 선명한 사진을 바탕으로 털색, 무늬와 질감을 최대한 재현합니다.'],
  ['gift', '可以礼品包装吗？', '可以在下单备注中提出礼品包装需求，客服会确认可选方案。', 'Is gift wrapping available?', 'Request gift wrapping in your order notes and support will confirm available options.', '선물 포장이 가능한가요?', '주문 메모에 선물 포장을 요청해 주시면 가능한 옵션을 안내합니다.'],
  ['worldwide', '支持海外配送吗？', '支持全球大多数国家和地区，发货后会提供物流单号。', 'Do you ship worldwide?', 'We ship to most countries and provide tracking after dispatch.', '해외 배송이 가능한가요?', '네. 전 세계 대부분 국가로 배송 가능하며 발송 후 운송장 번호를 안내합니다.'],
  ['quality', '照片质量较低也能制作吗？', '可以先发送照片评估。照片越清晰，还原度越高；无法制作时会在收取定金前说明。', 'Can you work from low-quality photos?', 'Send them for review first. Clearer photos produce better results, and we will advise before taking a deposit if they are unsuitable.', '사진 품질이 낮아도 가능한가요?', '먼저 사진을 보내주시면 확인합니다. 사진이 선명할수록 완성도가 높으며 제작이 어려운 경우 계약금 결제 전에 안내합니다.'],
  ['fur', '可以加入宠物真实毛发吗？', '可以提前沟通少量毛发或胡须的使用和寄送方式。', 'Can real pet fur be added?', 'Discuss the use and shipping of a small amount of fur or whiskers before ordering.', '반려동물 털도 사용할 수 있나요?', '원하시는 경우 소량의 반려동물 털 또는 수염 사용과 발송 방법을 미리 상담할 수 있습니다.'],
  ['ashes', '可以加入宠物骨灰吗？', '部分作品可在充分沟通和安全确认后加入少量材料，请下单前联系客服。', 'Can pet ashes be included?', 'A small amount may be included in some works after careful consultation and safety confirmation. Contact us before ordering.', '반려동물 유골을 넣을 수 있나요?', '일부 작품은 충분한 상담과 안전 확인 후 소량을 넣을 수 있습니다. 주문 전에 문의해 주세요.'],
  ['species', '鸟、兔子或爬宠也可以制作吗？', '可以先提交清晰照片评估，兔子、鸟类和部分其他宠物均可定制。', 'Can you make birds, rabbits or reptiles?', 'Send clear photos for review. Rabbits, birds and some other pets can be custom made.', '새, 토끼 또는 파충류도 가능한가요?', '선명한 사진을 보내주시면 확인합니다. 토끼, 새와 일부 다른 반려동물도 맞춤 제작할 수 있습니다.'],
  ['pose', '可以更改作品姿势吗？', '可以参考多张照片组合姿势，但需在开始制作前确认最终方案。', 'Can I change the pose?', 'A pose can be composed from several references, but the final plan must be approved before production.', '자세를 변경할 수 있나요?', '여러 참고 사진을 바탕으로 자세를 구성할 수 있으며 제작 시작 전에 최종안을 확인해야 합니다.'],
  ['damage', '运输中破损怎么办？', '请在收货后 48 小时内提供外包装和作品照片，我们会核实并安排重制或补偿流程。', 'What if the package is damaged?', 'Send photos of the packaging and work within 48 hours. We will review and arrange remake or compensation steps.', '배송 중 파손되면 어떻게 하나요?', '수령 후 48시간 이내 포장과 작품 사진을 보내주시면 확인 후 재제작 또는 보상 절차를 안내합니다.'],
  ['care', '作品如何护理？', '避免水洗、阳光直射和潮湿。建议用展示盒保存，浮尘可用轻柔冷风去除。', 'How should I care for the work?', 'Avoid washing, direct sunlight and humidity. Use a display case and remove dust with a gentle cool airflow.', '작품은 어떻게 관리하나요?', '물세척, 직사광선과 습기를 피해주세요. 케이스 보관을 권장하며 먼지는 약한 찬바람으로 제거할 수 있습니다.'],
  ['privacy', '会公开客户照片和作品吗？', '默认不会。只有获得客户事先同意后，才会用于评价或案例展示。', 'Will you publish customer photos or works?', 'Not by default. We use them in reviews or cases only with prior consent.', '고객 사진을 공개하나요?', '기본적으로 고객 사진과 작품은 공개하지 않습니다. 후기 또는 사례로 사용할 경우 반드시 사전 동의를 받습니다.'],
  ['urgent', '可以加急制作吗？', '加急取决于当前排期和作品难度，请在支付定金前咨询。', 'Can I request a rush order?', 'Rush availability depends on the schedule and complexity. Ask before paying a deposit.', '긴급 주문이 가능한가요?', '현재 일정과 작품 난이도에 따라 달라집니다. 계약금 결제 전에 문의해 주세요.']
]

const faqs = faqRows.map(([id, zhQ, zhA, enQ, enA, koQ, koA], index) => ({
  id: `feedback-v1-${id}`,
  sort_order: index + 1,
  question: zhQ,
  answer: zhA,
  translations: {
    zh: { question: zhQ, answer: zhA },
    en: { question: enQ, answer: enA },
    ko: { question: koQ, answer: koA }
  }
}))
store.site.faq = faqs
store.faqs = faqs
for (const product of store.products || []) {
  if (!productCopy[product.slug]) continue
  product.faqs = [faqs[1], faqs[5]]
}

const reviewCopy = [
  {
    zh: { title: '表情很像我的狗狗。', content: '眼神和细微毛色都表现得很准确，成了很有意义的生日礼物。' },
    en: { title: 'The expression looks just like my dog.', content: 'The eyes and tiny coat details were captured beautifully. It became a meaningful birthday gift.' },
    ko: { title: '우리 강아지 표정과 정말 닮았어요.', content: '눈빛과 작은 털색 디테일까지 잘 담겨 의미 있는 생일 선물이 되었습니다.' }
  },
  {
    zh: { title: '温暖的宠物纪念作品。', content: '制作前仔细确认了照片，成品温柔又有分寸。' },
    en: { title: 'A warm pet memorial work.', content: 'The artist reviewed the photos carefully and the finished portrait felt gentle and respectful.' },
    ko: { title: '따뜻한 반려동물 메모리얼 작품입니다.', content: '사진을 꼼꼼히 확인해 주었고 완성된 초상은 차분하고 따뜻했습니다.' }
  },
  {
    zh: { title: '全身细节非常漂亮。', content: '姿态、尾巴和花纹都做得很细，成品确认流程也让人安心。' },
    en: { title: 'Beautiful full-body details.', content: 'The posture, tail and markings were carefully made. The preview process made me feel confident.' },
    ko: { title: '전신 디테일이 아름다워요.', content: '자세, 꼬리와 무늬가 세심했고 완성 확인 과정도 안심됐습니다.' }
  }
]
for (const [index, review] of (store.site.reviews || []).entries()) {
  const copy = reviewCopy[index]
  if (!copy) continue
  review.translations = copy
  review.title = copy.en.title
  review.content = copy.en.content
}

store.site.brand.name = 'WoolBuddy'
if (String(store.site.brand.email || '').endsWith('@example.com')) store.site.brand.email = ''
store.site.contact.talk_label = 'KakaoTalk'
if (String(store.site.contact.talk_url || '').includes('example.com')) {
  store.site.contact.talk_enabled = false
  store.site.contact.talk_url = ''
}
store.site.taxonomies = {
  occasions: ['Birthday Gift', 'Anniversary Gift', 'Memorial Gift', 'Christmas Gift', 'Housewarming Gift', 'Parents Gift'],
  styles: []
}
if (store.site.bot?.welcome) {
  store.site.bot.welcome.zh = '你好，我是 WoolBuddy 客服助手。你可以咨询价格、照片、制作周期、配送、退款和护理。'
  store.site.bot.welcome.en = 'Hi, I am the WoolBuddy assistant. Ask about pricing, photos, production, shipping, refunds or care.'
  store.site.bot.welcome.ko = '안녕하세요. WoolBuddy 상담 도우미입니다. 가격, 사진, 제작 기간, 배송, 환불과 관리 방법을 물어보세요.'
}

const removedStyleTags = new Set(['Watercolor Style', 'Cartoon Style'])
for (const product of store.products || []) {
  product.tags = (product.tags || []).filter(tag => !removedStyleTags.has(tag))
}

await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`)
console.log('Applied website feedback v1.0 to api-node/data/store.json')
