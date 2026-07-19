// Проверка доктрины ложноотрицательных для фильтров /api/items.
// Строит временную БД с двумя предметами:
//   "Liquid Case"     — есть история продаж (item_stats заполнится),
//   "No-History Case" — Steam отдал prices=[] (fetchPriceHistory бросает,
//                       строки в item_stats НЕ будет, все stats-поля = null).
// Затем прогоняет queryItems с фильтрами из argv и показывает, кто исчез.
//
// Запуск (нужен собранный dist: npm run build):
//   node .claude/skills/table-change-control/scripts/null-visibility-check.mjs
//   node .claude/skills/table-change-control/scripts/null-visibility-check.mjs '{"minRealMargin":5}'
//
// Ожидание по доктрине: предмет без данных либо ВИДЕН, либо его скрытие —
// осознанное, задокументированное решение (см. SKILL.md §3).

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Пути относительно этого файла: .claude/skills/table-change-control/scripts/ -> корень репо.
const { openDb } = await import(new URL("../../../../packages/collector/dist/db.js", import.meta.url));
const { upsertItem, insertSnapshot } = await import(new URL("../../../../packages/collector/dist/repo.js", import.meta.url));
const { enrichHistory } = await import(new URL("../../../../packages/collector/dist/runner.js", import.meta.url));
const { queryItems } = await import(new URL("../../../../packages/server/dist/items.js", import.meta.url));

const filters = process.argv[2] ? JSON.parse(process.argv[2]) : { minSales30d: 1 };

const DB = join(tmpdir(), "table-null-visibility-check.sqlite");
rmSync(DB, { force: true });
const db = openDb(DB);

const APP = 730;
upsertItem(db, APP, "Liquid Case", null);
upsertItem(db, APP, "No-History Case", null);
// Снапшот цен: валюта 1 (USD) — конвертация в USD не требует сетевых курсов.
for (const it of db.prepare("SELECT id FROM items").all()) {
  insertSnapshot(db, {
    itemId: it.id, provider: "steam",
    buyOrder: 100, sellPrice: 200, volume: 10, currency: 1,
  });
}

// Fake http в духе синтетики проекта: { concurrency, hasCookie, getJson, getText }.
const fakeHttp = {
  concurrency: 1,
  hasCookie: true,
  async getJson(url) {
    if (url.includes(encodeURIComponent("Liquid Case"))) {
      return {
        success: true, price_prefix: "$", price_suffix: "",
        prices: [
          ["Jul 10 2026 01: +0", 1.5, "20"],
          ["Jul 11 2026 01: +0", 1.6, "15"],
        ],
      };
    }
    // Предмет без продаж за месяц: success=true, но prices пуст.
    return { success: true, price_prefix: "$", price_suffix: "", prices: [] };
  },
  async getText() { throw new Error("getText не используется в этой проверке"); },
};

const sum = await enrichHistory(db, fakeHttp, { app: APP });
console.log(`enrichHistory: ok=${sum.ok} fail=${sum.fail} (fail=1 — это пустая история, так и задумано)`);

const base = queryItems(db, { app: APP });
console.log("Без фильтров:", base.map((d) => `${d.name} [sales30d=${d.sales30d}, realMargin=${d.realMarginPct}]`).join("; "));

const filtered = queryItems(db, { app: APP, ...filters });
console.log(`С фильтрами ${JSON.stringify(filters)}:`, filtered.map((d) => d.name).join("; ") || "(пусто)");

const hiddenNoData = base.some((d) => d.name === "No-History Case") &&
  !filtered.some((d) => d.name === "No-History Case");
if (hiddenNoData) {
  console.log("ВНИМАНИЕ: предмет БЕЗ ДАННЫХ скрыт этим фильтром (ложноотрицательный).");
  console.log("Это допустимо только как осознанное решение — см. SKILL.md §3, чек-лист.");
  process.exitCode = 1;
} else {
  console.log("OK: предмет без данных остаётся видимым при этих фильтрах.");
}
