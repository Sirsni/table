import type Database from "better-sqlite3";

/**
 * Слой работы с БД поверх openDb (см. db.ts).
 * Все цены — integer-копейки. Имена столбцов snake_case как в схеме.
 */

/** Строка items_latest (view: items + последний snapshot). */
export interface ItemLatestRow {
  id: number;
  app_id: number;
  market_hash_name: string;
  item_nameid: number | null;
  icon_url: string | null;
  updated_at: string;
  provider: string;
  buy_order: number | null;
  sell_price: number | null;
  volume: number | null;
  currency: number | null;
  fetched_at: string;
}

export interface ItemRow {
  id: number;
  app_id: number;
  market_hash_name: string;
  item_nameid: number | null;
  icon_url: string | null;
  updated_at: string;
}

/**
 * Вставляет предмет или обновляет icon_url/updated_at при конфликте
 * (app_id, market_hash_name). Возвращает id предмета.
 */
export function upsertItem(
  db: Database.Database,
  appId: number,
  marketHashName: string,
  iconUrl: string | null,
): number {
  const row = db
    .prepare(
      `INSERT INTO items (app_id, market_hash_name, icon_url, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(app_id, market_hash_name) DO UPDATE SET
         icon_url = COALESCE(excluded.icon_url, items.icon_url),
         updated_at = datetime('now')
       RETURNING id`,
    )
    .get(appId, marketHashName, iconUrl) as { id: number };
  return row.id;
}

/** Сохраняет резолвленный item_nameid (кешируется навсегда). */
export function setItemNameId(
  db: Database.Database,
  itemId: number,
  itemNameId: number,
): void {
  db.prepare(
    `UPDATE items SET item_nameid = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(itemNameId, itemId);
}

export interface SnapshotInput {
  itemId: number;
  provider: string;
  buyOrder: number | null;
  sellPrice: number | null;
  volume: number | null;
  currency: number | null;
}

/** Пишет snapshot цен. fetched_at проставляется БД по умолчанию. */
export function insertSnapshot(
  db: Database.Database,
  snap: SnapshotInput,
): void {
  db.prepare(
    `INSERT INTO price_snapshots (item_id, provider, buy_order, sell_price, volume, currency)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    snap.itemId,
    snap.provider,
    snap.buyOrder,
    snap.sellPrice,
    snap.volume,
    snap.currency,
  );
}

/** Предметы без item_nameid — кандидаты на резолв. */
export function listItemsNeedingNameId(
  db: Database.Database,
  appId: number,
  limit: number,
): ItemRow[] {
  return db
    .prepare(
      `SELECT id, app_id, market_hash_name, item_nameid, icon_url, updated_at
       FROM items
       WHERE app_id = ? AND item_nameid IS NULL
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(appId, limit) as ItemRow[];
}

/**
 * Предметы для обновления цен: те, у кого нет ни одного snapshot — первыми,
 * затем по давности последнего snapshot (старые сначала). Новый рынок Steam
 * работает по имени, поэтому item_nameid не требуется.
 */
export function listItemsForPriceUpdate(
  db: Database.Database,
  appId: number,
  limit: number,
): ItemRow[] {
  return db
    .prepare(
      `SELECT i.id, i.app_id, i.market_hash_name, i.item_nameid, i.icon_url, i.updated_at
       FROM items i
       LEFT JOIN (
         SELECT item_id, MAX(fetched_at) AS last_fetched
         FROM price_snapshots
         GROUP BY item_id
       ) s ON s.item_id = i.id
       WHERE i.app_id = ?
       ORDER BY (s.last_fetched IS NULL) DESC, s.last_fetched ASC, i.id ASC
       LIMIT ?`,
    )
    .all(appId, limit) as ItemRow[];
}

/**
 * Предметы для обновления истории продаж (item_stats): сперва те, у кого нет
 * записи в item_stats, затем по давности item_stats.fetched_at (старые сначала).
 * Аналог listItemsForPriceUpdate.
 */
export function listItemsForHistoryUpdate(
  db: Database.Database,
  appId: number,
  limit: number,
): ItemRow[] {
  return db
    .prepare(
      `SELECT i.id, i.app_id, i.market_hash_name, i.item_nameid, i.icon_url, i.updated_at
       FROM items i
       LEFT JOIN item_stats st ON st.item_id = i.id
       WHERE i.app_id = ?
       ORDER BY (st.item_id IS NULL) DESC, st.fetched_at ASC, i.id ASC
       LIMIT ?`,
    )
    .all(appId, limit) as ItemRow[];
}

export interface ItemStatsInput {
  sales7d: number;
  sales30d: number;
  avg7d: number | null;
  avg30d: number | null;
  lastPrice: number | null;
  lastDate: string | null;
  currency: number;
}

/**
 * Вставляет/обновляет агрегаты ликвидности предмета (item_stats).
 * fetched_at всегда переписывается на текущее время.
 */
export function upsertItemStats(
  db: Database.Database,
  itemId: number,
  stats: ItemStatsInput,
): void {
  db.prepare(
    `INSERT INTO item_stats
       (item_id, sales_7d, sales_30d, avg_7d, avg_30d, last_price, last_date, currency, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(item_id) DO UPDATE SET
       sales_7d = excluded.sales_7d,
       sales_30d = excluded.sales_30d,
       avg_7d = excluded.avg_7d,
       avg_30d = excluded.avg_30d,
       last_price = excluded.last_price,
       last_date = excluded.last_date,
       currency = excluded.currency,
       fetched_at = datetime('now')`,
  ).run(
    itemId,
    stats.sales7d,
    stats.sales30d,
    stats.avg7d,
    stats.avg30d,
    stats.lastPrice,
    stats.lastDate,
    stats.currency,
  );
}

/**
 * Топ предметов по последнему snapshot (items_latest). Маржу считает
 * вызывающий через economics — здесь возвращаем сырые поля.
 * Берём только строки, где есть обе цены (buy_order и sell_price).
 */
export function topByMargin(
  db: Database.Database,
  appId: number,
  limit: number,
): ItemLatestRow[] {
  return db
    .prepare(
      `SELECT id, app_id, market_hash_name, item_nameid, icon_url, updated_at,
              provider, buy_order, sell_price, volume, currency, fetched_at
       FROM items_latest
       WHERE app_id = ? AND buy_order IS NOT NULL AND sell_price IS NOT NULL
       LIMIT ?`,
    )
    .all(appId, limit) as ItemLatestRow[];
}
