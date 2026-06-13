import assert from "node:assert/strict";
import { feeForBase, sellerReceives, profit, marginPct } from "./economics.js";

// Проверка прямой модели: feeForBase(base).total — это брутто-цена.
// base=100 -> 5% и 10% -> 5 + 10 -> total 115.
assert.equal(feeForBase(100).total, 115, "feeForBase(100).total");
assert.equal(feeForBase(100).steamFee, 5);
assert.equal(feeForBase(100).gameFee, 10);

// Граничные: минимальные комиссии по 1 копейке.
// base=1 -> floor(0.05)=0 -> max(1,0)=1; floor(0.10)=0 -> max(1,0)=1; total=1+1+1=3.
assert.equal(feeForBase(1).total, 3, "feeForBase(1).total");
assert.equal(feeForBase(1).steamFee, 1);
assert.equal(feeForBase(1).gameFee, 1);

// Обратный расчёт sellerReceives(gross) -> base.
const cases: Array<[number, number]> = [
  [3, 1], // граничный минимум
  [115, 100], // ровный 15%
  [230, 200],
  [1150, 1000],
  [12345, sellerReceives(12345)], // самосогласованность ниже
];

assert.equal(sellerReceives(3), 1, "gross 3 -> base 1");
assert.equal(sellerReceives(115), 100, "gross 115 -> base 100");
assert.equal(sellerReceives(230), 200, "gross 230 -> base 200");
assert.equal(sellerReceives(1150), 1000, "gross 1150 -> base 1000");

// Ниже минимума -> 0.
assert.equal(sellerReceives(2), 0, "gross 2 -> 0");
assert.equal(sellerReceives(0), 0, "gross 0 -> 0");

// Свойство: для любого base, sellerReceives(feeForBase(base).total) == base.
for (let base = 1; base <= 5000; base++) {
  const gross = feeForBase(base).total;
  const back = sellerReceives(gross);
  assert.equal(
    back,
    base,
    `round-trip base=${base} gross=${gross} -> ${back}`,
  );
}

// Свойство: sellerReceives никогда не даёт total > gross.
for (let gross = 3; gross <= 5000; gross++) {
  const base = sellerReceives(gross);
  if (base > 0) {
    assert.ok(
      feeForBase(base).total <= gross,
      `over-estimate gross=${gross} base=${base} total=${feeForBase(base).total}`,
    );
  }
}

// profit / marginPct
// buyOrder=90, sellPrice=115 -> seller получает 100 -> profit 10 -> margin ~11.11%
assert.equal(profit(90, 115), 10, "profit(90,115)");
assert.ok(
  Math.abs(marginPct(90, 115) - 11.1111) < 0.01,
  `marginPct(90,115)=${marginPct(90, 115)}`,
);
assert.equal(marginPct(0, 115), 0, "marginPct buyOrder=0 -> 0");

// Используем cases, чтобы переменная не оказалась лишней.
for (const [gross, expectedBase] of cases) {
  assert.equal(sellerReceives(gross), expectedBase, `case gross=${gross}`);
}

console.log("economics.selftest: OK (все проверки пройдены)");
