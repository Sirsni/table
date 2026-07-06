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
  /** Взвешенная по qty медиана цены за 7 дней (центы) либо null. */
  median7d: number | null;
  /** Взвешенная по qty медиана цены за 30 дней (центы) либо null. */
  median30d: number | null;
  /** Взвешенный 25-й перцентиль цены за 30 дней (центы) либо null. */
  p25_30d: number | null;
  /**
   * Взвешенное станд. отклонение цены за 30д / VWAP-30д, в процентах (round2).
   * null, если объём окна < 2 (по одной сделке дисперсию не оценить).
   */
  volatilityPct: number | null;
  /**
   * Норма цены ДО возможного буста: взвешенная медиана точек в окне
   * [now-30д, now-3д). null, если объём окна < 5 (недостаточно данных для нормы).
   */
  baselinePrice: number | null;
  /** Взвешенная медиана точек за последние 3 дня. null, если объём < 3. */
  recentPrice: number | null;
  /** recentPrice/baselinePrice (round2). null, если любой из них null. */
  boostScore: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Точка для взвешенной статистики: только цена и вес (qty). */
interface WeightedPoint {
  price: number;
  qty: number;
}

interface WindowAgg {
  sales: number;
  vwap: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
 * Собирает {price, qty} точек в полуинтервале [since, until).
 * until = Infinity -> без верхней границы (совпадает с aggregateWindow: t >= since).
 * Верхнюю границу now специально НЕ навязываем — как и в остальных окнах.
 */
function pointsInWindow(
  points: PriceHistoryPoint[],
  since: number,
  until: number,
): WeightedPoint[] {
  const res: WeightedPoint[] = [];
  for (const p of points) {
    const t = p.date.getTime();
    if (!Number.isFinite(t)) continue;
    if (t < since || t >= until) continue;
    res.push({ price: p.priceCents, qty: p.qty });
  }
  return res;
}

function totalQty(arr: WeightedPoint[]): number {
  let sum = 0;
  for (const p of arr) sum += p.qty;
  return sum;
}

/**
 * Взвешенный по qty перцентиль q ∈ [0,1]: сортируем по цене по возрастанию,
 * кумулятивно суммируем qty, берём первую цену, где cum >= totalQty*q.
 * Медиана — это q=0.5. totalQty == 0 -> null.
 */
function weightedPercentile(arr: WeightedPoint[], q: number): number | null {
  const total = totalQty(arr);
  if (total <= 0) return null;
  const sorted = [...arr].sort((a, b) => a.price - b.price);
  const threshold = total * q;
  let cum = 0;
  for (const p of sorted) {
    cum += p.qty;
    if (cum >= threshold) return p.price;
  }
  // Страховка от накопленной погрешности float — последняя (самая дорогая) цена.
  return sorted[sorted.length - 1].price;
}

/**
 * Взвешенное станд. отклонение цены (популяционное) / VWAP, в процентах (round2).
 * null, если объём окна < 2 или VWAP невалиден.
 */
function weightedVolatilityPct(
  arr: WeightedPoint[],
  vwap: number | null,
): number | null {
  const total = totalQty(arr);
  if (total < 2) return null;
  if (vwap === null || vwap <= 0) return null;
  let acc = 0; // sum(qty * (price - vwap)^2)
  for (const p of arr) acc += p.qty * (p.price - vwap) ** 2;
  const std = Math.sqrt(acc / total);
  return round2((std / vwap) * 100);
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
  const since3 = nowMs - 3 * DAY_MS;
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

  // Взвешенные метрики цены по окнам.
  const arr7 = pointsInWindow(points, since7, Infinity);
  const arr30 = pointsInWindow(points, since30, Infinity);
  // Норма ДО буста — окно [now-30д, now-3д); свежая цена — последние 3 дня.
  // Граница now-3д отдаётся recent (t >= since3), а не baseline (t < since3),
  // поэтому окна не пересекаются и точки не считаются дважды.
  const arrBaseline = pointsInWindow(points, since30, since3);
  const arrRecent = pointsInWindow(points, since3, Infinity);

  const baselineQty = totalQty(arrBaseline);
  const recentQty = totalQty(arrRecent);
  const baselinePrice =
    baselineQty >= 5 ? weightedPercentile(arrBaseline, 0.5) : null;
  const recentPrice =
    recentQty >= 3 ? weightedPercentile(arrRecent, 0.5) : null;
  const boostScore =
    baselinePrice !== null && baselinePrice > 0 && recentPrice !== null
      ? round2(recentPrice / baselinePrice)
      : null;

  return {
    sales7d: w7.sales,
    sales30d: w30.sales,
    avg7d: w7.vwap,
    avg30d: w30.vwap,
    lastPrice: last ? last.priceCents : null,
    lastDate: last ? last.date.toISOString() : null,
    median7d: weightedPercentile(arr7, 0.5),
    median30d: weightedPercentile(arr30, 0.5),
    p25_30d: weightedPercentile(arr30, 0.25),
    volatilityPct: weightedVolatilityPct(arr30, w30.vwap),
    baselinePrice,
    recentPrice,
    boostScore,
  };
}
