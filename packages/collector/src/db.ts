import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Путь к БД по умолчанию — относительно КОРНЯ репозитория, а не текущей рабочей
// папки. Иначе `npm run -w <pkg>` (cwd = папка пакета) писал бы каждый пакет в
// свой data/, и сервер не видел бы данные, собранные CLI коллектора.
// db.ts лежит в packages/collector/{src,dist}/ — корень на 3 уровня выше.
const DEFAULT_DB_PATH = fileURLToPath(
  new URL("../../../data/table.sqlite", import.meta.url),
);

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  market_hash_name TEXT NOT NULL,
  item_nameid INTEGER,
  icon_url TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(app_id, market_hash_name)
);
CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  provider TEXT NOT NULL,
  buy_order INTEGER,
  sell_price INTEGER,
  volume INTEGER,
  currency INTEGER,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item_time ON price_snapshots(item_id, fetched_at DESC);
CREATE TABLE IF NOT EXISTS item_stats (
  item_id INTEGER PRIMARY KEY REFERENCES items(id),
  sales_7d INTEGER,
  sales_30d INTEGER,
  avg_7d INTEGER,
  avg_30d INTEGER,
  last_price INTEGER,
  last_date TEXT,
  currency INTEGER,
  median_7d INTEGER,
  median_30d INTEGER,
  p25_30d INTEGER,
  volatility_pct REAL,
  baseline_price INTEGER,
  recent_price INTEGER,
  boost_score REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS price_points (
  item_id INTEGER NOT NULL REFERENCES items(id),
  ts INTEGER NOT NULL,            -- unix-секунды точки
  price INTEGER NOT NULL,         -- в минимальных единицах валюты currency
  qty INTEGER NOT NULL,
  currency INTEGER,
  PRIMARY KEY (item_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_points_item ON price_points(item_id);
`;

// View пересоздаём всегда: тело могло измениться между версиями (добавили currency).
const VIEW_SQL = `
DROP VIEW IF EXISTS items_latest;
CREATE VIEW items_latest AS
  SELECT i.*, s.provider, s.buy_order, s.sell_price, s.volume, s.currency, s.fetched_at
  FROM items i
  JOIN price_snapshots s ON s.id = (
    SELECT id FROM price_snapshots WHERE item_id = i.id ORDER BY fetched_at DESC, id DESC LIMIT 1
  );
`;

/**
 * Идемпотентно добавляет колонку currency в price_snapshots, если её ещё нет
 * (CREATE TABLE IF NOT EXISTS не меняет существующую таблицу).
 */
function ensureCurrencyColumn(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(price_snapshots)`)
    .all() as Array<{ name: string }>;
  const hasCurrency = cols.some((c) => c.name === "currency");
  if (!hasCurrency) {
    db.exec(`ALTER TABLE price_snapshots ADD COLUMN currency INTEGER;`);
  }
}

/**
 * Идемпотентно добавляет новые колонки метрик в item_stats на существующих БД
 * (CREATE TABLE IF NOT EXISTS не меняет уже созданную таблицу). Новые БД получают
 * их сразу из CREATE TABLE — тогда эта функция просто ничего не делает.
 */
function ensureItemStatsColumns(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(item_stats)`)
    .all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  const wanted: Array<[string, string]> = [
    ["median_7d", "INTEGER"],
    ["median_30d", "INTEGER"],
    ["p25_30d", "INTEGER"],
    ["volatility_pct", "REAL"],
    ["baseline_price", "INTEGER"],
    ["recent_price", "INTEGER"],
    ["boost_score", "REAL"],
  ];
  for (const [name, type] of wanted) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE item_stats ADD COLUMN ${name} ${type};`);
    }
  }
}

export function openDb(path?: string): Database.Database {
  const dbPath = path ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(MIGRATION_SQL);
  // Миграция существующих БД: добавить currency до пересоздания view,
  // иначе view сошлётся на несуществующую колонку.
  ensureCurrencyColumn(db);
  // Новые метрики item_stats (median/percentile/volatility/boost) на старых БД.
  ensureItemStatsColumns(db);
  db.exec(VIEW_SQL);

  return db;
}
