/* ===== Telegram Mini App «2027» — логика фронтенда =====
   Чистый vanilla JS. Все запросы к /api/* несут заголовок X-Telegram-Init-Data.
   Суммы приходят от сервера в копейках (amountCents / totalCents / ...Cents). */

'use strict';

/* ---------- 1. Telegram WebApp ---------- */
const TG = (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) || null;

if (TG) {
  TG.ready();
  TG.expand();
}

/* ---------- 2. Состояние ---------- */
const state = {
  me: null,            // { id, firstName, username, isOwner } из /api/me
  tabs: [],            // массив вкладок из /api/tabs
  activeTabId: null,   // id активной вкладки
  expenses: [],        // записи активной вкладки
  totals: null,        // { totalCents, denisCents, alexeyCents, kirillCents }
};

const PAYERS = ['Денис', 'Алексей', 'Кирилл'];
const TAB_LIMIT = 10;
const POLL_INTERVAL_MS = 3000;

/* Подписи для предотвращения лишних перерисовок при опросе */
let lastTabsSignature = '';
let lastExpensesSignature = '';

/* ---------- 3. Форматирование ---------- */
// Деньги: копейки -> «1 250,00 ₽»
const moneyFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatCents(cents) {
  const value = Number(cents) || 0;
  return moneyFormatter.format(value / 100) + ' ₽';
}

// Дата/время: ISO-8601 UTC -> локальная строка
const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return dateFormatter.format(d);
}

/* ---------- 4. Тема ---------- */
function applyTheme() {
  const root = document.documentElement;
  const scheme = (TG && TG.colorScheme) || 'light';
  root.setAttribute('data-theme', scheme);

  const tp = (TG && TG.themeParams) || {};
  const vars = {
    '--bg': tp.bg_color,
    '--text': tp.text_color,
    '--hint': tp.hint_color,
    '--button': tp.button_color,
    '--button-text': tp.button_text_color,
    '--secondary-bg': tp.secondary_bg_color,
    '--link': tp.link_color,
  };
  for (const [name, value] of Object.entries(vars)) {
    if (value) root.style.setProperty(name, value);
  }

  // Синхронизируем цвет статус-бара, если Telegram это поддерживает
  if (TG && TG.setHeaderColor) {
    try { TG.setHeaderColor(tp.bg_color || (scheme === 'dark' ? '#000000' : '#f2f2f7')); } catch (_) {}
  }
}

if (TG && TG.onEvent) {
  TG.onEvent('themeChanged', applyTheme);
}

/* ---------- 5. HTTP-обёртка ---------- */
class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign(
    {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': (TG && TG.initData) || '',
    },
    opts.headers || {}
  );

  let response;
  try {
    response = await fetch(path, Object.assign({}, opts, { headers }));
  } catch (networkErr) {
    // Сеть недоступна
    throw new ApiError('Нет соединения с сервером', 0, 'NETWORK');
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiError('Ошибка авторизации Telegram', 401, 'AUTH');
    }
    const code = data && data.error ? data.error.code : 'HTTP_' + response.status;
    const message = data && data.error ? data.error.message : 'Ошибка ' + response.status;
    throw new ApiError(message, response.status, code);
  }

  return data;
}

/* ---------- 6. Элементы DOM ---------- */
const el = {
  appUser: document.getElementById('app-user'),
  tabsList: document.getElementById('tabs-list'),
  addTabBtn: document.getElementById('add-tab-btn'),
  tabActionsBtn: document.getElementById('tab-actions-btn'),
  expenseForm: document.getElementById('expense-form'),
  titleInput: document.getElementById('title-input'),
  amountInput: document.getElementById('amount-input'),
  payerSelect: document.getElementById('payer-select'),
  commentInput: document.getElementById('comment-input'),
  formError: document.getElementById('form-error'),
  emptyState: document.getElementById('empty-state'),
  expensesList: document.getElementById('expenses-list'),
  badgeTotal: document.getElementById('badge-total'),
  badgeDenis: document.getElementById('badge-denis'),
  badgeAlexey: document.getElementById('badge-alexey'),
  badgeKirill: document.getElementById('badge-kirill'),
  modalOverlay: document.getElementById('modal-overlay'),
  modalTitle: document.getElementById('modal-title'),
  modalBody: document.getElementById('modal-body'),
  modalActions: document.getElementById('modal-actions'),
  toast: document.getElementById('toast'),
  fatalOverlay: document.getElementById('fatal-overlay'),
  fatalTitle: document.getElementById('fatal-title'),
  fatalMessage: document.getElementById('fatal-message'),
  fatalRetry: document.getElementById('fatal-retry'),
};

/* ---------- 7. Модальные окна ---------- */
function isModalOpen() {
  return !el.modalOverlay.classList.contains('hidden');
}

function openModal(title, bodyNodes, actions) {
  el.modalTitle.textContent = title;
  el.modalBody.replaceChildren(...(Array.isArray(bodyNodes) ? bodyNodes : [bodyNodes]));
  el.modalActions.replaceChildren();
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + (a.kind === 'danger' ? 'btn-danger' : a.kind === 'secondary' ? 'btn-secondary' : 'btn-primary');
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    el.modalActions.appendChild(btn);
  }
  el.modalOverlay.classList.remove('hidden');
}

function closeModal() {
  el.modalOverlay.classList.add('hidden');
  el.modalBody.replaceChildren();
  el.modalActions.replaceChildren();
}

// Клик по затемнению закрывает модалку; Escape тоже
el.modalOverlay.addEventListener('click', function (e) {
  if (e.target === el.modalOverlay) closeModal();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && isModalOpen()) closeModal();
});

function showInlineError(node, message) {
  node.textContent = message;
  node.classList.remove('hidden');
}

function hideInlineError(node) {
  node.classList.add('hidden');
  node.textContent = '';
}

/* ---------- 8. Toast ---------- */
let toastTimer = null;
function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    el.toast.classList.add('hidden');
  }, 2500);
}

/* ---------- 9. Фатальная ошибка ---------- */
function showFatal(message) {
  el.fatalMessage.textContent = message;
  el.fatalOverlay.classList.remove('hidden');
}

function hideFatal() {
  el.fatalOverlay.classList.add('hidden');
}

el.fatalRetry.addEventListener('click', function () {
  hideFatal();
  init();
});

function handleError(err) {
  if (err && err.status === 401) {
    showFatal(err.message);
    return;
  }
  if (err && err.message) {
    showToast(err.message);
  }
}

/* ---------- 10. Рендер шапки и прав ---------- */
function renderUser() {
  if (!state.me) return;
  el.appUser.replaceChildren();
  const name = document.createElement('span');
  name.textContent = state.me.firstName;
  el.appUser.appendChild(name);
  if (state.me.isOwner) {
    const badge = document.createElement('span');
    badge.className = 'owner-badge';
    badge.textContent = 'владелец';
    el.appUser.appendChild(badge);
  }
}

function renderOwnerUI() {
  // Кнопка действий с вкладкой нужна только когда есть хотя бы одна вкладка.
  // Видимость пункта «Удалить вкладку» решается в openTabMenu по me.isOwner.
  el.tabActionsBtn.hidden = state.tabs.length === 0;
}

/* ---------- 11. Вкладки ---------- */
function tabsSignature() {
  return state.tabs.map(function (t) { return t.id + ':' + t.name + ':' + t.expenseCount; }).join('|');
}

function renderTabs() {
  const list = el.tabsList;
  list.replaceChildren();
  for (const tab of state.tabs) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tab-chip' + (tab.id === state.activeTabId ? ' active' : '');
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', tab.id === state.activeTabId ? 'true' : 'false');
    chip.textContent = tab.name;
    chip.addEventListener('click', function () { selectTab(tab.id); });
    list.appendChild(chip);
  }
  updateAddTabButton();
  renderOwnerUI();
  lastTabsSignature = tabsSignature();
}

function updateAddTabButton() {
  const atLimit = state.tabs.length >= TAB_LIMIT;
  el.addTabBtn.disabled = atLimit;
  el.addTabBtn.textContent = atLimit ? 'Достигнут лимит в 10 вкладок' : '+ Добавить вкладку';
}

function selectTab(tabId) {
  if (tabId === state.activeTabId) return;
  state.activeTabId = tabId;
  renderTabs();
  loadExpenses(tabId);
}

/* ---------- 12. Валидация названия вкладки ---------- */
function validateTabName(name, excludeId) {
  if (!name) return 'Название не может быть пустым';
  const norm = name.toLowerCase();
  const duplicate = state.tabs.some(function (t) {
    return t.id !== excludeId && t.name.toLowerCase() === norm;
  });
  if (duplicate) return 'Вкладка с таким названием уже существует';
  return null;
}

/* ---------- 13. Диалоги: добавление / переименование / меню вкладки ---------- */
function openAddTab() {
  if (state.tabs.length >= TAB_LIMIT) {
    showToast('Достигнут лимит в 10 вкладок');
    return;
  }
  openNameDialog({
    title: 'Новая вкладка',
    initial: '',
    confirmLabel: 'Создать',
    validate: function (name) { return validateTabName(name, null); },
    onSubmit: async function (name) {
      const res = await api('/api/tabs', { method: 'POST', body: JSON.stringify({ name: name }) });
      state.tabs.push(res.tab);
      state.activeTabId = res.tab.id;
      renderTabs();
      closeModal();
      await loadExpenses(res.tab.id);
      showToast('Вкладка создана');
    },
  });
}

function openRenameTab(tab) {
  openNameDialog({
    title: 'Переименовать вкладку',
    initial: tab.name,
    confirmLabel: 'Сохранить',
    validate: function (name) { return validateTabName(name, tab.id); },
    onSubmit: async function (name) {
      const res = await api('/api/tabs/' + tab.id, { method: 'PATCH', body: JSON.stringify({ name: name }) });
      const idx = state.tabs.findIndex(function (t) { return t.id === tab.id; });
      if (idx !== -1) state.tabs[idx] = res.tab;
      renderTabs();
      closeModal();
      showToast('Вкладка переименована');
    },
  });
}

// Общий диалог с одним текстовым полем
function openNameDialog(cfg) {
  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = 'Название вкладки';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field';
  input.placeholder = 'Название вкладки';
  input.maxLength = 200;
  input.value = cfg.initial || '';

  const err = document.createElement('div');
  err.className = 'form-error hidden';

  let busy = false;

  const submit = async function () {
    if (busy) return;
    const name = input.value.trim();
    const validationError = cfg.validate ? cfg.validate(name) : null;
    if (validationError) {
      showInlineError(err, validationError);
      input.focus();
      return;
    }
    hideInlineError(err);
    busy = true;
    try {
      await cfg.onSubmit(name);
    } catch (e) {
      busy = false;
      showInlineError(err, (e && e.message) || 'Ошибка');
    }
  };

  const primaryBtn = {
    label: cfg.confirmLabel,
    kind: 'primary',
    onClick: submit,
  };

  openModal(cfg.title, [label, input, err], [
    { label: 'Отмена', kind: 'secondary', onClick: closeModal },
    primaryBtn,
  ]);

  // Enter подтверждает; Esc закрывает (обработано глобально)
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  setTimeout(function () { input.focus(); }, 0);
}

function openTabMenu() {
  const tab = state.tabs.find(function (t) { return t.id === state.activeTabId; });
  if (!tab) return;

  const menu = document.createElement('div');
  menu.className = 'menu-list';

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'menu-item';
  renameBtn.textContent = 'Переименовать';
  renameBtn.addEventListener('click', function () {
    closeModal();
    openRenameTab(tab);
  });
  menu.appendChild(renameBtn);

  // Удаление — только для владельца
  if (state.me && state.me.isOwner) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'menu-item menu-item--danger';
    deleteBtn.textContent = 'Удалить вкладку';
    deleteBtn.addEventListener('click', function () {
      closeModal();
      openDeleteTab(tab);
    });
    menu.appendChild(deleteBtn);
  }

  openModal('Вкладка «' + tab.name + '»', menu, []);
}

function openDeleteTab(tab) {
  const count = tab.expenseCount || 0;
  const message = 'Во вкладке есть ' + count + ' записей. Удалить вкладку вместе со всеми записями? Действие необратимо.';
  openConfirm({
    title: 'Удалить вкладку?',
    message: message,
    confirmLabel: 'Удалить',
    danger: true,
    onSubmit: async function () {
      await api('/api/tabs/' + tab.id, { method: 'DELETE' });
      state.tabs = state.tabs.filter(function (t) { return t.id !== tab.id; });
      if (state.activeTabId === tab.id) {
        state.activeTabId = state.tabs.length ? state.tabs[0].id : null;
      }
      renderTabs();
      closeModal();
      if (state.activeTabId != null) {
        await loadExpenses(state.activeTabId);
      } else {
        state.expenses = [];
        state.totals = null;
        renderExpensesView();
      }
      showToast('Вкладка удалена');
    },
  });
}

/* ---------- 14. Диалог подтверждения ---------- */
function openConfirm(cfg) {
  const message = document.createElement('p');
  message.className = 'modal-message';
  message.textContent = cfg.message;

  const err = document.createElement('div');
  err.className = 'form-error hidden';

  let busy = false;

  openModal(cfg.title, [message, err], [
    { label: 'Отмена', kind: 'secondary', onClick: closeModal },
    {
      label: cfg.confirmLabel,
      kind: cfg.danger ? 'danger' : 'primary',
      onClick: async function () {
        if (busy) return;
        busy = true;
        try {
          await cfg.onSubmit();
        } catch (e) {
          busy = false;
          showInlineError(err, (e && e.message) || 'Ошибка');
        }
      },
    },
  ]);
}

/* ---------- 15. Записи (expenses) ---------- */
async function loadExpenses(tabId) {
  try {
    const data = await api('/api/tabs/' + tabId + '/expenses');
    // Игнорируем устаревший ответ, если вкладка уже сменилась
    if (tabId !== state.activeTabId) return;
    state.expenses = data.expenses;
    state.totals = data.totals;
    renderExpensesView();
  } catch (e) {
    handleError(e);
  }
}

function expensesSignature() {
  // activeTabId включён, чтобы при переключении вкладки всегда происходила перерисовка
  return state.activeTabId + '|' + JSON.stringify(state.expenses) + '|' + JSON.stringify(state.totals);
}

function renderExpensesView() {
  const sig = expensesSignature();
  if (sig === lastExpensesSignature) return;
  lastExpensesSignature = sig;
  renderExpenses();
  renderTotals();
}

function renderExpenses() {
  const list = el.expensesList;
  list.replaceChildren();

  const hasExpenses = state.expenses && state.expenses.length > 0;
  el.emptyState.classList.toggle('hidden', hasExpenses);

  if (!hasExpenses) return;

  const meId = state.me ? state.me.id : null;

  for (const expense of state.expenses) {
    list.appendChild(buildExpenseCard(expense, meId));
  }
}

function buildExpenseCard(expense, meId) {
  const card = document.createElement('article');
  card.className = 'expense-card';

  const top = document.createElement('div');
  top.className = 'expense-top';

  const title = document.createElement('div');
  title.className = 'expense-title';
  title.textContent = expense.title;
  top.appendChild(title);

  const amount = document.createElement('div');
  amount.className = 'expense-amount';
  amount.textContent = formatCents(expense.amountCents);
  top.appendChild(amount);

  card.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'expense-meta';

  const payer = document.createElement('span');
  payer.className = 'payer';
  payer.textContent = 'Оплатил: ' + expense.payer;
  meta.appendChild(payer);

  const date = document.createElement('span');
  date.textContent = formatDate(expense.createdAt);
  meta.appendChild(date);

  card.appendChild(meta);

  if (expense.comment) {
    const comment = document.createElement('div');
    comment.className = 'expense-comment';
    comment.textContent = expense.comment;
    card.appendChild(comment);
  }

  // Кнопка удаления — только у своих записей
  if (expense.createdByTgId === meId) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'expense-delete';
    deleteBtn.textContent = 'Удалить';
    deleteBtn.addEventListener('click', function () {
      openDeleteExpense(expense);
    });
    card.appendChild(deleteBtn);
  }

  return card;
}

function openDeleteExpense(expense) {
  openConfirm({
    title: 'Удалить запись?',
    message: 'Удалить запись «' + expense.title + '»? Действие необратимо.',
    confirmLabel: 'Удалить',
    danger: true,
    onSubmit: async function () {
      await api('/api/expenses/' + expense.id, { method: 'DELETE' });
      closeModal();
      // Пересчёт итогов
      await loadExpenses(state.activeTabId);
      showToast('Запись удалена');
    },
  });
}

/* ---------- 16. Итоги ---------- */
function renderTotals() {
  const t = state.totals || { totalCents: 0, denisCents: 0, alexeyCents: 0, kirillCents: 0 };
  el.badgeTotal.textContent = 'Общая сумма ' + formatCents(t.totalCents);
  el.badgeDenis.textContent = 'Денис ' + formatCents(t.denisCents);
  el.badgeAlexey.textContent = 'Алексей ' + formatCents(t.alexeyCents);
  el.badgeKirill.textContent = 'Кирилл ' + formatCents(t.kirillCents);
}

/* ---------- 17. Форма добавления записи ---------- */
function defaultPayer() {
  const firstName = ((TG && TG.user && TG.user.first_name) || (state.me && state.me.firstName) || '').trim();
  const norm = firstName.toLowerCase();
  const found = PAYERS.find(function (p) { return p.toLowerCase() === norm; });
  return found || 'Денис';
}

function setDefaultPayer() {
  el.payerSelect.value = defaultPayer();
}

// Стоимость: число > 0 и не более двух знаков после запятой
function isValidAmount(amount) {
  if (!Number.isFinite(amount)) return false;
  if (amount <= 0) return false;
  if (amount > 999999999.99) return false;
  return Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
}

el.expenseForm.addEventListener('submit', async function (e) {
  e.preventDefault();

  const title = el.titleInput.value.trim();
  const amountRaw = el.amountInput.value.trim().replace(',', '.');
  const payer = el.payerSelect.value;
  const comment = el.commentInput.value.trim();

  hideInlineError(el.formError);

  if (!title) {
    showInlineError(el.formError, 'Введите наименование');
    el.titleInput.focus();
    return;
  }

  const amount = Number(amountRaw);
  if (!amountRaw || Number.isNaN(amount)) {
    showInlineError(el.formError, 'Введите стоимость');
    el.amountInput.focus();
    return;
  }
  if (amount <= 0) {
    showInlineError(el.formError, 'Стоимость должна быть больше нуля');
    el.amountInput.focus();
    return;
  }
  if (!isValidAmount(amount)) {
    showInlineError(el.formError, 'Допустимо не более двух знаков после запятой');
    el.amountInput.focus();
    return;
  }
  if (!PAYERS.includes(payer)) {
    showInlineError(el.formError, 'Выберите, кто оплатил');
    return;
  }
  if (state.activeTabId == null) {
    showInlineError(el.formError, 'Сначала создайте вкладку');
    return;
  }

  try {
    await api('/api/tabs/' + state.activeTabId + '/expenses', {
      method: 'POST',
      body: JSON.stringify({ title: title, amount: amount, payer: payer, comment: comment }),
    });
    // Сброс формы и обновление списка с пересчётом итогов
    el.expenseForm.reset();
    setDefaultPayer();
    hideInlineError(el.formError);
    await loadExpenses(state.activeTabId);
    showToast('Запись добавлена');
  } catch (err) {
    showInlineError(el.formError, (err && err.message) || 'Ошибка');
  }
});

/* ---------- 18. Обработчики кнопок ---------- */
el.addTabBtn.addEventListener('click', openAddTab);
el.tabActionsBtn.addEventListener('click', openTabMenu);

/* ---------- 19. Опрос (polling) каждые 3 секунды ---------- */
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

async function poll() {
  // Не трогаем DOM, пока открыт диалог или показана фатальная ошибка
  if (isModalOpen()) return;
  if (!el.fatalOverlay.classList.contains('hidden')) return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA') && el.expenseForm.contains(active)) {
    // Пользователь вводит данные в форму — обновим данные следующим тиком
    return;
  }

  try {
    const tabsRes = await api('/api/tabs');
    state.tabs = tabsRes.tabs;

    // Если активной вкладки больше нет — берём первую оставшуюся
    if (!state.tabs.some(function (t) { return t.id === state.activeTabId; })) {
      state.activeTabId = state.tabs.length ? state.tabs[0].id : null;
    }

    // Перерисовываем вкладки только если что-то реально изменилось
    if (tabsSignature() !== lastTabsSignature) {
      renderTabs();
    } else {
      updateAddTabButton();
      renderOwnerUI();
    }

    if (state.activeTabId != null) {
      await loadExpenses(state.activeTabId);
    } else {
      state.expenses = [];
      state.totals = null;
      lastExpensesSignature = '';
      renderExpensesView();
    }
  } catch (e) {
    handleError(e);
  }
}

/* ---------- 20. Инициализация ---------- */
async function init() {
  applyTheme();
  renderTotals();

  try {
    // 1) /api/me
    const meRes = await api('/api/me');
    state.me = meRes.me;
    renderUser();
    setDefaultPayer();

    // 2) /api/tabs
    const tabsRes = await api('/api/tabs');
    state.tabs = tabsRes.tabs;
    state.activeTabId = state.tabs.length ? state.tabs[0].id : null;

    renderTabs();

    // 3) Записи активной вкладки
    if (state.activeTabId != null) {
      await loadExpenses(state.activeTabId);
    } else {
      renderExpensesView();
    }

    startPolling();
  } catch (e) {
    if (e && e.status === 401) {
      showFatal(e.message);
    } else {
      showFatal((e && e.message) || 'Не удалось загрузить данные');
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
