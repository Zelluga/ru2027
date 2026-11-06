// test-api.mjs — самопроверка REST API «2027» (без внешних зависимостей).
// Запуск: сначала сервер с DEV_MODE=1 (для имитации пользователей через user=...),
// затем:  BASE_URL=http://127.0.0.1:8791 node test-api.mjs
// В DEV_MODE подпись не проверяется, но поле user из initData извлекается честно.

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

const OWNER = { id: 999, first_name: 'Денис', username: 'Depenz' };
const ALEXEY = { id: 123, first_name: 'Алексей', username: 'alexey' };
const KIRILL = { id: 456, first_name: 'Кирилл', username: 'kirill' };

function initDataOf(user) {
  return 'user=' + encodeURIComponent(JSON.stringify(user));
}

async function call(method, path, user, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': initDataOf(user),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* пустое тело */ }
  return { status: res.status, data };
}

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log('  OK   ' + label);
  } else {
    failures += 1;
    console.error('  FAIL ' + label);
  }
}

async function main() {
  console.log('База теста: ' + BASE + '\n');

  // 1. Аутентификация / права владельца
  let r = await call('GET', '/api/me', OWNER);
  check(r.status === 200 && r.data.me.isOwner === true, 'GET /api/me → isOwner=true для @Depenz');
  r = await call('GET', '/api/me', ALEXEY);
  check(r.status === 200 && r.data.me.isOwner === false && r.data.me.id === 123, 'GET /api/me → isOwner=false для другого');

  // 2. Сид: две вкладки при первом запуске
  r = await call('GET', '/api/tabs', OWNER);
  check(r.status === 200 && Array.isArray(r.data.tabs), 'GET /api/tabs → массив');
  check(r.data.tabs.length === 2 && r.data.tabs[0].name === 'Падл-пенис' && r.data.tabs[1].name === 'Сука,Сочи',
    'Сид: «Падл-пенис» и «Сука,Сочи», первая активна по умолчанию');
  const tab1 = r.data.tabs[0].id;
  const tab2 = r.data.tabs[1].id;

  // 3. Создание вкладки + валидация
  r = await call('POST', '/api/tabs', ALEXEY, { name: 'Поездка' });
  check(r.status === 201 && r.data.tab.name === 'Поездка' && r.data.tab.createdByTgId === 123,
    'POST /api/tabs → 201, createdByTgId = создатель');
  const tab3 = r.data.tab.id;
  r = await call('POST', '/api/tabs', ALEXEY, { name: 'поездка' });
  check(r.status === 400 && r.data.error.code === 'INVALID_NAME', 'POST /api/tabs дубликат (без регистра) → 400');
  r = await call('POST', '/api/tabs', ALEXEY, { name: '   ' });
  check(r.status === 400, 'POST /api/tabs пустое имя → 400');

  // 4. Лимит 10 вкладок
  let created = 0;
  for (let i = 0; i < 8; i += 1) {
    r = await call('POST', '/api/tabs', ALEXEY, { name: 'Вкладка ' + i });
    if (r.status === 201) created += 1;
  }
  check(created === 7, 'Создано вкладок до лимита (2 сид + 1 + 7 = 10)');
  r = await call('POST', '/api/tabs', ALEXEY, { name: 'Одиннадцатая' });
  check(r.status === 409 && r.data.error.code === 'TAB_LIMIT' && r.data.error.message === 'Достигнут лимит в 10 вкладок',
    '11-я вкладка → 409 TAB_LIMIT');

  // 5. Переименование
  r = await call('PATCH', '/api/tabs/' + tab3, ALEXEY, { name: 'Поездка-2' });
  check(r.status === 200 && r.data.tab.name === 'Поездка-2', 'PATCH /api/tabs/:id → 200');

  // 6. Записи: создание + валидация
  r = await call('GET', '/api/tabs/' + tab1 + '/expenses', OWNER);
  check(r.status === 200 && r.data.expenses.length === 0 && r.data.totals.totalCents === 0, 'GET expenses → пусто, итоги 0');

  r = await call('POST', '/api/tabs/' + tab1 + '/expenses', ALEXEY, { title: 'Такси', amount: 1250.5, payer: 'Алексей', comment: 'из аэропорта' });
  check(r.status === 201 && r.data.expense.amountCents === 125050 && r.data.expense.createdByTgId === 123,
    'POST expense → 201, amountCents=125050, createdByTgId=создатель');
  const exp1 = r.data.expense.id;

  r = await call('POST', '/api/tabs/' + tab1 + '/expenses', KIRILL, { title: 'Ужин', amount: 999.99, payer: 'Кирилл', comment: '' });
  check(r.status === 201 && r.data.expense.amountCents === 99999, 'POST expense → 201, amountCents=99999');
  const exp2 = r.data.expense.id;

  r = await call('POST', '/api/tabs/' + tab1 + '/expenses', ALEXEY, { title: 'X', amount: 0, payer: 'Денис', comment: '' });
  check(r.status === 400, 'POST expense amount=0 → 400');
  r = await call('POST', '/api/tabs/' + tab1 + '/expenses', ALEXEY, { title: 'X', amount: 1.999, payer: 'Денис', comment: '' });
  check(r.status === 400, 'POST expense amount с 3 знаками → 400');
  r = await call('POST', '/api/tabs/' + tab1 + '/expenses', ALEXEY, { title: 'X', amount: 10, payer: 'Чужой', comment: '' });
  check(r.status === 400, 'POST expense неверный payer → 400');
  r = await call('POST', '/api/tabs/' + tab1 + '/expenses', ALEXEY, { title: '   ', amount: 10, payer: 'Денис', comment: '' });
  check(r.status === 400, 'POST expense пустой title → 400');

  // 7. Итоги только по активной вкладке
  r = await call('GET', '/api/tabs/' + tab1 + '/expenses', OWNER);
  check(r.data.totals.totalCents === 125050 + 99999, 'Итог tab1: totalCents = сумма двух записей');
  check(r.data.totals.alexeyCents === 125050 && r.data.totals.kirillCents === 99999 && r.data.totals.denisCents === 0,
    'Итоги по участникам по полю payer');
  r = await call('GET', '/api/tabs/' + tab2 + '/expenses', OWNER);
  check(r.data.expenses.length === 0 && r.data.totals.totalCents === 0, 'Записи не пересекаются: tab2 пуст');

  // 8. Удаление записи: только владелец
  r = await call('DELETE', '/api/expenses/' + exp2, ALEXEY);
  check(r.status === 403 && r.data.error.code === 'FORBIDDEN', 'DELETE чужой записи → 403');
  r = await call('DELETE', '/api/expenses/' + exp2, OWNER);
  check(r.status === 403, 'DELETE чужой записи даже для @Depenz → 403');
  r = await call('DELETE', '/api/expenses/' + exp2, KIRILL);
  check(r.status === 200 && r.data.ok === true, 'DELETE своей записи владельцем → 200');
  r = await call('DELETE', '/api/expenses/' + exp2, KIRILL);
  check(r.status === 404, 'Повторный DELETE записи → 404');

  // 9. Удаление вкладки: только @Depenz, каскадно
  r = await call('DELETE', '/api/tabs/' + tab1, ALEXEY);
  check(r.status === 403, 'DELETE вкладки не-владельцем → 403');
  r = await call('DELETE', '/api/tabs/' + tab1, OWNER);
  check(r.status === 200 && r.data.ok === true, 'DELETE вкладки @Depenz → 200');
  r = await call('GET', '/api/tabs/' + tab1 + '/expenses', OWNER);
  check(r.status === 404, 'Вкладка удалена: её записи каскадно удалены (GET → 404)');

  // 10. Удаление последней вкладки запрещено
  r = await call('GET', '/api/tabs', OWNER);
  const ids = r.data.tabs.map((t) => t.id);
  for (const id of ids.slice(0, -1)) {
    await call('DELETE', '/api/tabs/' + id, OWNER);
  }
  r = await call('GET', '/api/tabs', OWNER);
  check(r.data.tabs.length === 1, 'Осталась одна вкладка');
  r = await call('DELETE', '/api/tabs/' + r.data.tabs[0].id, OWNER);
  check(r.status === 409 && r.data.error.code === 'LAST_TAB', 'DELETE последней вкладки → 409 LAST_TAB');

  // 11. Невалидный initData (в проде) — здесь проверяем только что поле user читается
  r = await call('GET', '/api/me', OWNER);
  check(r.status === 200, 'Повторный GET /api/me → 200');

  console.log('\nИтог: ' + (failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : failures + ' ПРОВЕРОК УПАЛО'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Ошибка выполнения теста:', e);
  process.exit(1);
});
