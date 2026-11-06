// test-initdata.mjs — проверка HMAC-SHA256 валидации initData (секция 1 контракта).
import crypto from 'node:crypto';
import { validateInitData } from './src/initdata.js';

const BOT_TOKEN = '123456789:TEST_TOKEN_FOR_VERIFICATION';

function sign(fields) {
  const keys = Object.keys(fields).sort();
  const dataCheckString = keys.map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const query = keys.map((k) => `${k}=${encodeURIComponent(fields[k])}`).join('&');
  return `${query}&hash=${hash}`;
}

const now = Math.floor(Date.now() / 1000);
const user = { id: 123, first_name: 'Денис', username: 'Depenz' };

function cfg(over = {}) {
  return Object.assign({ BOT_TOKEN, OWNER_USERNAME: 'Depenz', OWNER_TG_ID: '', DEV_MODE: false, AUTH_MAX_AGE_SECONDS: 86400 }, over);
}

let fails = 0;
function check(cond, label) {
  if (cond) console.log('  OK   ' + label);
  else { fails += 1; console.error('  FAIL ' + label); }
}

// 1. Валидные данные
const valid = sign({ auth_date: String(now), query_id: 'AAH', user: JSON.stringify(user) });
let r = validateInitData(valid, cfg());
check(r.ok && r.me.id === 123 && r.me.isOwner === true, 'Валидный initData → ok, me.id=123, isOwner=true');

// 2. Подделка (изменён id без переподписи)
const tampered = valid.replace(encodeURIComponent('"id":123'), encodeURIComponent('"id":999'));
r = validateInitData(tampered, cfg());
check(!r.ok && r.code === 'INVALID_INIT_DATA', 'Подделка user.id → INVALID_INIT_DATA');

// 3. Просроченный initData
const expired = sign({ auth_date: String(now - 100000), query_id: 'AAH', user: JSON.stringify(user) });
r = validateInitData(expired, cfg());
check(!r.ok && r.code === 'EXPIRED_INIT_DATA', 'Просроченный auth_date → EXPIRED_INIT_DATA');

// 4. Нет hash
const noHash = sign({ auth_date: String(now), query_id: 'AAH', user: JSON.stringify(user) }).replace(/&hash=[a-f0-9]+$/, '');
r = validateInitData(noHash, cfg());
check(!r.ok && r.code === 'INVALID_INIT_DATA', 'Без hash → INVALID_INIT_DATA');

// 5. Неверный токен бота
r = validateInitData(valid, cfg({ BOT_TOKEN: 'WRONG_TOKEN' }));
check(!r.ok && r.code === 'INVALID_INIT_DATA', 'Другой BOT_TOKEN → INVALID_INIT_DATA');

// 6. Пустой initData
r = validateInitData('', cfg());
check(!r.ok && r.code === 'INVALID_INIT_DATA', 'Пустой initData → INVALID_INIT_DATA');

// 7. Владелец по Telegram ID (username другой)
const otherUser = sign({ auth_date: String(now), query_id: 'AAH', user: JSON.stringify({ id: 999, first_name: 'X', username: 'someone' }) });
r = validateInitData(otherUser, cfg({ OWNER_TG_ID: '999' }));
check(r.ok && r.me.isOwner === true, 'isOwner=true по OWNER_TG_ID даже при другом username');

console.log('\nИтог: ' + (fails === 0 ? 'ВСЕ ПРОВЕРКИ HMAC ПРОЙДЕНЫ' : fails + ' ПРОВЕРОК УПАЛО'));
process.exit(fails === 0 ? 0 : 1);
