# API-контракт Telegram Mini App «2027»

Это единый контракт для backend и frontend. Backend реализует ровно эти endpoint'ы,
frontend вызывает только их. Любое расхождение с этим файлом — баг.

## 0. Технические ограничения (обязательно)

- **Zero внешних зависимостей.** Используем только встроенные модули Node 24:
  - `node:http` — HTTP-сервер и раздача статики;
  - `node:sqlite` (`DatabaseSync`) — БД;
  - `node:crypto` — HMAC-SHA256 для initData;
  - `node:fs`, `node:path`, `node:url` — файлы и маршруты.
- `package.json` уже имеет `"type": "module"` — пишем ESM (`import ... from ...`).
- Все тексты, ошибки и подписи интерфейса — на русском. Валюта — ₽.

## 1. Передача initData

Каждый запрос к `/api/*` несёт заголовок:

```
X-Telegram-Init-Data: <строка initData из Telegram.WebApp.initData>
```

Сервер на КАЖДОМ `/api/*` запросе валидирует этот заголовок. Невалидный/просроченный → **401**.
Единственное исключение — статика (`/`, `/index.html`, `/style.css`, `/app.js`) отдаётся без initData.

### Алгоритм валидации initData (HMAC-SHA256)

1. Распарсить строку `initData` как URL-query (`key=value&key=value`, значения URL-encoded).
2. Выделить `hash` (hex-строка).
3. `data_check_string` = оставшиеся пары, отсортированные по ключу алфавитно, склеенные через `\n` как `key=value`.
4. `secret_key = HMAC_SHA256(message = BOT_TOKEN, key = "WebAppData")`.
5. `computed_hash = HMAC_SHA256(message = data_check_string, key = secret_key)`, hex, lowercase.
6. Сравнить `computed_hash` с `hash` **константным по времени** (`node:crypto` `timingSafeEqual`).
7. Проверить `auth_date` (сек): `floor(now/1000) - auth_date <= AUTH_MAX_AGE_SECONDS` (иначе 401).
8. Распарсить поле `user` как JSON → `{ id, first_name, username, ... }`.

Режим `DEV_MODE=1` (только локальная разработка): подпись НЕ проверяется, но `user` всё равно
извлекается из initData (если `user` нет — `{ id: 0, first_name: "Dev", username: "depenz" }`).
`DEV_MODE` обязан быть залогирован предупреждением при старте.

## 2. Модель пользователя и права

Из валидного initData сервер строит:

```jsonc
me = {
  "id": 123456789,            // number, Telegram user id
  "firstName": "Денис",       // string, user.first_name
  "username": "Depenz",       // string | null, user.username
  "isOwner": true             // boolean
}
```

`isOwner = (username.toLowerCase() === OWNER_USERNAME.toLowerCase()) || (id === Number(OWNER_TG_ID))`.
Если задан `ALLOWED_TG_IDS` (непустой список), любой чужой id → **403** на весь `/api/*`.

## 3. Ошибки

Все ошибки — JSON с HTTP-статусом:

```json
{ "error": { "code": "TAB_LIMIT", "message": "Достигнут лимит в 10 вкладок" } }
```

Коды и статусы:
- `401` `INVALID_INIT_DATA` / `EXPIRED_INIT_DATA` — auth.
- `403` `FORBIDDEN` — недостаточно прав (удаление чужой записи/вкладки, не в белом списке).
- `404` `TAB_NOT_FOUND` / `EXPENSE_NOT_FOUND`.
- `400` `INVALID_NAME` (пустое/дубликат названия), `INVALID_EXPENSE` (неверные поля записи).
- `409` `TAB_LIMIT` (11-я вкладка), `LAST_TAB` («Нельзя удалить последнюю вкладку»).

## 4. Формат денег

- Клиент → сервер: `amount` — число в рублях, > 0, не более 2 знаков после запятой
  (`Math.round(amount*100) === amount*100` в пределах 1e-6), максимум 999_999_999.99.
- Сервер хранит копейки целым числом `amountCents = Math.round(amount*100)`.
- Сервер → клиент: только `amountCents` (integer). Клиент форматирует сам.

## 5. Endpoint'ы

### GET /api/me
Ответ 200:
```json
{ "me": { "id": 123456789, "firstName": "Денис", "username": "Depenz", "isOwner": true } }
```

### GET /api/tabs
Ответ 200 (список по возрастанию `createdAt`, порядок = порядок создания):
```json
{
  "tabs": [
    { "id": 1, "name": "Падл-пенис", "createdByTgId": 0, "createdAt": "2026-11-05T17:00:00.000Z", "expenseCount": 3 }
  ]
}
```
`createdAt` — ISO-8601 UTC строка. `expenseCount` — число записей вкладки (для предупреждения при удалении).

### POST /api/tabs
Тело: `{ "name": "Новая" }`. Ответ 201:
```json
{ "tab": { "id": 2, "name": "Новая", "createdByTgId": 123456789, "createdAt": "...", "expenseCount": 0 } }
```
Правила: `name` после `trim` непустой; уникальный **без учёта регистра** (глобально); лимит 10 (409 `TAB_LIMIT`).

### PATCH /api/tabs/:tabId
Тело: `{ "name": "Новое имя" }`. Ответ 200: `{ "tab": {...} }`. Те же правила валидации name.

### DELETE /api/tabs/:tabId
Только `isOwner`. Ответ 200: `{ "ok": true }`.
- Не owner → 403.
- Последняя вкладка → 409 `LAST_TAB`.
- Удаление каскадно удаляет все записи вкладки (SQLite `ON DELETE CASCADE` + `PRAGMA foreign_keys = ON`).

### GET /api/tabs/:tabId/expenses
Ответ 200 (записи сначала новые):
```json
{
  "expenses": [
    { "id": 10, "tabId": 1, "title": "Такси", "amountCents": 125000, "payer": "Денис",
      "comment": "из аэропорта", "createdByTgId": 123456789, "createdAt": "2026-11-05T17:10:00.000Z" }
  ],
  "totals": { "totalCents": 125000, "denisCents": 125000, "alexeyCents": 0, "kirillCents": 0 }
}
```
`payer` ∈ { "Денис", "Алексей", "Кирилл" }. `totals.*Cents` — целые копейки, считаются ТОЛЬКО по этой вкладке.

### POST /api/tabs/:tabId/expenses
Тело:
```json
{ "title": "Такси", "amount": 1250, "payer": "Денис", "comment": "из аэропорта" }
```
Ответ 201: `{ "expense": {...} }` (та же форма, что в списке).
Правила: `title` непустой после trim; `amount` > 0 и ≤2 знака; `payer` строго один из трёх; `comment` — строка (пустая = ""). `createdByTgId` = id из initData (НЕ из payer). 404 если вкладки нет.

### DELETE /api/expenses/:expenseId
Только владелец: `expense.createdByTgId === me.id`. Ответ 200: `{ "ok": true }`.
- Не владелец → 403 (в том числе для @Depenz — удалить чужую запись через API нельзя).
- 404 если записи нет.

## 6. Схема SQLite

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tabs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_by_tg_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  payer TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_by_tg_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_tab ON expenses(tab_id);
```

Сид при первом запуске (когда таблица `tabs` пуста) — ровно две вкладки, по порядку:
`"Падл-пенис"`, затем `"Сука,Сочи"` (обе с `created_by_tg_id = 0`). Первая — по умолчанию активная.

## 7. Статика

Сервер раздаёт `public/` по корню: `GET /` → `public/index.html`, `/style.css`, `/app.js`.
Content-Type: html/css/js соответственно. Статику отдавать без initData.

## 8. Синхронизация

Frontend опрашивает (polling) каждые 3 секунды: `GET /api/tabs` и `GET /api/tabs/<active>/expenses`.
Этого достаточно для требования «изменения видны ≤ 5 с». WebSocket не требуется.
