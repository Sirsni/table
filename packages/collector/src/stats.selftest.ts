import assert from "node:assert/strict";
import { computeStats } from "./stats.js";
import type { PriceHistoryPoint } from "./steam/pricehistory.js";

function pt(daysAgo: number, priceCents: number, qty: number): PriceHistoryPoint {
  const now = NOW.getTime();
  return { date: new Date(now - daysAgo * 24 * 60 * 60 * 1000), priceCents, qty };
}

const NOW = new Date("2026-06-15T12:00:00.000Z");

// --- VWAP средневзвешенная по объёму ---
// Точки в пределах 7 дней: цена 100c x 1шт и 200c x 3шт ->
// VWAP = (100*1 + 200*3)/(1+3) = 700/4 = 175.
{
  const points = [pt(1, 100, 1), pt(2, 200, 3)];
  const s = computeStats(points, NOW);
  assert.equal(s.sales7d, 4, "sales7d");
  assert.equal(s.sales30d, 4, "sales30d");
  assert.equal(s.avg7d, 175, "avg7d VWAP");
  assert.equal(s.avg30d, 175, "avg30d VWAP");
}

// --- оконные суммы: точки за пределами окон не учитываются ---
// 5 дней назад (в 7д и 30д), 10 дней назад (только 30д), 40 дней назад (вне всех).
{
  const points = [pt(5, 100, 10), pt(10, 100, 5), pt(40, 100, 100)];
  const s = computeStats(points, NOW);
  assert.equal(s.sales7d, 10, "sales7d окно");
  assert.equal(s.sales30d, 15, "sales30d окно (5д + 10д)");
}

// --- нулевой объём -> avg null ---
{
  const points = [pt(40, 500, 7)]; // всё за пределами 30 дней
  const s = computeStats(points, NOW);
  assert.equal(s.sales7d, 0, "sales7d ноль");
  assert.equal(s.sales30d, 0, "sales30d ноль");
  assert.equal(s.avg7d, null, "avg7d null при нулевом объёме");
  assert.equal(s.avg30d, null, "avg30d null при нулевом объёме");
}

// --- lastPrice/lastDate берут самую свежую точку (порядок перемешан) ---
{
  const points = [pt(10, 300, 1), pt(1, 999, 2), pt(5, 400, 1)];
  const s = computeStats(points, NOW);
  assert.equal(s.lastPrice, 999, "lastPrice свежей точки");
  assert.equal(s.lastDate, pt(1, 999, 2).date.toISOString(), "lastDate свежей точки");
}

// --- округление VWAP до int ---
// 333c x 1 и 334c x 1 -> 667/2 = 333.5 -> round -> 334.
{
  const points = [pt(1, 333, 1), pt(2, 334, 1)];
  const s = computeStats(points, NOW);
  assert.equal(s.avg7d, 334, "VWAP округление до int");
}

// --- пустой массив ---
{
  const s = computeStats([], NOW);
  assert.equal(s.sales7d, 0);
  assert.equal(s.avg30d, null);
  assert.equal(s.lastPrice, null);
  assert.equal(s.lastDate, null);
}

console.log("stats.selftest: OK (все проверки пройдены)");
