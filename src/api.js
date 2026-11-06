// api.js — обработчики всех endpoint'ов из раздела 5 контракта.
import { db } from './db.js';
import { config } from './config.js';
import { validateInitData } from './initdata.js';

const MAX_TABS = 10;
const PAYERS = ['Денис', 'Алексей', 'Кирилл'];

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  return sendJson(res, status, { error: { code, message } });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > 1_000_000) {
        tooLarge = true;
        raw = '';
      }
    });
    req.on('end', () => {
      if (tooLarge) return resolve(null);
      if (raw.trim() === '') return resolve({});
      try {
        const parsed = JSON.parse(raw);
        return resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch {
        return resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// Валидация суммы: amount>0, не более 2 знаков после запятой, максимум 999999999.99.
// Возвращает целые копейки или null.
function validateAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (amount <= 0) return null;
  if (amount > 999999999.99) return null;
  const cents = Math.round(amount * 100);
  if (Math.abs(cents - amount * 100) > 1e-6) return null;
  return cents;
}

// Аутентификация + белый список. Возвращает me или null (ответ уже отправлен).
function getMe(req, res) {
  const initData = req.headers['x-telegram-init-data'];
  const result = validateInitData(initData, config);
  if (!result.ok) {
    const code = result.code || 'INVALID_INIT_DATA';
    const message = code === 'EXPIRED_INIT_DATA' ? 'Срок действия initData истёк' : 'Невалидные initData';
    sendError(res, 401, code, message);
    return null;
  }
  const me = result.me;
  if (config.ALLOWED_TG_IDS.length > 0 && !config.ALLOWED_TG_IDS.includes(me.id)) {
    sendError(res, 403, 'FORBIDDEN', 'Доступ запрещён: пользователь не в белом списке');
    return null;
  }
  return me;
}

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

const TAB_SELECT = 'SELECT id, name, created_by_tg_id, created_at FROM tabs';
const EXPENSE_SELECT =
  'SELECT id, tab_id, title, amount_cents, payer, comment, created_by_tg_id, created_at FROM expenses';

function getTabById(tabId) {
  return db.prepare(`${TAB_SELECT} WHERE id = ?`).get(tabId);
}

function countExpenses(tabId) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM expenses WHERE tab_id = ?').get(tabId);
  return Number(row.c);
}

// Поиск вкладки с тем же названием без учёта регистра (глобально).
// Используем JS toLowerCase(), т.к. COLLATE NOCASE в SQLite сворачивает только ASCII,
// а названия у нас кириллические.
function findDuplicateTabName(name, excludeId) {
  const rows = db.prepare('SELECT id, name FROM tabs').all();
  const target = name.toLowerCase();
  for (const row of rows) {
    if (excludeId !== undefined && Number(row.id) === excludeId) continue;
    if (String(row.name).toLowerCase() === target) return row;
  }
  return null;
}

function listTabs() {
  const rows = db.prepare(`${TAB_SELECT} ORDER BY created_at ASC, id ASC`).all();
  return rows.map((r) => tabToJson(r, countExpenses(r.id)));
}

function listExpenses(tabId) {
  const rows = db.prepare(`${EXPENSE_SELECT} WHERE tab_id = ? ORDER BY created_at DESC, id DESC`).all(tabId);
  return rows.map(expenseToJson);
}

function computeTotals(tabId) {
  const row = db
    .prepare(
      `SELECT
        COALESCE(SUM(amount_cents), 0) AS totalCents,
        COALESCE(SUM(CASE WHEN payer = ? THEN amount_cents ELSE 0 END), 0) AS denisCents,
        COALESCE(SUM(CASE WHEN payer = ? THEN amount_cents ELSE 0 END), 0) AS alexeyCents,
        COALESCE(SUM(CASE WHEN payer = ? THEN amount_cents ELSE 0 END), 0) AS kirillCents
      FROM expenses
      WHERE tab_id = ?`
    )
    .get('Денис', 'Алексей', 'Кирилл', tabId);
  return {
    totalCents: Number(row.totalCents),
    denisCents: Number(row.denisCents),
    alexeyCents: Number(row.alexeyCents),
    kirillCents: Number(row.kirillCents),
  };
}

// --- Обработчики ---

async function createTab(req, res, me) {
  const body = await readJsonBody(req);
  const name = body && typeof body === 'object' && typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return sendError(res, 400, 'INVALID_NAME', 'Название вкладки не может быть пустым');

  const tabCount = Number(db.prepare('SELECT COUNT(*) AS c FROM tabs').get().c);
  if (tabCount >= MAX_TABS) return sendError(res, 409, 'TAB_LIMIT', 'Достигнут лимит в 10 вкладок');

  if (findDuplicateTabName(name)) {
    return sendError(res, 400, 'INVALID_NAME', 'Вкладка с таким названием уже существует');
  }

  const createdAt = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO tabs (name, created_by_tg_id, created_at) VALUES (?, ?, ?)')
    .run(name, me.id, createdAt);
  const tab = tabToJson(
    { id: info.lastInsertRowid, name, created_by_tg_id: me.id, created_at: createdAt },
    0
  );
  return sendJson(res, 201, { tab });
}

async function renameTab(req, res, tabId) {
  const tab = getTabById(tabId);
  if (!tab) return sendError(res, 404, 'TAB_NOT_FOUND', 'Вкладка не найдена');

  const body = await readJsonBody(req);
  const name = body && typeof body === 'object' && typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return sendError(res, 400, 'INVALID_NAME', 'Название вкладки не может быть пустым');

  if (findDuplicateTabName(name, tabId)) {
    return sendError(res, 400, 'INVALID_NAME', 'Вкладка с таким названием уже существует');
  }

  db.prepare('UPDATE tabs SET name = ? WHERE id = ?').run(name, tabId);
  const updated = getTabById(tabId);
  return sendJson(res, 200, { tab: tabToJson(updated, countExpenses(tabId)) });
}

function deleteTab(res, me, tabId) {
  const tab = getTabById(tabId);
  if (!tab) return sendError(res, 404, 'TAB_NOT_FOUND', 'Вкладка не найдена');
  if (!me.isOwner) return sendError(res, 403, 'FORBIDDEN', 'Недостаточно прав для удаления вкладки');

  const tabCount = Number(db.prepare('SELECT COUNT(*) AS c FROM tabs').get().c);
  if (tabCount <= 1) return sendError(res, 409, 'LAST_TAB', 'Нельзя удалить последнюю вкладку');

  db.prepare('DELETE FROM tabs WHERE id = ?').run(tabId);
  return sendJson(res, 200, { ok: true });
}

function getExpenses(res, tabId) {
  const tab = getTabById(tabId);
  if (!tab) return sendError(res, 404, 'TAB_NOT_FOUND', 'Вкладка не найдена');
  return sendJson(res, 200, { expenses: listExpenses(tabId), totals: computeTotals(tabId) });
}

async function createExpense(req, res, me, tabId) {
  const tab = getTabById(tabId);
  if (!tab) return sendError(res, 404, 'TAB_NOT_FOUND', 'Вкладка не найдена');

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') return sendError(res, 400, 'INVALID_EXPENSE', 'Некорректные поля записи');

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return sendError(res, 400, 'INVALID_EXPENSE', 'Укажите название записи');

  const amountCents = validateAmount(body.amount);
  if (amountCents === null) return sendError(res, 400, 'INVALID_EXPENSE', 'Некорректная сумма');

  if (!PAYERS.includes(body.payer)) return sendError(res, 400, 'INVALID_EXPENSE', 'Некорректный плательщик');

  const comment = typeof body.comment === 'string' ? body.comment : '';

  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO expenses (tab_id, title, amount_cents, payer, comment, created_by_tg_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(tabId, title, amountCents, body.payer, comment, me.id, createdAt);

  const expense = expenseToJson({
    id: info.lastInsertRowid,
    tab_id: tabId,
    title,
    amount_cents: amountCents,
    payer: body.payer,
    comment,
    created_by_tg_id: me.id,
    created_at: createdAt,
  });
  return sendJson(res, 201, { expense });
}

function deleteExpense(res, me, expenseId) {
  const expense = db.prepare('SELECT id, created_by_tg_id FROM expenses WHERE id = ?').get(expenseId);
  if (!expense) return sendError(res, 404, 'EXPENSE_NOT_FOUND', 'Запись не найдена');
  if (Number(expense.created_by_tg_id) !== me.id) {
    return sendError(res, 403, 'FORBIDDEN', 'Удалять можно только свои записи');
  }
  db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
  return sendJson(res, 200, { ok: true });
}

export async function handleApi(req, res, url) {
  try {
    const method = (req.method || 'GET').toUpperCase();
    const pathname = url.pathname;

    const me = getMe(req, res);
    if (!me) return;

    if (pathname === '/api/me') {
      if (method === 'GET') return sendJson(res, 200, { me });
      return sendError(res, 404, 'NOT_FOUND', 'Эндпоинт не найден');
    }

    if (pathname === '/api/tabs') {
      if (method === 'GET') return sendJson(res, 200, { tabs: listTabs() });
      if (method === 'POST') return await createTab(req, res, me);
      return sendError(res, 404, 'NOT_FOUND', 'Эндпоинт не найден');
    }

    let m;
    if ((m = pathname.match(/^\/api\/tabs\/(\d+)\/expenses$/))) {
      const tabId = Number(m[1]);
      if (method === 'GET') return getExpenses(res, tabId);
      if (method === 'POST') return await createExpense(req, res, me, tabId);
      return sendError(res, 404, 'NOT_FOUND', 'Эндпоинт не найден');
    }

    if ((m = pathname.match(/^\/api\/tabs\/(\d+)$/))) {
      const tabId = Number(m[1]);
      if (method === 'PATCH') return await renameTab(req, res, tabId);
      if (method === 'DELETE') return deleteTab(res, me, tabId);
      return sendError(res, 404, 'NOT_FOUND', 'Эндпоинт не найден');
    }

    if ((m = pathname.match(/^\/api\/expenses\/(\d+)$/))) {
      const expenseId = Number(m[1]);
      if (method === 'DELETE') return deleteExpense(res, me, expenseId);
      return sendError(res, 404, 'NOT_FOUND', 'Эндпоинт не найден');
    }

    return sendError(res, 404, 'NOT_FOUND', 'Эндпоинт не найден');
  } catch (err) {
    console.error('Ошибка обработки /api:', err);
    if (!res.headersSent) sendError(res, 500, 'INTERNAL', 'Внутренняя ошибка сервера');
  }
}
