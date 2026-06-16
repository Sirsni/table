import type Database from "better-sqlite3";
import { sellerReceives } from "@table/shared";
import { toUsdCents } from "./fx.js";

/**
 * Источник цены: STEAM = обычный листинг (нижний лот), STEAM(AUTO) = верхний
 * автозапрос (buy order). Таблица считает прибыль «купить на buyFrom → продать
 * на sellTo». По умолчанию steam_auto → steam (купить автозапросом, продать листингом).
 */
export type Service = "steam" | "steam_auto";

/**
 * Чтение таблицы предметов для API. Цены в БД — в минимальных единицах валюты
 * снапшота (поле currency = Steam eCurrency). Конвертацию в USD и расчёт
 * маржи/прибыли делаем в JS, т.к. они валютнозависимы (кроме marginPct —
 * она безразмерна) и зависят от текущих курсов FX.
 */

export type SortKey =
  | "margin"
  | "profit"
  | "buy"
  | "sell"
  | "volume"
  | "name"
  | "sales30d"
  | "sales7d"
  | "dip";
export type SortDir = "asc" | "desc";

export interface QueryItemsParams {
  app: number;
  search?: string;
  minMargin?: number;
  minPriceUsd?: number;
  maxPriceUsd?: number;
  minVolume?: number;
  minSales7d?: number;
  minSales30d?: number;
  minDipPct?: number;
  /** Где покупаем (по умолчанию steam_auto). */
  buyFrom?: Service;
  /** Куда продаём (по умолчанию steam). */
  sellTo?: Service;
  sort?: SortKey;
  dir?: SortDir;
  limit?: number;
}

export interface ItemDto {
  name: string;
  appId: number;
  iconUrl: string | null;
  steamUrl: string;
  buyUsd: number | null;
  sellUsd: number | null;
  receiveUsd: number | null;
  profitUsd: number | null;
  marginPct: number | null;
  volume: number | null;
  currency: number | null;
  fetchedAt: string;
  /** Продажи за 7 дней (history) либо null, если истории нет. */
  sales7d: number | null;
  /** Продажи за 30 дней (history) либо null. */
  sales30d: number | null;
  /** VWAP за 30 дней в USD либо null. */
  avg30dUsd: number | null;
  /** Цена последней сделки истории в USD либо null. */
  lastPriceUsd: number | null;
  /** Скидка текущей продажи относительно VWAP-30д, % (>0 = ниже средней). */
  dipPct: number | null;
}

/** Строка items_latest, нужные столбцы. */
interface LatestRow {
  id: number;
  market_hash_name: string;
  app_id: number;
  icon_url: string | null;
  buy_order: number | null;
  sell_price: number | null;
  volume: number | null;
  currency: number | null;
  fetched_at: string;
}

/** Строка item_stats. */
interface StatsRow {
  item_id: number;
  sales_7d: number | null;
  sales_30d: number | null;
  avg_7d: number | null;
  avg_30d: number | null;
  last_price: number | null;
  last_date: string | null;
  currency: number | null;
}

const CANDIDATE_CAP = 20000;
const DEFAULT_LIMIT = 200;
const VALID_SORTS = new Set<SortKey>([
  "margin",
  "profit",
  "buy",
  "sell",
  "volume",
  "name",
  "sales30d",
  "sales7d",
  "dip",
]);

function round2(n: number | null): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function centsToUsd(cents: number | null): number | null {
  if (cents === null) return null;
  return round2(cents / 100);
}

export function queryItems(
  db: Database.Database,
  params: QueryItemsParams,
): ItemDto[] {
  const where: string[] = [
    "app_id = ?",
    "buy_order IS NOT NULL",
    "sell_price IS NOT NULL",
  ];
  const sqlParams: unknown[] = [params.app];

  const search = params.search?.trim();
  if (search) {
    where.push("market_hash_name LIKE '%' || ? || '%'");
    sqlParams.push(search);
  }

  const rows = db
    .prepare(
      `SELECT id, market_hash_name, app_id, icon_url, buy_order, sell_price,
              volume, currency, fetched_at
       FROM items_latest
       WHERE ${where.join(" AND ")}
       LIMIT ${CANDIDATE_CAP}`,
    )
    .all(...sqlParams) as LatestRow[];

  // Подтягиваем агрегаты ликвидности (item_stats) одним запросом по тем же id и
  // мержим в JS: items_latest — это view, надёжнее не усложнять её JOIN-ом.
  const statsById = new Map<number, StatsRow>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    // IN (...) с плейсхолдерами; ids < CANDIDATE_CAP, в лимит SQLite укладываемся.
    const placeholders = ids.map(() => "?").join(",");
    const statRows = db
      .prepare(
        `SELECT item_id, sales_7d, sales_30d, avg_7d, avg_30d,
                last_price, last_date, currency
         FROM item_stats
         WHERE item_id IN (${placeholders})`,
      )
      .all(...ids) as StatsRow[];
    for (const s of statRows) statsById.set(s.item_id, s);
  }

  const buyFrom: Service = params.buyFrom ?? "steam_auto";
  const sellTo: Service = params.sellTo ?? "steam";

  // Преобразуем в DTO с конвертацией в USD.
  let dtos: ItemDto[] = rows.map((r) => {
    // Обе цены гарантированы WHERE (IS NOT NULL).
    const highestBuy = r.buy_order as number; // STEAM(AUTO): верхний автозапрос
    const lowestSell = r.sell_price as number; // STEAM: нижний лот

    // Цена покупки и цена, по которой продаём, зависят от выбранной пары сервисов.
    const buyCost = buyFrom === "steam" ? lowestSell : highestBuy;
    const sellGross = sellTo === "steam" ? lowestSell : highestBuy;
    // Комиссия Steam берётся при ЛЮБОЙ продаже на Steam (и листингом, и автозапросу).
    const sellNet = sellerReceives(sellGross);
    const profitRaw = sellNet - buyCost;
    const margin = buyCost > 0 ? (profitRaw / buyCost) * 100 : null; // валютнонезависимо

    const buyUsdCents = toUsdCents(buyCost, r.currency);
    const sellUsdCents = toUsdCents(sellGross, r.currency);
    const receiveUsdCents = toUsdCents(sellNet, r.currency);
    const profitUsdCents = toUsdCents(profitRaw, r.currency);
    // Текущий нижний лот в USD — для скидки к средней (независимо от пары).
    const lowestSellUsdCents = toUsdCents(lowestSell, r.currency);

    const st = statsById.get(r.id);
    // avg/last_price хранятся в валюте st.currency (валюта запроса pricehistory),
    // приводим к USD-центам отдельно — она может отличаться от валюты снапшота.
    const avg30UsdCents =
      st && st.avg_30d !== null ? toUsdCents(st.avg_30d, st.currency) : null;
    const lastPriceUsdCents =
      st && st.last_price !== null
        ? toUsdCents(st.last_price, st.currency)
        : null;

    // dipPct: насколько текущая продажа ниже средней (VWAP-30д). Обе цены
    // приводим к одной базе (USD-центы), чтобы валюты снапшота и истории не
    // искажали сравнение. >0 = текущая продажа дешевле средней (скидка).
    let dipPct: number | null = null;
    if (
      avg30UsdCents !== null &&
      avg30UsdCents > 0 &&
      lowestSellUsdCents !== null
    ) {
      dipPct = round2(
        ((avg30UsdCents - lowestSellUsdCents) / avg30UsdCents) * 100,
      );
    }

    return {
      name: r.market_hash_name,
      appId: r.app_id,
      iconUrl: r.icon_url,
      steamUrl: `https://steamcommunity.com/market/listings/${r.app_id}/${encodeURIComponent(
        r.market_hash_name,
      )}`,
      buyUsd: centsToUsd(buyUsdCents),
      sellUsd: centsToUsd(sellUsdCents),
      receiveUsd: centsToUsd(receiveUsdCents),
      profitUsd: centsToUsd(profitUsdCents),
      marginPct: round2(margin),
      volume: r.volume,
      currency: r.currency,
      fetchedAt: r.fetched_at,
      sales7d: st ? st.sales_7d : null,
      sales30d: st ? st.sales_30d : null,
      avg30dUsd: centsToUsd(avg30UsdCents),
      lastPriceUsd: centsToUsd(lastPriceUsdCents),
      dipPct,
    };
  });

  // Фильтры в JS (после конвертации в USD).
  if (params.minMargin !== undefined && Number.isFinite(params.minMargin)) {
    const min = params.minMargin;
    dtos = dtos.filter((d) => d.marginPct !== null && d.marginPct >= min);
  }
  if (params.minPriceUsd !== undefined && Number.isFinite(params.minPriceUsd)) {
    const min = params.minPriceUsd;
    dtos = dtos.filter((d) => d.buyUsd !== null && d.buyUsd >= min);
  }
  if (params.maxPriceUsd !== undefined && Number.isFinite(params.maxPriceUsd)) {
    const max = params.maxPriceUsd;
    dtos = dtos.filter((d) => d.buyUsd !== null && d.buyUsd <= max);
  }
  if (params.minVolume !== undefined && Number.isFinite(params.minVolume)) {
    const min = params.minVolume;
    dtos = dtos.filter((d) => d.volume !== null && d.volume >= min);
  }
  if (params.minSales7d !== undefined && Number.isFinite(params.minSales7d)) {
    const min = params.minSales7d;
    dtos = dtos.filter((d) => d.sales7d !== null && d.sales7d >= min);
  }
  if (params.minSales30d !== undefined && Number.isFinite(params.minSales30d)) {
    const min = params.minSales30d;
    dtos = dtos.filter((d) => d.sales30d !== null && d.sales30d >= min);
  }
  if (params.minDipPct !== undefined && Number.isFinite(params.minDipPct)) {
    const min = params.minDipPct;
    dtos = dtos.filter((d) => d.dipPct !== null && d.dipPct >= min);
  }

  // Сортировка.
  const sort: SortKey = params.sort && VALID_SORTS.has(params.sort)
    ? params.sort
    : "margin";
  const dir: SortDir = params.dir === "asc" ? "asc" : "desc";
  const mul = dir === "asc" ? 1 : -1;

  const numKey = (d: ItemDto): number | null => {
    switch (sort) {
      case "margin":
        return d.marginPct;
      case "profit":
        return d.profitUsd;
      case "buy":
        return d.buyUsd;
      case "sell":
        return d.sellUsd;
      case "volume":
        return d.volume;
      case "sales30d":
        return d.sales30d;
      case "sales7d":
        return d.sales7d;
      case "dip":
        return d.dipPct;
      default:
        return null;
    }
  };

  dtos.sort((a, b) => {
    if (sort === "name") {
      return a.name.localeCompare(b.name) * mul;
    }
    const av = numKey(a);
    const bv = numKey(b);
    // null'ы всегда в конец, независимо от направления.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * mul;
  });

  const limit =
    params.limit !== undefined &&
    Number.isFinite(params.limit) &&
    params.limit > 0
      ? Math.floor(params.limit)
      : DEFAULT_LIMIT;

  return dtos.slice(0, limit);
}
