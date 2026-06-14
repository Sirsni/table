import type Database from "better-sqlite3";
import { sellerReceives, profit, marginPct } from "@table/shared";
import { toUsdCents } from "./fx.js";

/**
 * Чтение таблицы предметов для API. Цены в БД — в минимальных единицах валюты
 * снапшота (поле currency = Steam eCurrency). Конвертацию в USD и расчёт
 * маржи/прибыли делаем в JS, т.к. они валютнозависимы (кроме marginPct —
 * она безразмерна) и зависят от текущих курсов FX.
 */

export type SortKey = "margin" | "profit" | "buy" | "sell" | "volume" | "name";
export type SortDir = "asc" | "desc";

export interface QueryItemsParams {
  app: number;
  search?: string;
  minMargin?: number;
  minPriceUsd?: number;
  maxPriceUsd?: number;
  minVolume?: number;
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
}

/** Строка items_latest, нужные столбцы. */
interface LatestRow {
  market_hash_name: string;
  app_id: number;
  icon_url: string | null;
  buy_order: number | null;
  sell_price: number | null;
  volume: number | null;
  currency: number | null;
  fetched_at: string;
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
      `SELECT market_hash_name, app_id, icon_url, buy_order, sell_price,
              volume, currency, fetched_at
       FROM items_latest
       WHERE ${where.join(" AND ")}
       LIMIT ${CANDIDATE_CAP}`,
    )
    .all(...sqlParams) as LatestRow[];

  // Преобразуем в DTO с конвертацией в USD.
  let dtos: ItemDto[] = rows.map((r) => {
    // Обе цены гарантированы WHERE (IS NOT NULL).
    const buy = r.buy_order as number;
    const sell = r.sell_price as number;

    const buyUsdCents = toUsdCents(buy, r.currency);
    const sellUsdCents = toUsdCents(sell, r.currency);
    const receiveUsdCents = toUsdCents(sellerReceives(sell), r.currency);
    const profitUsdCents = toUsdCents(profit(buy, sell), r.currency);
    const margin = marginPct(buy, sell); // валютнонезависимо

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
