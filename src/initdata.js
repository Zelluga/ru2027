// initdata.js — валидация initData по алгоритму из API_CONTRACT.md (раздел 1).
// Только node:crypto.
import crypto from 'node:crypto';

// Дефолтный пользователь для DEV_MODE, когда поле user отсутствует.
const DEV_DEFAULT_USER = { id: 0, first_name: 'Dev', username: 'depenz' };

// Константное по времени сравнение двух hex-строк (timingSafeEqual).
function timingSafeEqualHex(aHex, bHex) {
  const a = Buffer.from(String(aHex), 'hex');
  const b = Buffer.from(String(bHex), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Сборка me из объекта user Telegram (см. раздел 2 контракта).
function buildMe(user, config) {
  const id = user && typeof user.id !== 'undefined' ? Number(user.id) : 0;
  const safeId = Number.isFinite(id) ? id : 0;
  const firstName = user && typeof user.first_name === 'string' ? user.first_name : '';
  const username =
    user && typeof user.username === 'string' && user.username !== '' ? user.username : null;

  const ownerUsername = String(config.OWNER_USERNAME || 'Depenz').toLowerCase();
  const ownerTgId = config.OWNER_TG_ID ? Number(config.OWNER_TG_ID) : NaN;

  const isOwner =
    (username !== null && username.toLowerCase() === ownerUsername) ||
    (Number.isFinite(ownerTgId) && safeId === ownerTgId);

  return { id: safeId, firstName, username, isOwner };
}

function tryParseUser(userRaw) {
  if (!userRaw) return null;
  try {
    const parsed = JSON.parse(userRaw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Валидирует initData и возвращает:
 *   { ok: true, me: {...} }
 * или
 *   { ok: false, code: 'INVALID_INIT_DATA' | 'EXPIRED_INIT_DATA' }
 */
export function validateInitData(initData, config) {
  // DEV_MODE: подпись (и auth_date) не проверяются — только локальная разработка.
  if (config.DEV_MODE) {
    const user = tryParseUser(initData ? new URLSearchParams(initData).get('user') : null) || DEV_DEFAULT_USER;
    return { ok: true, me: buildMe(user, config) };
  }

  if (!initData || typeof initData !== 'string' || initData.length === 0) {
    return { ok: false, code: 'INVALID_INIT_DATA' };
  }

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, code: 'INVALID_INIT_DATA' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, code: 'INVALID_INIT_DATA' };

  // data_check_string: все пары кроме hash, отсортированные по ключу, склеенные через \n.
  params.delete('hash');
  params.sort();
  const parts = [];
  for (const [key, value] of params.entries()) parts.push(`${key}=${value}`);
  const dataCheckString = parts.join('\n');

  if (!config.BOT_TOKEN) {
    // Без токена подпись проверить невозможно — в проде это невалидные данные.
    return { ok: false, code: 'INVALID_INIT_DATA' };
  }

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!timingSafeEqualHex(computedHash, hash)) {
    return { ok: false, code: 'INVALID_INIT_DATA' };
  }

  // Проверка auth_date (сек): floor(now/1000) - auth_date <= AUTH_MAX_AGE_SECONDS.
  const authDateRaw = params.get('auth_date');
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (!Number.isFinite(authDate)) return { ok: false, code: 'INVALID_INIT_DATA' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > config.AUTH_MAX_AGE_SECONDS) {
    return { ok: false, code: 'EXPIRED_INIT_DATA' };
  }

  const user = tryParseUser(params.get('user'));
  if (!user) return { ok: false, code: 'INVALID_INIT_DATA' };

  return { ok: true, me: buildMe(user, config) };
}
