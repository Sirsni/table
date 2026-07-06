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
  assert.equal(s.median7d, null, "median7d null пустой");
  assert.equal(s.median30d, null, "median30d null пустой");
  assert.equal(s.p25_30d, null, "p25_30d null пустой");
  assert.equal(s.volatilityPct, null, "volatilityPct null пустой");
  assert.equal(s.baselinePrice, null, "baselinePrice null пустой");
  assert.equal(s.recentPrice, null, "recentPrice null пустой");
  assert.equal(s.boostScore, null, "boostScore null пустой");
}

// --- взвешенная медиана: нечётный total ---
// Цены 100(q1), 200(q1), 300(q1): total=3, threshold=1.5. cum: 100->1, 200->2>=1.5.
// Медиана = 200 (средний элемент нечётного набора).
{
  const points = [pt(1, 100, 1), pt(2, 200, 1), pt(3, 300, 1)];
  const s = computeStats(points, NOW);
  assert.equal(s.median7d, 200, "median нечётный total");
  assert.equal(s.median30d, 200, "median30d нечётный total");
}

// --- взвешенная медиана: чётный total (нижняя медиана по определению cum>=q*total) ---
// Цены 100(q1), 200(q1): total=2, threshold=1. cum: 100->1>=1 -> медиана = 100.
{
  const points = [pt(1, 100, 1), pt(2, 200, 1)];
  const s = computeStats(points, NOW);
  assert.equal(s.median7d, 100, "median чётный total (нижняя)");
}

// --- взвешенная медиана: веса сдвигают медиану ---
// Цены 100(q3), 200(q1): total=4, threshold=2. cum: 100->3>=2 -> медиана = 100.
{
  const points = [pt(1, 100, 3), pt(2, 200, 1)];
  const s = computeStats(points, NOW);
  assert.equal(s.median7d, 100, "median с весами");
}

// --- взвешенный 25-й перцентиль за 30 дней ---
// Цены 100(q1),200(q1),300(q1),400(q1): total=4, q=0.25 -> threshold=1.
// cum: 100->1>=1 -> p25 = 100. Медиана: threshold=2 -> cum:100->1,200->2>=2 -> 200.
{
  const points = [pt(1, 100, 1), pt(2, 200, 1), pt(3, 300, 1), pt(4, 400, 1)];
  const s = computeStats(points, NOW);
  assert.equal(s.p25_30d, 100, "p25_30d");
  assert.equal(s.median30d, 200, "median30d при 4 точках");
}

// --- волатильность на простом наборе ---
// Цены 100(q1), 200(q1): VWAP=150, дисперсия=((100-150)^2+(200-150)^2)/2=2500,
// std=50, volatility% = 50/150*100 = 33.33 (round2).
{
  const points = [pt(1, 100, 1), pt(2, 200, 1)];
  const s = computeStats(points, NOW);
  assert.equal(s.avg30d, 150, "VWAP для волатильности");
  assert.equal(s.volatilityPct, 33.33, "volatilityPct простой набор");
}

// --- волатильность одинаковых цен = 0 ---
{
  const points = [pt(1, 500, 2), pt(2, 500, 3)];
  const s = computeStats(points, NOW);
  assert.equal(s.volatilityPct, 0, "volatilityPct одинаковые цены");
}

// --- волатильность null при объёме < 2 ---
{
  const points = [pt(1, 500, 1)]; // total qty = 1
  const s = computeStats(points, NOW);
  assert.equal(s.volatilityPct, null, "volatilityPct null при qty<2");
}

// --- boostScore: baseline 1000 (старые), recent 1800 (свежие) -> 1.8 ---
// baseline-окно [now-30д, now-3д): точки 5,10,20 дней назад по 1000, суммарно qty>=5.
// recent-окно (последние 3 дня): точки 1,2 дня назад по 1800, суммарно qty>=3.
{
  const points = [
    pt(20, 1000, 3),
    pt(10, 1000, 3),
    pt(5, 1000, 4),
    pt(2, 1800, 2),
    pt(1, 1800, 2),
  ];
  const s = computeStats(points, NOW);
  assert.equal(s.baselinePrice, 1000, "baselinePrice 1000");
  assert.equal(s.recentPrice, 1800, "recentPrice 1800");
  assert.equal(s.boostScore, 1.8, "boostScore 1.8");
}

// --- boostScore null: свежих продаж < 3 ---
// recent-окно имеет total qty = 2 (<3) -> recentPrice null -> boostScore null.
{
  const points = [
    pt(20, 1000, 5),
    pt(10, 1000, 5),
    pt(1, 1800, 2), // всего 2 свежих продажи
  ];
  const s = computeStats(points, NOW);
  assert.equal(s.recentPrice, null, "recentPrice null при <3 продаж");
  assert.equal(s.boostScore, null, "boostScore null при <3 свежих продаж");
  assert.equal(s.baselinePrice, 1000, "baselinePrice считается независимо");
}

// --- boostScore null: baseline-окно скудное (< 5) ---
// baseline total qty = 4 (<5) -> baselinePrice null -> boostScore null.
{
  const points = [
    pt(20, 1000, 2),
    pt(10, 1000, 2), // baseline total = 4
    pt(2, 1800, 3),
    pt(1, 1800, 3), // recent total = 6
  ];
  const s = computeStats(points, NOW);
  assert.equal(s.baselinePrice, null, "baselinePrice null при qty<5");
  assert.equal(s.recentPrice, 1800, "recentPrice считается");
  assert.equal(s.boostScore, null, "boostScore null без baseline");
}

console.log("stats.selftest: OK (все проверки пройдены)");
