// db.js — открытие/создание SQLite (node:sqlite DatabaseSync), схема из контракта и сид.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config, PROJECT_ROOT } from './config.js';

const rawPath = config.DB_PATH;
const dbPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(PROJECT_ROOT, rawPath);

// Создаём каталог data/ (и любые промежуточные) при необходимости.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const DB_PATH = dbPath;
export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
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
`);

// Сид при первом запуске: ровно две вкладки по порядку, обе с created_by_tg_id = 0.
const countRow = db.prepare('SELECT COUNT(*) AS c FROM tabs').get();
if (Number(countRow.c) === 0) {
  const insert = db.prepare('INSERT INTO tabs (name, created_by_tg_id, created_at) VALUES (?, ?, ?)');
  insert.run('Падл-пенис', 0, new Date().toISOString());
  insert.run('Сука,Сочи', 0, new Date().toISOString());
}
