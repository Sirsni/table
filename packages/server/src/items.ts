import type Database from "better-sqlite3";
import { sellerReceives } from "@table/shared";
import { fromUsdCents, toUsdCents } from "./fx.js";

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
  | "dip"
  | "realMargin"
  | "fill30d"
  | "expProfit"
  | "turnover";
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
  /** Минимальная реальная маржа (по медиане истории продаж), %. */
  minRealMargin?: number;
  /** Скрыть предметы с признаком буста (boostSuspect === true). */
  hideBoost?: boolean;
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
  /** Взвешенная медиана цены за 30 дней в USD либо null. */
  median30dUsd: number | null;
  /** Цена последней сделки истории в USD либо null. */
  lastPriceUsd: number | null;
  /** Скидка текущей продажи относительно VWAP-30д, % (>0 = ниже средней). */
  dipPct: number | null;
  /**
   * Реальная прибыль в USD: продажа по медиане истории (median7d ?? median30d)
   * за вычетом комиссии, минус цена покупки. null, если нет медианы/стакана.
   * Для sellTo=steam_auto равна номинальной profitUsd (продажа в бид гарантирована).
   */
  realProfitUsd: number | null;
  /** Реальная маржа, % (по realProfitUsd относительно цены покупки). null аналогично. */
  realMarginPct: number | null;
  /** boostScore из истории (recent/baseline медиана), round2, либо null. */
  boostScore: number | null;
  /**
   * Сколько штук за 30 дней продано по цене <= бид*1.02 (по price_points) —
   * оценка «сколько раз в месяц мой автозапрос реально исполнился бы».
   * null: нет истории точек или неизвестен курс валюты кошелька.
   */
  fill30d: number | null;
  /**
   * Ожидаемая прибыль/мес, USD: fill30d * realProfitUsd (знак сохраняется).
   * null, если нет fill30d или realProfitUsd.
   */
  expProfitUsd: number | null;
  /**
   * Оценка оборота: за сколько дней текущая очередь лотов (volume=cSellOrders)
   * рассосётся при темпе sales30d/30 продаж в день. null без данных/продаж.
   */
  turnoverDays: number | null;
  /**
   * Подозрение на буст/накрутку цены. null, если истории нет.
   * true, если boostScore >= 1.5 ИЛИ текущий нижний лот >= 1.5x медианы-30д
   * при достаточном объёме продаж (>=5 за 30д).
   */
  boostSuspect: boolean | null;
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
  median_7d: number | null;
  median_30d: number | null;
  p25_30d: number | null;
  volatility_pct: number | null;
  baseline_price: number | null;
  recent_price: number | null;
  boost_score: number | null;
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
  "realMargin",
  "fill30d",
  "expProfit",
  "turnover",
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
                last_price, last_date, currency,
                median_7d, median_30d, p25_30d, volatility_pct,
                baseline_price, recent_price, boost_score
         FROM item_stats
         WHERE item_id IN (${placeholders})`,
      )
      .all(...ids) as StatsRow[];
    for (const s of statRows) statsById.set(s.item_id, s);
  }

  const buyFrom: Service = params.buyFrom ?? "steam_auto";
  const sellTo: Service = params.sellTo ?? "steam";

  // === fill rate: сколько штук за 30д продано по цене <= текущий автозапрос*1.02 ===
  // Точки (price_points) хранятся в валюте КОШЕЛЬКА (item_stats.currency), а
  // автозапрос (buy_order) — в валюте снапшота. Порог считаем через USD-центы:
  // bid -> USD -> валюта кошелька. Агрегация одним SQL через temp-таблицу
  // порогов (по-предметный порог; 10k INSERT в транзакции — миллисекунды),
  // иначе пришлось бы тянуть миллионы точек в JS на каждый запрос API.
  const cutoff30 = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  const fillById = new Map<number, number>();
  {
    const thrRows: Array<{ id: number; thr: number }> = [];
    for (const r of rows) {
      const st = statsById.get(r.id);
      if (!st || st.currency === null || r.buy_order === null) continue;
      const bidUsd = toUsdCents(r.buy_order, r.currency);
      if (bidUsd === null) continue;
      const thr = fromUsdCents(Math.round(bidUsd * 1.02), st.currency);
      if (thr === null) continue;
      thrRows.push({ id: r.id, thr });
    }
    if (thrRows.length > 0) {
      db.exec(
        `CREATE TEMP TABLE IF NOT EXISTS _fill_thr(
           item_id INTEGER PRIMARY KEY, thr INTEGER NOT NULL);
         DELETE FROM _fill_thr;`,
      );
      const ins = db.prepare(`INSERT INTO _fill_thr(item_id, thr) VALUES (?, ?)`);
      db.transaction((xs: typeof thrRows) => {
        for (const x of xs) ins.run(x.id, x.thr);
      })(thrRows);
      const agg = db
        .prepare(
          `SELECT p.item_id AS id, SUM(p.qty) AS fv
           FROM price_points p JOIN _fill_thr t ON t.item_id = p.item_id
           WHERE p.ts >= ? AND p.price <= t.thr
           GROUP BY p.item_id`,
        )
        .all(cutoff30) as Array<{ id: number; fv: number }>;
      for (const a of agg) fillById.set(a.id, a.fv);
      // Порог был, но подходящих точек нет — это честный 0, не null.
      for (const x of thrRows) if (!fillById.has(x.id)) fillById.set(x.id, 0);
    }
  }

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
    // avg/last_price/median хранятся в валюте st.currency (валюта запроса
    // pricehistory), приводим к USD-центам отдельно — она может отличаться от
    // валюты снапшота.
    const avg30UsdCents =
      st && st.avg_30d !== null ? toUsdCents(st.avg_30d, st.currency) : null;
    const lastPriceUsdCents =
      st && st.last_price !== null
        ? toUsdCents(st.last_price, st.currency)
        : null;
    const median30UsdCents =
      st && st.median_30d !== null
        ? toUsdCents(st.median_30d, st.currency)
        : null;
    // Самая свежая доступная медиана сделок (3д -> 7д -> 30д) в USD-центах.
    // Для трендовых предметов (обвал/рост) старые окна врут — берём свежайшее.
    const freshMedianGross =
      st !== undefined
        ? (st.recent_price ?? st.median_7d ?? st.median_30d)
        : null;
    const freshMedianUsdCents =
      freshMedianGross !== null && st !== undefined
        ? toUsdCents(freshMedianGross, st.currency)
        : null;

    // dipPct: насколько текущий нижний лот ниже СВЕЖЕЙ медианы сделок.
    // >0 = лот дешевле недавней нормы (шанс выкупа). Раньше сравнивали с
    // VWAP-30д — на обвалившихся предметах давало бессмысленные +99%.
    let dipPct: number | null = null;
    if (
      freshMedianUsdCents !== null &&
      freshMedianUsdCents > 0 &&
      lowestSellUsdCents !== null
    ) {
      dipPct = round2(
        ((freshMedianUsdCents - lowestSellUsdCents) / freshMedianUsdCents) * 100,
      );
    }

    // Реальная маржа: выручка не по номинальному стакану, а по РЕАЛИСТИЧНОЙ
    // цене продажи = min(текущий нижний лот, свежая медиана сделок).
    // Логика: дороже нижнего лота продать нельзя (купят лот), а медиана
    // защищает от забустенного лота. Кламп min() чинит обвалившиеся предметы
    // (медиана прошлого месяца недостижима) и бусты одновременно.
    // Для sellTo=steam_auto продажа идёт «в бид» гарантированно — real == nominal.
    let realProfitUsd: number | null;
    let realMarginPct: number | null;
    if (sellTo === "steam_auto") {
      realProfitUsd = centsToUsd(profitUsdCents);
      realMarginPct = round2(margin);
    } else {
      const realSellUsdCents =
        freshMedianUsdCents !== null && lowestSellUsdCents !== null
          ? Math.min(lowestSellUsdCents, freshMedianUsdCents)
          : null;
      // sellerReceives на USD-центах: комиссия пропорциональна, погрешность
      // округления <= 1-2 цента — приемлемо для оценочной метрики.
      const realReceiveUsdCents =
        realSellUsdCents !== null ? sellerReceives(realSellUsdCents) : null;
      if (realReceiveUsdCents !== null && buyUsdCents !== null) {
        const realProfitUsdCents = realReceiveUsdCents - buyUsdCents;
        realProfitUsd = centsToUsd(realProfitUsdCents);
        realMarginPct =
          buyUsdCents > 0
            ? round2((realProfitUsdCents / buyUsdCents) * 100)
            : null;
      } else {
        realProfitUsd = null;
        realMarginPct = null;
      }
    }

    // Признак буста: либо взлёт свежей медианы над нормой (boost_score),
    // либо текущий нижний лот сильно выше медианы-30д при заметном объёме.
    const boostScore = st !== undefined ? round2(st.boost_score) : null;
    let boostSuspect: boolean | null;
    if (st === undefined) {
      boostSuspect = null;
    } else {
      const byScore = st.boost_score !== null && st.boost_score >= 1.5;
      const byRatio =
        median30UsdCents !== null &&
        median30UsdCents > 0 &&
        lowestSellUsdCents !== null &&
        lowestSellUsdCents / median30UsdCents >= 1.5 &&
        (st.sales_30d ?? 0) >= 5;
      boostSuspect = byScore || byRatio;
    }

    const fill30d = fillById.has(r.id) ? (fillById.get(r.id) as number) : null;
    // Оборот: дней до рассасывания текущей очереди лотов темпом продаж 30д.
    const turnoverDays =
      st && st.sales_30d !== null && st.sales_30d > 0 && r.volume !== null
        ? round2(r.volume / (st.sales_30d / 30))
        : null;
    // Ожидаемая прибыль/мес осмысленна ТОЛЬКО для покупки автозапросом
    // (fill — вероятность исполнения бида); при buyFrom=steam покупка мгновенна
    // и fill к ней не относится — null, а не ложное число.
    const expProfitUsd =
      buyFrom === "steam_auto" && fill30d !== null && realProfitUsd !== null
        ? round2(fill30d * realProfitUsd)
        : null;

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
      median30dUsd: centsToUsd(median30UsdCents),
      lastPriceUsd: centsToUsd(lastPriceUsdCents),
      dipPct,
      realProfitUsd,
      realMarginPct,
      fill30d,
      expProfitUsd,
      turnoverDays,
      boostScore,
      boostSuspect,
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
  if (
    params.minRealMargin !== undefined &&
    Number.isFinite(params.minRealMargin)
  ) {
    const min = params.minRealMargin;
    dtos = dtos.filter((d) => d.realMarginPct !== null && d.realMarginPct >= min);
  }
  if (params.hideBoost === true) {
    // Отбрасываем только явно подозрительные; null/false (нет данных или норма) — оставляем.
    dtos = dtos.filter((d) => d.boostSuspect !== true);
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
      case "realMargin":
        return d.realMarginPct;
      case "fill30d":
        return d.fill30d;
      case "expProfit":
        return d.expProfitUsd;
      case "turnover":
        return d.turnoverDays;
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
