import engine from '#sync/engine'
import { camelizeKeys } from '#util/caseConvert'
import { extractReceiptFromImage } from '#util/gemini'
import { resolveLocale } from '#util/locale'

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
// ~6MB decoded (base64 is ~4/3 of that) — generous for a phone photo, well
// under anything a proxy in front of this API would allow through anyway.
const MAX_BASE64_LENGTH = 8_000_000
const MAX_OPERATIONS = 10

// `.message` тут — англійською, лише для логів/дебагу (нею ж наповнюється
// JSON-відповідь middleware/error.js). Показ користувачу йде за `.code`:
// фронтенд підбирає локалізований текст за ним (див. frontend's
// i18n/locales/*.ts, ключі receipts.scanErrors.*), а не парсить .message.
const badRequest = (message, code, data) => {
  const error = new Error(message)
  error.status = 400
  error.code = code
  if (data) error.data = data
  throw error
}

/** Приймає як голий base64, так і data URL (`data:image/jpeg;base64,...`) з фронтенду. */
function normalizeImage(image, mimeTypeHint) {
  if (typeof image !== 'string' || !image) badRequest('Receipt photo is required', 'RECEIPT_IMAGE_REQUIRED')
  const dataUrlMatch = image.match(/^data:([^;]+);base64,(.+)$/s)
  const base64 = dataUrlMatch ? dataUrlMatch[2] : image
  const mimeType = mimeTypeHint || dataUrlMatch?.[1] || 'image/jpeg'
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    badRequest(`Unsupported photo format: ${mimeType}`, 'RECEIPT_UNSUPPORTED_FORMAT', { mimeType })
  }
  if (base64.length > MAX_BASE64_LENGTH) {
    badRequest('Photo is too large — try compressing or cropping it', 'RECEIPT_IMAGE_TOO_LARGE')
  }
  return { base64, mimeType }
}

// Чеки старші за це — практично завжди не "стара покупка", а Gemini
// переплутала цифру в році/даті на нечіткому фото (типово 2026 -> 2020).
// Такі значення відкидаємо як нерозпізнані, а не довіряємо їм наосліп.
const MAX_RECEIPT_AGE_DAYS = 90

/** "YYYY-MM-DD" з чека -> epoch ms; невалідне, майбутнє або неправдоподібно старе значення -> null (фронт сам підставить "сьогодні"). */
function parseReceiptDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const ms = Date.parse(dateStr)
  if (!Number.isFinite(ms)) return null
  const now = Date.now()
  if (ms > now) return null
  if (now - ms > MAX_RECEIPT_AGE_DAYS * 24 * 60 * 60 * 1000) return null
  return ms
}

/**
 * Звіряє одну позицію чека від Gemini з реальними активними категоріями:
 * відкидає вигадані/архівні id, невірний kind (категорія витрат для
 * income-позиції й навпаки) та підкатегорію, що не належить обраній
 * категорії. Якщо модель повернула лише subcategoryId — відновлює categoryId
 * з його parentId. Повертає null, якщо сама сума невалідна (позицію відкидаємо).
 */
function normalizeItem(item, categoryById) {
  const amount = Math.round(Number(item?.amount) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) return null

  const type = item?.type === 'income' ? 'income' : 'expense'

  let categoryId = item?.categoryId && categoryById.has(item.categoryId) ? item.categoryId : null
  let subcategoryId = item?.subcategoryId && categoryById.has(item.subcategoryId) ? item.subcategoryId : null

  // Модель інколи кладе id підкатегорії в categoryId — розбираємо це.
  if (categoryId && categoryById.get(categoryId).parentId) {
    subcategoryId ??= categoryId
    categoryId = categoryById.get(categoryId).parentId
  }
  if (subcategoryId) {
    const parentId = categoryById.get(subcategoryId).parentId
    if (!parentId) subcategoryId = null
    else if (!categoryId) categoryId = parentId
    else if (parentId !== categoryId) subcategoryId = null
  }
  if (categoryId && (!categoryById.has(categoryId) || categoryById.get(categoryId).kind !== type)) {
    categoryId = null
    subcategoryId = null
  }

  const name = typeof item?.name === 'string' ? item.name.trim() : ''

  return { type, amount, categoryId, subcategoryId, name }
}

/** Позиції з однаковими type + категорія + підкатегорія -> одна операція з сумою й переліком назв. */
function groupItems(items) {
  const groups = new Map()
  for (const item of items) {
    const key = `${item.type}|${item.categoryId ?? ''}|${item.subcategoryId ?? ''}`
    let group = groups.get(key)
    if (!group) {
      group = { type: item.type, amount: 0, categoryId: item.categoryId, subcategoryId: item.subcategoryId, names: [] }
      groups.set(key, group)
    }
    group.amount += item.amount
    if (item.name) group.names.push(item.name)
  }
  return [...groups.values()].map(({ names, ...op }) => ({
    ...op,
    amount: Math.round(op.amount * 100) / 100,
    note: names.join(', ').slice(0, 300) || null,
  }))
}

/**
 * POST /api/receipts/scan — фото чека -> список розпізнаних "операцій".
 *
 * На відміну від решти POST /api/* (див. sync/router.js) тут НІЧОГО не
 * пишеться в БД: рахунок оплати (валюта, курс до базової валюти) і саме
 * рішення "зберегти/відредагувати/відкинути" кожну операцію — це виключно
 * фронтенд-логіка (той самий шлях, що й ручне створення операції — див.
 * TransactionFormModal.vue/submit() і stores/transactions.ts), той самий
 * offline-first outbox, той самий клієнтський uuidv7. Бекенд тут — лише
 * "фотографія -> розпізнаний чернетковий список", звірений із реальними
 * категоріями, щоб фронту не доводилось самому валідувати вигадані id.
 */
const scanReceipt = async (req) => {
  const b = req.body
  const { base64, mimeType } = normalizeImage(b.image, b.mimeType)
  const locale = resolveLocale(req)

  const rawCategories = await engine.listRows({ entity: 'categories' })
  const categories = camelizeKeys(rawCategories).filter((c) => !c.archived)
  const categoryById = new Map(categories.map((c) => [c.id, c]))

  const parsed = await extractReceiptFromImage({ imageBase64: base64, mimeType, categories, locale })

  const items = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((item) => normalizeItem(item, categoryById))
    .filter(Boolean)
  const operations = groupItems(items).slice(0, MAX_OPERATIONS)

  if (!operations.length) {
    const error = new Error('Could not recognize any operation in the photo. Try a different photo or enter it manually.')
    error.status = 422
    error.code = 'RECEIPT_NO_OPERATIONS_DETECTED'
    throw error
  }

  return {
    merchant: parsed?.merchant ?? null,
    date: parseReceiptDate(parsed?.date),
    currency: parsed?.currency ?? null,
    operations,
  }
}

export default scanReceipt
