// Диагностика покрытия БД: node scripts/diag.mjs [appId=730]
import { openDb } from "../packages/collector/dist/db.js";
const app = Number(process.argv[2] ?? 730);
const db = openDb();
const one = (sql, ...a) => Object.values(db.prepare(sql).get(...a))[0];
console.log("=== Покрытие app", app, "===");
console.log("предметов в каталоге:", one("SELECT COUNT(*) FROM items WHERE app_id=?", app));
console.log("со снапшотом цен:    ", one("SELECT COUNT(DISTINCT item_id) FROM price_snapshots s JOIN items i ON i.id=s.item_id WHERE i.app_id=?", app));
console.log("с историей (stats):  ", one("SELECT COUNT(*) FROM item_stats st JOIN items i ON i.id=st.item_id WHERE i.app_id=?", app));
console.log("\n=== Ножи/перчатки (имя начинается с ★) ===");
console.log("всего:               ", one("SELECT COUNT(*) FROM items WHERE app_id=? AND market_hash_name LIKE '★%'", app));
console.log("со снапшотом:        ", one("SELECT COUNT(*) FROM items_latest WHERE app_id=? AND market_hash_name LIKE '★%'", app));
console.log("есть автозапрос:     ", one("SELECT COUNT(*) FROM items_latest WHERE app_id=? AND market_hash_name LIKE '★%' AND buy_order IS NOT NULL", app));
console.log("есть лот продажи:    ", one("SELECT COUNT(*) FROM items_latest WHERE app_id=? AND market_hash_name LIKE '★%' AND sell_price IS NOT NULL", app));
console.log("обе цены:            ", one("SELECT COUNT(*) FROM items_latest WHERE app_id=? AND market_hash_name LIKE '★%' AND buy_order IS NOT NULL AND sell_price IS NOT NULL", app));
console.log("\nПримеры ножей (5):");
for (const r of db.prepare("SELECT market_hash_name n, buy_order b, sell_price s, currency c FROM items_latest WHERE app_id=? AND market_hash_name LIKE '★%' LIMIT 5").all(app))
  console.log(" ", r.n, "| buy:", r.b, "| sell:", r.s, "| cur:", r.c);
db.close();
