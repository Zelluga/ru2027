// Cloudflare Pages Function — обработчик всех /api/* запросов Telegram Mini App «2027».
// Хранилище: Cloudflare D1 (привязка env.DB). Криптография: Web Crypto (crypto.subtle).
// Статику (public/) раздаёт сам Pages — этот файл её не трогает.
//
// Логика идентична Node-версии (server.js + src/*) и покрыта тем же API-контрактом.

const PAYERS = ['Денис', 'Алексей', 'Кирилл'];
const MAX_TABS = 10;
const DEV_DEFAULT_USER = { id: 0, first_name: 'Dev', username: 'depenz' };

const encoder = new TextEncoder();

/* ---------- Утилиты ответа ---------- */
function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function sendError(status, code, message) {
  return json(status, { error: { code, message } });
}

/* ---------- HMAC-SHA256 (Web Crypto) ---------- */
function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

// Константное по времени сравнение двух hex-строк.
function timingSafeEqualHex(aHex, bHex) {
  const a = String(aHex).toLowerCase();
  const b = String(bHex).toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- initData ---------- */
function tryParseUser(raw) {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

function buildMe(user, env) {
  const id = user && typeof user.id !== 'undefined' ? Number(user.id) : 0;
  const safeId = Number.isFinite(id) ? id : 0;
  const firstName = user && typeof user.first_name === 'string' ? user.first_name : '';
  const username =
    user && typeof user.username === 'string' && user.username !== '' ? user.username : null;

  const ownerUsername = String(env.OWNER_USERNAME || 'Depenz').toLowerCase();
  const ownerTgId = env.OWNER_TG_ID ? Number(env.OWNER_TG_ID) : NaN;
  const isOwner =
    (username !== null && username.toLowerCase() === ownerUsername) ||
    (Number.isFinite(ownerTgId) && safeId === ownerTgId);

  return { id: safeId, firstName, username, isOwner };
}

async function validateInitData(initData, env) {
  if (env.DEV_MODE === '1') {
    const params = initData ? new URLSearchParams(initData) : null;
    const user = (params && tryParseUser(params.get('user'))) || DEV_DEFAULT_USER;
    return { ok: true, me: buildMe(user, env) };
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

  params.delete('hash');
  params.sort();
  const parts = [];
  for (const [k, v] of params.entries()) parts.push(`${k}=${v}`);
  const dataCheckString = parts.join('\n');

  const botToken = env.BOT_TOKEN;
  if (!botToken) return { ok: false, code: 'INVALID_INIT_DATA' };

  const secretKey = await hmac(encoder.encode('WebAppData'), botToken);
  const computedHash = bytesToHex(await hmac(secretKey, dataCheckString));
  if (!timingSafeEqualHex(computedHash, hash)) {
    return { ok: false, code: 'INVALID_INIT_DATA' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return { ok: false, code: 'INVALID_INIT_DATA' };

  const maxAge = Number(env.AUTH_MAX_AGE_SECONDS || 86400);
  if (Math.floor(Date.now() / 1000) - authDate > maxAge) {
    return { ok: false, code: 'EXPIRED_INIT_DATA' };
  }

  const user = tryParseUser(params.get('user'));
  if (!user) return { ok: false, code: 'INVALID_INIT_DATA' };

  return { ok: true, me: buildMe(user, env) };
}

/* ---------- D1: схема и сид ---------- */
async function ensureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_by_tg_id INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tab_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      payer TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_by_tg_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`).run();

  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_expenses_tab ON expenses(tab_id)`).run();

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM tabs').first();
  if (Number(countRow.c) === 0) {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO tabs (name, created_by_tg_id, created_at) VALUES (?, ?, ?)')
        .bind('Падл-пенис', 0, now),
      env.DB.prepare('INSERT INTO tabs (name, created_by_tg_id, created_at) VALUES (?, ?, ?)')
        .bind('Сука,Сочи', 0, now),
    ]);
  }
}

/* ---------- D1: чтение ---------- */
function tabToJson(row, expenseCount) {
  return {
    id: Number(row.id),
    name: row.name,
    createdByTgId: Number(row.created_by_tg_id),
    createdAt: row.created_at,
    expenseCount,
  };
}

function expenseToJson(row) {
  return {
    id: Number(row.id),
    tabId: Number(row.tab_id),
    title: row.title,
    amountCents: Number(row.amount_cents),
    payer: row.payer,
    comment: row.comment,
    createdByTgId: Number(row.created_by_tg_id),
    createdAt: row.created_at,
  };
}

async function getTabById(env, tabId) {
  return env.DB.prepare('SELECT id, name, created_by_tg_id, created_at FROM tabs WHERE id = ?')
    .bind(tabId)
    .first();
}

async function countExpenses(env, tabId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM expenses WHERE tab_id = ?')
    .bind(tabId)
    .first();
  return Number(row.c);
}

async function listTabs(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, created_by_tg_id, created_at FROM tabs ORDER BY created_at ASC, id ASC'
  ).all();
  const out = [];
  for (const r of results) out.push(tabToJson(r, await countExpenses(env, r.id)));
  return out;
}

async function listExpenses(env, tabId) {
  const { results } = await env.DB.prepare(
    'SELECT id, tab_id, title, amount_cents, payer, comment, created_by_tg_id, created_at FROM expenses WHERE tab_id = ? ORDER BY created_at DESC, id DESC'
  ).bind(tabId).all();
  return results.map(expenseToJson);
}

async function computeTotals(env, tabId) {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(amount_cents), 0) AS total,
       COALESCE(SUM(CASE WHEN payer = ? THEN amount_cents ELSE 0 END), 0) AS denis,
       COALESCE(SUM(CASE WHEN payer = ? THEN amount_cents ELSE 0 END), 0) AS alexey,
       COALESCE(SUM(CASE WHEN payer = ? THEN amount_cents ELSE 0 END), 0) AS kirill
     FROM expenses WHERE tab_id = ?`
  ).bind('Денис', 'Алексей', 'Кирилл', tabId).first();

  return {
    totalCents: Number(row.total),
    denisCents: Number(row.denis),
    alexeyCents: Number(row.alexey),
    kirillCents: Number(row.kirill),
  };
}

// Кириллическая регистронезависимая уникальность (COLLATE NOCASE сворачивает только ASCII).
async function findDuplicateTabName(env, name, excludeId) {
  const { results } = await env.DB.prepare('SELECT id, name FROM tabs').all();
  const target = name.toLowerCase();
  for (const row of results) {
    if (excludeId !== undefined && Number(row.id) === excludeId) continue;
    if (String(row.name).toLowerCase() === target) return row;
  }
  return null;
}

/* ---------- Валидация суммы ---------- */
function validateAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (amount <= 0) return null;
  if (amount > 999999999.99) return null;
  const cents = Math.round(amount * 100);
  if (Math.abs(cents - amount * 100) > 1e-6) return null;
  return cents;
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getAllowedIds(env) {
  return String(env.ALLOWED_TG_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/* ---------- Главный обработчик ---------- */
async function handleApi(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = (request.method || 'GET').toUpperCase();

  const initData = request.headers.get('X-Telegram-Init-Data') || '';
  const auth = await validateInitData(initData, env);
  if (!auth.ok) {
    const message = auth.code === 'EXPIRED_INIT_DATA' ? 'Срок действия initData истёк' : 'Невалидные initData';
    return sendError(401, auth.code, message);
  }
  const me = auth.me;

  const allowedIds = getAllowedIds(env);
  if (allowedIds.length > 0 && !allowedIds.includes(me.id)) {
    return sendError(403, 'FORBIDDEN', 'Доступ запрещён: пользователь не в белом списке');
  }

  await ensureSchema(env);

  if (pathname === '/api/me') {
    if (method === 'GET') return json(200, { me });
    return sendError(404, 'NOT_FOUND', 'Эндпоинт не найден');
  }

  if (pathname === '/api/tabs') {
    if (method === 'GET') return json(200, { tabs: await listTabs(env) });
    if (method === 'POST') {
      const body = await readJson(request);
      const name = body && typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return sendError(400, 'INVALID_NAME', 'Название вкладки не может быть пустым');

      const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM tabs').first();
      if (Number(cnt.c) >= MAX_TABS) return sendError(409, 'TAB_LIMIT', 'Достигнут лимит в 10 вкладок');

      if (await findDuplicateTabName(env, name)) {
        return sendError(400, 'INVALID_NAME', 'Вкладка с таким названием уже существует');
      }

      const createdAt = new Date().toISOString();
      const res = await env.DB.prepare(
        'INSERT INTO tabs (name, created_by_tg_id, created_at) VALUES (?, ?, ?)'
      ).bind(name, me.id, createdAt).run();
      const tab = { id: Number(res.meta.last_row_id), name, createdByTgId: me.id, createdAt, expenseCount: 0 };
      return json(201, { tab });
    }
    return sendError(404, 'NOT_FOUND', 'Эндпоинт не найден');
  }

  let m;
  if ((m = pathname.match(/^\/api\/tabs\/(\d+)\/expenses$/))) {
    const tabId = Number(m[1]);

    if (method === 'GET') {
      const tab = await getTabById(env, tabId);
      if (!tab) return sendError(404, 'TAB_NOT_FOUND', 'Вкладка не найдена');
      return json(200, { expenses: await listExpenses(env, tabId), totals: await computeTotals(env, tabId) });
    }

    if (method === 'POST') {
      const tab = await getTabById(env, tabId);
      if (!tab) return sendError(404, 'TAB_NOT_FOUND', 'Вкладка не найдена');

      const body = await readJson(request);
      if (!body) return sendError(400, 'INVALID_EXPENSE', 'Некорректные поля записи');

      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) return sendError(400, 'INVALID_EXPENSE', 'Укажите название записи');

      const amountCents = validateAmount(body.amount);
      if (amountCents === null) return sendError(400, 'INVALID_EXPENSE', 'Некорректная сумма');

      if (!PAYERS.includes(body.payer)) return sendError(400, 'INVALID_EXPENSE', 'Некорректный плательщик');

      const comment = typeof body.comment === 'string' ? body.comment : '';
      const createdAt = new Date().toISOString();
      const res = await env.DB.prepare(
        'INSERT INTO expenses (tab_id, title, amount_cents, payer, comment, created_by_tg_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(tabId, title, amountCents, body.payer, comment, me.id, createdAt).run();

      const expense = {
        id: Number(res.meta.last_row_id),
        tabId,
        title,
        amountCents,
        payer: body.payer,
        comment,
        createdByTgId: me.id,
        createdAt,
      };
      return json(201, { expense });
    }
    return sendError(404, 'NOT_FOUND', 'Эндпоинт не найден');
  }

  if ((m = pathname.match(/^\/api\/tabs\/(\d+)$/))) {
    const tabId = Number(m[1]);

    if (method === 'PATCH') {
      const tab = await getTabById(env, tabId);
      if (!tab) return sendError(404, 'TAB_NOT_FOUND', 'Вкладка не найдена');

      const body = await readJson(request);
      const name = body && typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return sendError(400, 'INVALID_NAME', 'Название вкладки не может быть пустым');

      if (await findDuplicateTabName(env, name, tabId)) {
        return sendError(400, 'INVALID_NAME', 'Вкладка с таким названием уже существует');
      }

      await env.DB.prepare('UPDATE tabs SET name = ? WHERE id = ?').bind(name, tabId).run();
      const updated = await getTabById(env, tabId);
      return json(200, { tab: tabToJson(updated, await countExpenses(env, tabId)) });
    }

    if (method === 'DELETE') {
      const tab = await getTabById(env, tabId);
      if (!tab) return sendError(404, 'TAB_NOT_FOUND', 'Вкладка не найдена');
      if (!me.isOwner) return sendError(403, 'FORBIDDEN', 'Недостаточно прав для удаления вкладки');

      const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM tabs').first();
      if (Number(cnt.c) <= 1) return sendError(409, 'LAST_TAB', 'Нельзя удалить последнюю вкладку');

      // Каскадное удаление записей вкладки в одной транзакции.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM expenses WHERE tab_id = ?').bind(tabId),
        env.DB.prepare('DELETE FROM tabs WHERE id = ?').bind(tabId),
      ]);
      return json(200, { ok: true });
    }
    return sendError(404, 'NOT_FOUND', 'Эндпоинт не найден');
  }

  if ((m = pathname.match(/^\/api\/expenses\/(\d+)$/))) {
    const expenseId = Number(m[1]);

    if (method === 'DELETE') {
      const exp = await env.DB.prepare('SELECT id, created_by_tg_id FROM expenses WHERE id = ?')
        .bind(expenseId)
        .first();
      if (!exp) return sendError(404, 'EXPENSE_NOT_FOUND', 'Запись не найдена');
      if (Number(exp.created_by_tg_id) !== me.id) {
        return sendError(403, 'FORBIDDEN', 'Удалять можно только свои записи');
      }
      await env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(expenseId).run();
      return json(200, { ok: true });
    }
    return sendError(404, 'NOT_FOUND', 'Эндпоинт не найден');
  }

  return sendError(404, 'NOT_FOUND', 'Эндпоинт не найден');
}

/* ---------- Точка входа Pages Function ---------- */
export async function onRequest(context) {
  try {
    return await handleApi(context.request, context.env);
  } catch (err) {
    console.error('Ошибка /api:', err);
    const detail = err && err.message ? err.message : String(err);
    return sendError(500, 'INTERNAL', 'Внутренняя ошибка сервера: ' + detail);
  }
}
