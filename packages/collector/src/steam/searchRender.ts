import type { SteamHttp } from "./http.js";

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

/**
 * Постранично перебирает предметы рынка для appId.
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
    const url = buildUrl(appId, start);

    // Один повтор страницы при success:false / null results.
    let data: RenderResponseRaw | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await http.getJson<RenderResponseRaw>(url);
      if (resp && resp.success !== false && Array.isArray(resp.results)) {
        data = resp;
        break;
      }
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

    // data гарантированно не null после цикла (иначе брошена ошибка).
    const results = data!.results ?? [];
    if (results.length === 0) {
      return; // пустая страница — конец
    }

    for (const r of results) {
      const item = mapResult(r);
      if (item) yield item;
    }

    start += results.length;
    page += 1;

    const total = data!.total_count;
    if (typeof total === "number" && start >= total) {
      return;
    }
  }
}
