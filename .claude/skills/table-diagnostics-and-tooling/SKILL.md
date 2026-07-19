---
name: table-diagnostics-and-tooling
description: Измерять, а не гадать — логи проекта table ([steam]/[sync]/[collector]/[enrich], data/sync-debug.log), SQL-инспекция SQLite, шаблон синтетического прогона с fake http и DB_PATH=/tmp. Загружай при диагностике, «почему цифры такие», проверке гипотез, написании тестового прогона, словах diagnostics, log, SQL, synthetic.
---

# Диагностика и инструменты

Не использовать для: готовых ответов по симптомам (→ table-debugging-playbook сначала).

## Логи
- `[steam] GET <url> -> <status>` — каждый запрос (http.ts).
- `[sync] Steam отдаёт по N предметов...`, `[sync] пустая страница start=... пауза Xс и повтор` — троттлинг; `offset N пуст после всех повторов` — счёт к остановке.
- `[collector] <kind>: завершено/остановлено — обработано X/Y, ok, fail` — итог каждой задачи (collectorService).
- `[enrich] Steam отдаёт историю в валюте кошелька (eCurrency=N)` — валютное предупреждение.
- `data/sync-debug.log` — строки `<ISO> start=N EMPTY|BAD|NOT_JSON body=<800 симв.>`: сырые тела пустых/битых ответов search/render. Заглушка троттлинга = `{"success":true,"total_count":0,"results":[]}`.

## SQL-инспекция (node + better-sqlite3 из collector/dist)
```js
// node --input-type=module <<'EOF' (или файл); DB_PATH учитывается openDb
import { openDb } from "./packages/collector/dist/db.js";
const db = openDb();
console.log(db.prepare("SELECT app_id, COUNT(*) c FROM items GROUP BY app_id").all());
console.log(db.prepare("SELECT COUNT(*) c FROM item_stats").get());          // с историей
console.log(db.prepare("SELECT currency, COUNT(*) c FROM item_stats GROUP BY currency").all()); // валюты!
console.log(db.prepare("SELECT MAX(fetched_at) m FROM price_snapshots").get()); // свежесть
console.log(db.prepare("SELECT COUNT(*) c FROM price_points").get());
db.close();
EOF
```
Ручная сверка метрики предмета: возьми его точки `SELECT ts,price,qty FROM price_points WHERE item_id=?`, посчитай медиану руками, сверь с item_stats и UI.

## Синтетический прогон (обязательный паттерн проверки логики сбора)
```js
import { openDb } from "/home/user/table/packages/collector/dist/db.js";
import { updatePrices /* syncItems, enrichHistory */ } from "/home/user/table/packages/collector/dist/runner.js";
const http = { concurrency: 5,
  async getText(url) { /* верни JSON-строку как Steam; для sync смотри searchRender */ return "{}"; },
  async getJson(url) { return JSON.parse(await this.getText(url)); } };
const db = openDb("/tmp/test.sqlite");
// засей items; вызови runner-функцию; assert'ни ok/fail/строки БД против ручного расчёта
```
Примеры прошлых прогонов — в текстах коммитов (git log): пул (40 предметов/8 воркеров/254мс), предохранитель (стоп на 8/200), заглушка total_count=0 (700/700).

## Точечные зонды
`probe --name "<имя>"` (CLI, живой стакан одного предмета — только с ПК владельца); `GET /api/cookie/check` — живость cookie.

## Правило
Любое «стало лучше/быстрее» подтверждай числом: ok/fail из [collector]-финала, время прохода, COUNT из БД.

## Provenance
2026-07-09; источники: runner.ts, searchRender.ts, collectorService.ts. Перепроверка формата debug-лога: `grep -n "debugLog" packages/collector/src/steam/searchRender.ts`.
