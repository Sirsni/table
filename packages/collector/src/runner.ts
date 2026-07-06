import type Database from "better-sqlite3";
import type { SteamHttp } from "./steam/http.js";
import { SteamHttpError } from "./steam/http.js";
import { fetchMarketPage, MARKET_PAGE_SIZE } from "./steam/searchRender.js";
import { fetchOrderBook } from "./steam/orderbook.js";
import { fetchPriceHistory } from "./steam/pricehistory.js";
import { computeStats } from "./stats.js";
import {
  upsertItem,
  insertSnapshot,
  listItemsForPriceUpdate,
  listItemsForHistoryUpdate,
  upsertItemStats,
  replaceItemPoints,
} from "./repo.js";

/**
 * Ядро сбора, вынесенное из CLI, чтобы его могли вызывать и консоль (index.ts),
 * и сервер (collectorService). Логирование вынесено в onProgress: вызывающий
 * сам решает, печатать ли прогресс в консоль или обновлять состояние задачи.
 */

const PROVIDER = "steam";

// Предохранитель: после стольких 429 подряд проход останавливается сам —
// при бане Steam продолжать бессмысленно и вредно (углубляет бан).
const RATE_LIMIT_TRIP = 8;
const RATE_LIMIT_MESSAGE =
  "Steam вернул 429 (лимит запросов) — похоже, IP временно забанен. Сбор " +
  "остановлен автоматически. Подожди несколько минут и снизь параллельность " +
  "или увеличь интервал.";

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
  /** Заполняется, если проход остановлен предохранителем (например, 429). */
  stoppedReason?: string;
}

export interface SyncItemsOptions {
  app: number;
  /** Не задано -> синхронизируем ВЕСЬ каталог (все страницы по total_count). */
  pages?: number;
  onProgress?: (p: CollectProgress) => void;
  signal?: AbortSignal;
}

export interface UpdatePricesOptions {
  app: number;
  /** Не задано -> обновляем цены по ВСЕМ предметам. */
  limit?: number;
  currency?: number;
  onProgress?: (p: CollectProgress) => void;
  signal?: AbortSignal;
}

export interface EnrichHistoryOptions {
  app: number;
  /** Не задано -> обновляем историю по ВСЕМ предметам. */
  limit?: number;
  currency?: number;
  onProgress?: (p: CollectProgress) => void;
  signal?: AbortSignal;
}

/**
 * Внутренний контроллер отмены, связанный с внешним signal: срабатывает и при
 * нажатии «Стоп» (внешний), и при срабатывании предохранителя (внутренний
 * abort). Его signal прокидывается в HTTP-слой, чтобы прерывать запросы и паузы.
 */
function linkedController(external?: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl;
}

function isRateLimit(err: unknown): boolean {
  return err instanceof SteamHttpError && err.status === 429;
}

/**
 * Загружает список предметов рынка (search/render) и upsert-ит их в БД.
 * Первая страница даёт total_count, остальные страницы тянутся пулом воркеров
 * (размер = http.concurrency). Отмена (signal/«Стоп») и предохранитель 429
 * мгновенно прерывают запросы и паузы.
 */
/**
 * Загружает список предметов рынка (search/render) ПОСЛЕДОВАТЕЛЬНО и upsert-ит
 * их в БД. Steam отдаёт total_count огромным (десятки тысяч), но реально на
 * глубоких страницах возвращает пустой results (200, items=[]), особенно под
 * параллельной нагрузкой — поэтому идём по страницам по порядку и ОСТАНАВЛИВАЕМСЯ
 * после нескольких подряд пустых страниц (а не молотим все offset'ы до
 * total_count, выжигая лимит). Параллельность тут намеренно не используется:
 * она провоцирует пустые ответы и тратит квоту. Отмена/429-предохранитель — как
 * везде. total в прогрессе = реально собранное (total_count недостижим и сбивает).
 */
export async function syncItems(
  db: Database.Database,
  http: SteamHttp,
  opts: SyncItemsOptions,
): Promise<CollectSummary> {
  const { app, pages, onProgress } = opts;
  const ctrl = linkedController(opts.signal);

  let processed = 0;
  let ok = 0;
  let fail = 0;
  let lastName: string | null = null;
  let rateLimited = 0;
  let stoppedReason: string | undefined;

  const emit = () => {
    // total = processed: реальная цель неизвестна (total_count недостижим).
    onProgress?.({ processed, total: processed, ok, fail, lastName });
  };

  const STOP_AFTER_EMPTY = 5; // столько пустых страниц подряд = конец выдачи
  const maxPages = pages != null ? pages : Infinity;

  let pageIndex = 0;
  let start = 0;
  let consecutiveEmpty = 0;

  while (!ctrl.signal.aborted && pageIndex < maxPages) {
    let page;
    try {
      page = await fetchMarketPage(http, app, start, ctrl.signal);
      rateLimited = 0; // успех сбрасывает счётчик 429
    } catch (err) {
      if (ctrl.signal.aborted) break;
      fail++;
      if (isRateLimit(err)) {
        rateLimited++;
        if (rateLimited >= RATE_LIMIT_TRIP) {
          stoppedReason = RATE_LIMIT_MESSAGE;
          break;
        }
      }
      // прочая ошибка страницы — двигаемся дальше
      start += MARKET_PAGE_SIZE;
      pageIndex += 1;
      emit();
      continue;
    }

    if (page.items.length === 0) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= STOP_AFTER_EMPTY) break; // выдача иссякла
    } else {
      consecutiveEmpty = 0;
      for (const item of page.items) {
        lastName = item.marketHashName;
        try {
          upsertItem(db, app, item.marketHashName, item.iconUrl);
          ok++;
        } catch {
          fail++;
        }
        processed += 1;
      }
      emit();
    }

    start += MARKET_PAGE_SIZE;
    pageIndex += 1;
    // total_count как верхняя граница (если вдруг дошли).
    if (page.totalCount !== null && start >= page.totalCount) break;
  }

  return { ok, fail, processed, stoppedReason };
}

/**
 * Обновляет цены: берёт предметы из listItemsForPriceUpdate и тянет стакан
 * для каждого пулом воркеров (размер = http.concurrency). Отмена (signal/«Стоп»)
 * и предохранитель 429 мгновенно прерывают запросы и паузы.
 */
export async function updatePrices(
  db: Database.Database,
  http: SteamHttp,
  opts: UpdatePricesOptions,
): Promise<CollectSummary> {
  const { app, limit, onProgress } = opts;
  const currency = opts.currency ?? 1; // по умолчанию USD — не зависит от гео-IP
  const ctrl = linkedController(opts.signal);

  const items = listItemsForPriceUpdate(db, app, limit);
  const total = items.length;
  let processed = 0;
  let ok = 0;
  let fail = 0;
  let lastName: string | null = null;
  let rateLimited = 0;
  let stoppedReason: string | undefined;

  const emit = () => {
    onProgress?.({ processed, total, ok, fail, lastName });
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (!ctrl.signal.aborted) {
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
          ctrl.signal,
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
        rateLimited = 0; // успех сбрасывает счётчик 429
      } catch (err) {
        if (ctrl.signal.aborted) return; // отмена — не считаем
        fail++;
        if (isRateLimit(err)) {
          rateLimited++;
          if (rateLimited >= RATE_LIMIT_TRIP) {
            stoppedReason = RATE_LIMIT_MESSAGE;
            ctrl.abort();
          }
        }
      }
      processed++;
      emit();
    }
  };

  const poolSize = Math.max(1, Math.min(http.concurrency, total || 1));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return { ok, fail, processed, stoppedReason };
}

/**
 * Обновляет историю продаж/ликвидность: берёт предметы из
 * listItemsForHistoryUpdate, для каждого тянет pricehistory, считает агрегаты
 * (computeStats) и пишет их в item_stats. Пул воркеров (размер = http.concurrency),
 * отмена (signal/«Стоп») и предохранитель 429 — как в updatePrices.
 *
 * pricehistory требует STEAM_COOKIE; без него fetchPriceHistory бросит понятную
 * ошибку — она считается обычным fail предмета (а не 429), проход не валится.
 */
export async function enrichHistory(
  db: Database.Database,
  http: SteamHttp,
  opts: EnrichHistoryOptions,
): Promise<CollectSummary> {
  const { app, limit, onProgress } = opts;
  const currency = opts.currency ?? 1; // валюта запроса истории (1 = USD)
  const ctrl = linkedController(opts.signal);

  const items = listItemsForHistoryUpdate(db, app, limit);
  const total = items.length;
  let processed = 0;
  let ok = 0;
  let fail = 0;
  let lastName: string | null = null;
  let rateLimited = 0;
  let stoppedReason: string | undefined;
  let lastErrMsg: string | undefined;

  const emit = () => {
    onProgress?.({ processed, total, ok, fail, lastName });
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (!ctrl.signal.aborted) {
      const i = next++;
      if (i >= items.length) return;
      const it = items[i];
      lastName = it.market_hash_name;
      try {
        const history = await fetchPriceHistory(
          http,
          app,
          it.market_hash_name,
          currency,
          ctrl.signal,
        );
        const stats = computeStats(history.points);
        replaceItemPoints(
          db,
          it.id,
          history.points.map((p) => ({
            ts: Math.floor(p.date.getTime() / 1000),
            price: p.priceCents,
            qty: p.qty,
          })),
          currency,
        );
        upsertItemStats(db, it.id, { ...stats, currency });
        ok++;
        rateLimited = 0; // успех сбрасывает счётчик 429
      } catch (err) {
        if (ctrl.signal.aborted) return; // отмена — не считаем
        fail++;
        lastErrMsg = err instanceof Error ? err.message : String(err);
        if (isRateLimit(err)) {
          rateLimited++;
          if (rateLimited >= RATE_LIMIT_TRIP) {
            stoppedReason = RATE_LIMIT_MESSAGE;
            ctrl.abort();
          }
        }
      }
      processed++;
      emit();
    }
  };

  const poolSize = Math.max(1, Math.min(http.concurrency, total || 1));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  // Если не получили НИ ОДНОЙ истории — показываем причину (чаще всего cookie).
  if (!stoppedReason && ok === 0 && fail > 0 && lastErrMsg) {
    stoppedReason = `История не собрана ни по одному предмету. Причина: ${lastErrMsg}`;
  }

  return { ok, fail, processed, stoppedReason };
}
