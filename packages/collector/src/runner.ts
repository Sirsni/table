import type Database from "better-sqlite3";
import type { SteamHttp } from "./steam/http.js";
import {
  fetchMarketPage,
  MARKET_PAGE_SIZE,
} from "./steam/searchRender.js";
import type { MarketSearchItem } from "./steam/searchRender.js";
import { fetchOrderBook } from "./steam/orderbook.js";
import { upsertItem, insertSnapshot, listItemsForPriceUpdate } from "./repo.js";

/**
 * Ядро сбора, вынесенное из CLI, чтобы его могли вызывать и консоль (index.ts),
 * и сервер (collectorService). Логирование вынесено в onProgress: вызывающий
 * сам решает, печатать ли прогресс в консоль или обновлять состояние задачи.
 */

const PROVIDER = "steam";

/** Прогресс сбора. total для sync неизвестен заранее (пагинация) — равен processed. */
export interface CollectProgress {
  processed: number;
  total: number;
  ok: number;
  fail: number;
  lastName: string | null;
}

export interface CollectSummary {
  ok: number;
  fail: number;
  processed: number;
}

export interface SyncItemsOptions {
  app: number;
  pages: number;
  onProgress?: (p: CollectProgress) => void;
  signal?: AbortSignal;
}

export interface UpdatePricesOptions {
  app: number;
  limit: number;
  currency?: number;
  onProgress?: (p: CollectProgress) => void;
  signal?: AbortSignal;
}

/**
 * Загружает список предметов рынка (search/render) и upsert-ит их в БД.
 * Первая страница даёт total_count, остальные страницы тянутся пулом воркеров
 * (размер = http.concurrency), чтобы синхронизация тоже использовала заданную
 * скорость, а не шла строго по странице за раз. total известен (из total_count,
 * ограничен pages*100). При signal.aborted воркеры перестают брать новые страницы.
 */
export async function syncItems(
  db: Database.Database,
  http: SteamHttp,
  opts: SyncItemsOptions,
): Promise<CollectSummary> {
  const { app, pages, onProgress, signal } = opts;
  let processed = 0;
  let ok = 0;
  let fail = 0;
  let lastName: string | null = null;
  let total = 0;

  const emit = () => {
    onProgress?.({ processed, total, ok, fail, lastName });
  };

  const upsertItems = (items: MarketSearchItem[]) => {
    for (const item of items) {
      lastName = item.marketHashName;
      try {
        upsertItem(db, app, item.marketHashName, item.iconUrl);
        ok++;
      } catch {
        // Сбой записи одного предмета не должен ронять весь проход.
        fail++;
      }
      processed++;
    }
    emit();
  };

  // Первая страница: получаем total_count и первые предметы.
  const first = await fetchMarketPage(http, app, 0);
  const totalItems = Math.min(
    first.totalCount ?? first.items.length,
    pages * MARKET_PAGE_SIZE,
  );
  total = totalItems;
  upsertItems(first.items);

  if (signal?.aborted || first.items.length === 0) {
    return { ok, fail, processed };
  }

  // Оффсеты остальных страниц.
  const offsets: number[] = [];
  for (let s = MARKET_PAGE_SIZE; s < totalItems; s += MARKET_PAGE_SIZE) {
    offsets.push(s);
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= offsets.length) return;
      try {
        const page = await fetchMarketPage(http, app, offsets[i]);
        upsertItems(page.items);
      } catch {
        fail++;
        emit();
      }
    }
  };

  const poolSize = Math.max(
    1,
    Math.min(http.concurrency, offsets.length || 1),
  );
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return { ok, fail, processed };
}

/**
 * Обновляет цены: берёт предметы из listItemsForPriceUpdate и тянет стакан
 * для каждого. Запросы идут пулом воркеров (размер = http.concurrency), чтобы
 * параллельность реально использовалась — иначе последовательный await сводил
 * бы очередь к одному запросу за раз. Темп между запросами задаёт интервал-
 * троттл внутри SteamHttp. Ошибку по предмету ловим (fail++). При signal.aborted
 * воркеры перестают забирать новые предметы (запросы «в полёте» дорабатывают).
 */
export async function updatePrices(
  db: Database.Database,
  http: SteamHttp,
  opts: UpdatePricesOptions,
): Promise<CollectSummary> {
  const { app, limit, onProgress, signal } = opts;
  const currency = opts.currency ?? 1; // по умолчанию USD — не зависит от гео-IP

  const items = listItemsForPriceUpdate(db, app, limit);
  const total = items.length;
  let processed = 0;
  let ok = 0;
  let fail = 0;
  let lastName: string | null = null;

  const emit = () => {
    onProgress?.({ processed, total, ok, fail, lastName });
  };

  // Общий курсор: каждый воркер берёт следующий предмет.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      const it = items[i];
      lastName = it.market_hash_name;
      try {
        const ob = await fetchOrderBook(
          http,
          app,
          it.market_hash_name,
          currency,
        );
        insertSnapshot(db, {
          itemId: it.id,
          provider: PROVIDER,
          buyOrder: ob.highestBuyOrder,
          sellPrice: ob.lowestSellOrder,
          volume: ob.sellOrderCount, // кол-во лотов на продажу — прокси ликвидности
          currency: ob.currency,
        });
        ok++;
      } catch {
        fail++;
      }
      processed++;
      emit();
    }
  };

  const poolSize = Math.max(1, Math.min(http.concurrency, total || 1));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return { ok, fail, processed };
}
