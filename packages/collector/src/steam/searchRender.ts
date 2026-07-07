import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SteamHttp } from "./http.js";

// Отладочный лог сырых ответов search/render (пустые/битые страницы) — чтобы
// разбирать «тихие» остановки синхронизации по фактическим телам ответов.
// dist/steam/searchRender.js -> 4 уровня вверх = корень репозитория.
const DEBUG_LOG_PATH = fileURLToPath(
  new URL("../../../../data/sync-debug.log", import.meta.url),
);

function debugLog(line: string): void {
  try {
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
    appendFileSync(DEBUG_LOG_PATH, line + "\n");
  } catch {
    /* отладка не должна ронять сбор */
  }
}

export interface MarketSearchItem {
  marketHashName: string;
  /** Минимальная цена продажи в центах валюты ответа, либо null. */
  sellPrice: number | null;
  sellListings: number;
  iconUrl: string | null;
}

interface RenderResultRaw {
  hash_name?: string;
  sell_price?: number | null;
  sell_listings?: number | null;
  asset_description?: {
    market_hash_name?: string;
    icon_url?: string;
  } | null;
}

interface RenderResponseRaw {
  success?: boolean;
  total_count?: number;
  results?: RenderResultRaw[] | null;
}

const PAGE_SIZE = 100;

function buildUrl(appId: number, start: number): string {
  const params = new URLSearchParams({
    appid: String(appId),
    norender: "1",
    count: String(PAGE_SIZE),
    start: String(start),
    sort_column: "popular",
    sort_dir: "desc",
  });
  return `https://steamcommunity.com/market/search/render/?${params.toString()}`;
}

function mapResult(r: RenderResultRaw): MarketSearchItem | null {
  const name = r.asset_description?.market_hash_name ?? r.hash_name;
  if (!name) return null; // без имени предмет бесполезен
  return {
    marketHashName: name,
    sellPrice:
      typeof r.sell_price === "number" && Number.isFinite(r.sell_price)
        ? r.sell_price
        : null,
    sellListings:
      typeof r.sell_listings === "number" && Number.isFinite(r.sell_listings)
        ? r.sell_listings
        : 0,
    iconUrl: r.asset_description?.icon_url ?? null,
  };
}

export interface MarketPage {
  items: MarketSearchItem[];
  /** Всего предметов в выдаче (для расчёта числа страниц), либо null. */
  totalCount: number | null;
}

export const MARKET_PAGE_SIZE = PAGE_SIZE;

/**
 * Загружает одну страницу выдачи рынка (start..start+100). Один повтор при
 * success:false / null results, затем ошибка.
 */
export async function fetchMarketPage(
  http: SteamHttp,
  appId: number,
  start: number,
  signal?: AbortSignal,
): Promise<MarketPage> {
  const url = buildUrl(appId, start);
  for (let attempt = 0; attempt < 2; attempt++) {
    // Берём сырой текст (не getJson), чтобы при пустых/битых ответах записать
    // фактическое тело в data/sync-debug.log для разбора.
    const text = await http.getText(url, signal);
    let resp: RenderResponseRaw | null = null;
    try {
      resp = JSON.parse(text) as RenderResponseRaw;
    } catch {
      debugLog(
        `${new Date().toISOString()} start=${start} NOT_JSON body=${text.slice(0, 800)}`,
      );
    }
    if (resp && resp.success !== false && Array.isArray(resp.results)) {
      const items: MarketSearchItem[] = [];
      for (const r of resp.results) {
        const it = mapResult(r);
        if (it) items.push(it);
      }
      if (items.length === 0) {
        // Пустая страница — главный подозреваемый «тихих» остановок: пишем
        // сырое тело целиком (обрезано), чтобы видеть total_count/поля заглушки.
        debugLog(
          `${new Date().toISOString()} start=${start} EMPTY body=${text.slice(0, 800)}`,
        );
      }
      return {
        items,
        totalCount:
          typeof resp.total_count === "number" ? resp.total_count : null,
      };
    }
    debugLog(
      `${new Date().toISOString()} start=${start} BAD success=${resp?.success} body=${text.slice(0, 800)}`,
    );
    if (attempt === 0) {
      console.warn(
        `[search] страница start=${start} вернула success=${resp?.success} / results=${
          Array.isArray(resp?.results) ? "ok" : "null"
        }, повтор`,
      );
      continue;
    }
    throw new Error(
      `search/render отдал некорректный ответ для start=${start} (success=${resp?.success})`,
    );
  }
  // недостижимо: цикл либо вернул страницу, либо бросил
  throw new Error(`search/render: не удалось загрузить start=${start}`);
}

/**
 * Постранично перебирает предметы рынка для appId (последовательно).
 * Останавливается, когда start >= total_count или пришёл пустой results.
 */
export async function* iterateMarketItems(
  http: SteamHttp,
  appId: number,
  opts: { start?: number; maxPages?: number } = {},
): AsyncGenerator<MarketSearchItem, void, unknown> {
  let start = opts.start ?? 0;
  const maxPages = opts.maxPages ?? Infinity;
  let page = 0;

  while (page < maxPages) {
    const { items, totalCount } = await fetchMarketPage(http, appId, start);
    if (items.length === 0) return;
    for (const item of items) yield item;
    start += items.length;
    page += 1;
    if (totalCount !== null && start >= totalCount) return;
  }
}
