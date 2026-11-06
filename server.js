// server.js — входная точка: HTTP-сервер, роутинг и раздача статики public/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { db, DB_PATH } from './src/db.js';
import { handleApi } from './src/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Статика отдаётся БЕЗ initData.
const STATIC_ROUTES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, route) {
  const filePath = path.join(PUBLIC_DIR, route.file);
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — файл не найден');
    return;
  }
  res.writeHead(200, { 'Content-Type': route.type, 'Content-Length': content.length });
  res.end(content);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        console.error('Необработанная ошибка API:', err);
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } });
      });
      return;
    }

    const route = STATIC_ROUTES[pathname];
    if (route) {
      serveStatic(res, route);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — не найдено');
  } catch (err) {
    console.error('Ошибка сервера:', err);
    try {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } });
    } catch {
      /* игнорируем */
    }
  }
});

server.listen(config.PORT, config.HOST, () => {
  if (config.DEV_MODE) {
    console.warn('⚠ DEV_MODE=1: проверка подписи initData ОТКЛЮЧЕНА (только для локальной разработки).');
  }
  console.log(`База данных: ${DB_PATH}`);
  console.log(`Сервер «2027» запущен: http://${config.HOST}:${config.PORT}`);
});
