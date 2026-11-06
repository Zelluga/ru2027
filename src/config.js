// config.js — загрузка конфигурации из .env (простой парсер без внешних зависимостей)
// и переменных окружения. Только встроенные модули Node 24.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень проекта = каталог на уровень выше src/
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

// Простой парсер .env: строки KEY=VALUE, комментарии (#) и пустые строки пропускаются,
// поддерживаются необязательный префикс "export " и кавычки вокруг значения.
function parseEnvFile(filePath) {
  const map = {};
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return map; // .env отсутствует — это не ошибка
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    let key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    if (
      (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) ||
      (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

const fileEnv = parseEnvFile(ENV_FILE);

// Приоритет: реальная переменная окружения > значение из .env > значение по умолчанию.
function getEnv(key, fallback = '') {
  if (process.env[key] !== undefined && process.env[key] !== null) return process.env[key];
  if (Object.prototype.hasOwnProperty.call(fileEnv, key)) return fileEnv[key];
  return fallback;
}

function toBool(value) {
  return (
    value === true ||
    value === '1' ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 'yes' ||
    value === 'on'
  );
}

function toPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 8787;
}

// ALLOWED_TG_IDS — список через запятую; пусто = без ограничения.
const ALLOWED_TG_IDS = String(getEnv('ALLOWED_TG_IDS', ''))
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '')
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n) && n > 0);

const OWNER_USERNAME = String(getEnv('OWNER_USERNAME', 'Depenz')).trim() || 'Depenz';

export const config = {
  BOT_TOKEN: String(getEnv('BOT_TOKEN', '')),
  OWNER_USERNAME,
  OWNER_TG_ID: String(getEnv('OWNER_TG_ID', '')).trim(),
  ALLOWED_TG_IDS,
  HOST: String(getEnv('HOST', '0.0.0.0')).trim() || '0.0.0.0',
  PORT: toPort(getEnv('PORT', '8787')),
  DB_PATH: String(getEnv('DB_PATH', './data/app.db')).trim() || './data/app.db',
  AUTH_MAX_AGE_SECONDS: Math.max(1, Number(getEnv('AUTH_MAX_AGE_SECONDS', '86400')) || 86400),
  DEV_MODE: toBool(getEnv('DEV_MODE', '0')),
};
