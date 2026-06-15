import type { PriceHistoryPoint } from "./steam/pricehistory.js";

/**
 * Чистые функции агрегации истории продаж в показатели ликвидности.
 * Без сети и без БД — вызывающий хранит результат и валюту.
 *
 * Все цены — в минимальных единицах валюты истории (центы), как в priceCents.
 */

export interface ItemStatsComputed {
  /** Сумма продаж за последние 7 дней. */
  sales7d: number;
  /** Сумма продаж за последние 30 дней. */
  sales30d: number;
  /** VWAP (средневзвешенная по объёму) цена за 7 дней (центы) либо null. */
  avg7d: number | null;
  /** VWAP за 30 дней (центы) либо null. */
  avg30d: number | null;
  /** Цена самой свежей точки (центы) либо null, если точек нет. */
  lastPrice: number | null;
  /** ISO-дата самой свежей точки либо null. */
  lastDate: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface WindowAgg {
  sales: number;
  vwap: number | null;
}

/** Считает суммарный объём и VWAP по точкам в окне [since, now]. */
function aggregateWindow(
  points: PriceHistoryPoint[],
  since: number,
): WindowAgg {
  let sales = 0;
  let weighted = 0; // sum(priceCents * qty)
  for (const p of points) {
    const t = p.date.getTime();
    if (!Number.isFinite(t) || t < since) continue;
    sales += p.qty;
    weighted += p.priceCents * p.qty;
  }
  const vwap = sales > 0 ? Math.round(weighted / sales) : null;
  return { sales, vwap };
}

/**
 * Агрегирует историю продаж в показатели за 7 и 30 дней относительно now.
 * VWAP = sum(priceCents*qty)/sum(qty); при нулевом объёме окна -> null.
 */
export function computeStats(
  points: PriceHistoryPoint[],
  now: Date = new Date(),
): ItemStatsComputed {
  const nowMs = now.getTime();
  const since7 = nowMs - 7 * DAY_MS;
  const since30 = nowMs - 30 * DAY_MS;

  const w7 = aggregateWindow(points, since7);
  const w30 = aggregateWindow(points, since30);

  // Самая свежая точка по времени (история Steam обычно отсортирована по
  // возрастанию, но не полагаемся на это).
  let last: PriceHistoryPoint | null = null;
  for (const p of points) {
    const t = p.date.getTime();
    if (!Number.isFinite(t)) continue;
    if (last === null || t > last.date.getTime()) last = p;
  }

  return {
    sales7d: w7.sales,
    sales30d: w30.sales,
    avg7d: w7.vwap,
    avg30d: w30.vwap,
    lastPrice: last ? last.priceCents : null,
    lastDate: last ? last.date.toISOString() : null,
  };
}
