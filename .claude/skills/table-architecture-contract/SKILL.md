---
name: table-architecture-contract
description: >
  Архитектурный контракт проекта table (Steam Market price table): границы пакетов
  монорепо (shared/collector/server/web), несущие инварианты (integer minor units +
  currency, конвертация в USD только на сервере, пути от корня репо, одна задача сбора,
  AbortSignal, возобновляемые проходы, предохранитель 429), схема SQLite (items,
  price_snapshots, item_stats, price_points, view items_latest) и известные слабые места.
  Загружай при: проектировании нового модуля/прохода/эндпоинта/провайдера; вопросах
  «куда положить код», «в какой таблице/колонке хранить», «почему цены integer»,
  «почему предмет пропал из таблицы», «где считается USD/маржа»; рефакторинге границ;
  словах architecture, schema, invariant, package boundaries, data flow, items_latest,
  monorepo, DB schema, view, AbortSignal, 409, worker pool.
---

# table-architecture-contract — несущие решения и инварианты

## Когда НЕ использовать этот скилл

| Тебе нужно | Возьми вместо этого |
|---|---|
| Чинить конкретный отказ (пустые страницы, 429, зависание) | table-debugging-playbook |
| Факты про эндпоинты Steam, квоты, комиссию, валюты | steam-market-reference |
| Запустить проект, команды, панель сбора | table-run-and-operate |
| env-переменные и среда владельца (Windows, туннель) | table-config-and-env |
| Формулы метрик (медианы, буст, fill rate) как рецепты | table-analysis-toolkit |
| Решить, можно ли менять и как коммитить | table-change-control |
| SQL-инспекция БД, синтетические прогоны | table-diagnostics-and-tooling |

Этот скилл — про то, ГДЕ живёт код и данные, ПОЧЕМУ так, и какие правила нельзя
нарушать, добавляя новое (новый проход сбора, провайдер площадки, эндпоинт API,
таблица БД).

## 1. Карта монорепо и границы пакетов

npm workspaces, Node >= 22, TypeScript, ESM (`"type": "module"`). Порядок сборки
жёсткий: shared → collector → server → web (см. `package.json` корня, script `build`).

| Пакет | Роль | Что МОЖНО тут делать | Что НЕЛЬЗЯ |
|---|---|---|---|
| `packages/shared` | Типы + экономика комиссии Steam (`sellerReceives`, `feeForBase`, `profit`, `marginPct`), интерфейс `MarketProvider`, `APP_IDS` | Чистые функции без сети и БД | Импортировать другие пакеты, ходить в сеть |
| `packages/collector` | Весь парсинг Steam (`src/steam/*`), схема БД (`db.ts`), слой записи (`repo.ts`), проходы сбора (`runner.ts`), метрики истории (`stats.ts`), CLI (`index.ts`: sync-items / update-prices / enrich-history / probe) | HTTP к Steam, запись в SQLite | Знать про USD/FX, про HTTP-API сервера |
| `packages/server` | Fastify API (`server.ts`), чтение БД + маржа + конвертация в USD (`items.ts`, `fx.ts`), менеджер задач сбора (`collectorService.ts`) | Читать БД, дергать runner коллектора, конвертировать валюты | Парсить Steam напрямую. Единственное исключение: `/api/cookie/check` вызывает `fetchPriceHistory` из collector — это ИМПОРТ функции коллектора, а не свой парсер |
| `packages/web` | React + Vite + TanStack Table (App/Table/Filters/CollectorPanel) | Говорить ТОЛЬКО с `/api` (см. `web/src/api.ts`, `BASE = "/api"`; в dev Vite проксирует на 127.0.0.1:3000) | Ходить в Steam, в БД, знать про валюты кроме готовых `*Usd` полей DTO |

**Почему Steam-эндпоинты только в `collector/src/steam/*`**: эндпоинты
неофициальные и уже один раз полностью поменялись (старый рынок → React/SSR,
`item_nameid` умер). Когда Steam что-то ломает — чинится ОДИН каталог.
Мёртвые модули `steam/histogram.ts` и `steam/itemNameId.ts` (старый рынок) лежат
там же и НЕ импортируются никем — не используй их как образец.

**Почему экономика в shared**: `sellerReceives` нужна и collector'у (CLI probe/top),
и server'у (реальная маржа в items.ts). Формула инверсией подбором, проверена против
Steam до цента ($1000 → $869.58) — детали в скилле steam-market-reference.

Collector экспортирует сабпути (см. `packages/collector/package.json`, поле
`exports`): `.`, `./runner`, `./db`, `./repo`, `./steam/http`, `./steam/pricehistory`.
Server импортирует только их — новый импорт из collector требует добавить сабпуть.

## 2. Поток данных (текстовая диаграмма)

```
Steam (search/render, orderbook, pricehistory)
  │  SteamHttp (collector/src/steam/http.ts): очередь PQueue 1 req/3000ms,
  │  ретраи, таймаут 20с, прокси STEAM_PROXY, cookie STEAM_COOKIE
  ▼
runner.ts — три прохода:
  syncItems      → items            (каталог имён; ПОСЛЕДОВАТЕЛЬНО, ретраи пустых страниц)
  updatePrices   → price_snapshots  (стакан по имени; пул воркеров = http.concurrency)
  enrichHistory  → item_stats + price_points (история продаж; требует cookie; пул воркеров)
  ▼
SQLite data/table.sqlite (WAL) — цены integer minor units + currency
  ▼
server: items.ts (items_latest + item_stats → маржа/реальная маржа/буст)
        fx.ts    (minor units любой валюты → USD-центы, кэш курсов 12ч)
        collectorService.ts (одна фоновая задача, статус, стоп)
  ▼  GET /api/items, /api/meta, /api/collector/*, /api/cookie/check
web (React) — только fetch("/api/...")
```

## 3. Инварианты (нарушение = баг, ревью отклоняет)

1. **Все цены в БД — integer в минимальных единицах валюты (центы/гроши/копейки)
   + рядом колонка `currency` (код Steam eCurrency).** Нигде в collector не
   появляется float-цена (единственное преобразование: `Math.round(median*100)`
   в pricehistory.ts) и нигде не появляется USD. Причина: валюта ответа Steam
   зависит от гео выходного IP (orderbook) и от кошелька аккаунта (pricehistory),
   параметр currency игнорируется — хранить надо факт, а не пожелание.
2. **Конвертация в USD — только на сервере, только через `server/src/fx.ts`
   (`toUsdCents`)**, в момент чтения. Нет курса → null, НЕ падение (fx обязан
   переживать офлайн: память → файл-кэш `data/fx-cache.json` → сеть → протухший кэш).
3. **Пути к данным — от корня репозитория через `import.meta.url`, НЕ от cwd.**
   Примеры: `DEFAULT_DB_PATH` в collector/src/db.ts (`../../../data/table.sqlite`),
   `DEFAULT_FX_CACHE_PATH` в server/src/fx.ts, `DEBUG_LOG_PATH` в searchRender.ts
   (`../../../../data/sync-debug.log` — от dist/steam/, на уровень глубже!).
   Причина: `npm run -w <pkg>` ставит cwd в папку пакета — иначе каждый пакет
   писал бы в свой data/. Новый файл данных — только по этому паттерну,
   с override через env (DB_PATH, FX_CACHE_PATH).
4. **Одна задача сбора за раз.** `CollectorService.begin()` синхронно (до первого
   await, Node однопоточен — гонки нет) проверяет `running` и бросает; маршрут
   отвечает 409. Запуск возвращает 202 сразу, задача крутится в фоне, прогресс —
   через `onProgress`. Новый вид задачи — только через begin/finish этого класса.
5. **Всякая долгая операция прерываема.** AbortSignal прокидывается ДО самого
   fetch и во ВСЕ паузы (`sleep`/`waitAbortable` слушают abort). «Стоп» и
   предохранитель сведены в один сигнал (`linkedController` в runner.ts).
   В http.ts таймаут запроса и внешняя отмена объединены `AbortSignal.any`;
   таймаут ретраится как сетевая ошибка, внешняя отмена — терминальна
   (`SteamAbortError`). НЕ убирай таймаут (20с, STEAM_TIMEOUT_MS): без него
   undici-fetch виснет навсегда на оборванном туннеле — было, воркеры замерзали.
6. **Проходы возобновляемы.** `listItemsForPriceUpdate` / `listItemsForHistoryUpdate`
   (repo.ts) сортируют: без снапшота/статов — первыми, затем по давности
   (старые сначала). Прерванный проход при перезапуске продолжает с самого
   несвежего — прогресс не теряется. Квота Steam (~1000 запросов/IP/окно) делает
   полный проход одним запуском недостижимым, так что это несущее свойство,
   а не удобство. Новый проход обязан читать кандидатов через такой же listItemsFor*.
7. **Предохранитель 429 обязателен в любом новом проходе.** `RATE_LIMIT_TRIP = 8`
   (runner.ts): 8 ошибок 429 ПОДРЯД (успех сбрасывает счётчик) → `stoppedReason` +
   abort. При бане продолжать вредно (углубляет бан). HTTP-слой на 429 делает
   один короткий повтор (3с) и бросает `SteamHttpError(429)` — решение «стоп»
   принимает runner, не http.
8. **`items_latest` — view последнего снапшота** (db.ts): items JOIN снапшот с
   максимальным `(fetched_at, id)`. View пересоздаётся при каждом openDb
   (`DROP VIEW IF EXISTS` + CREATE) — тело можно менять без миграции.
9. **Миграции — идемпотентные и в openDb**: `CREATE TABLE IF NOT EXISTS` +
   ручные `ALTER TABLE ADD COLUMN` через PRAGMA table_info (ensureCurrencyColumn,
   ensureItemStatsColumns). Новая колонка = CREATE TABLE для новых БД + ensure*
   для существующих. Отдельного мигратора нет.
10. **Server и collector делят один файл БД, сервер держит ОДНО read-write
    соединение** (server/src/db.ts → openDb коллектора): через него и чтения API,
    и фоновые задачи. WAL позволяет параллельный CLI-процесс.
11. **Доктрина ложноотрицательных** (главная, детали в table-change-control):
    подозрительное ПОМЕЧАЕМ (boostSuspect, бейдж), а не прячем. В коде:
    `hideBoost` отбрасывает только `boostSuspect === true`, null (нет данных)
    остаётся; предмет без истории получает null-метрики, но НЕ выпадает из
    выдачи. Любой новый фильтр/детектор обязан следовать этому: отсечение —
    только явное действие пользователя, дефолт — показать с меткой.

## 4. Схема данных (проверено по collector/src/db.ts)

Все таблицы создаёт `openDb()`. Цены — integer minor units, `currency` — Steam
eCurrency (1=USD, 5=RUB, 6=PLN; полная карта — `ECURRENCY_TO_ISO` в fx.ts).

**items** — каталог предметов. `UNIQUE(app_id, market_hash_name)`, upsert
обновляет icon_url/updated_at. `item_nameid` — legacy (старый рынок), сейчас
всегда NULL и не нужен: новый orderbook работает по имени.

**price_snapshots** — история стаканов (append-only). Колонки: `buy_order` —
верхний автозапрос (amtMaxBuyOrder), `sell_price` — нижний лот (amtMinSellOrder),
`volume` — число лотов на продажу (cSellOrders, прокси ликвидности предложения;
НЕ объём сделок!), `currency`, `fetched_at` (TEXT `datetime('now')`, точность 1с).
Индекс `(item_id, fetched_at DESC)`.

**item_stats** — одна строка на предмет (upsert), агрегаты pricehistory из
stats.ts: `sales_7d/30d` (штук продано), `avg_7d/30d` (VWAP — средневзвешенная
по объёму), `median_7d/30d`, `p25_30d` (взвешенные перцентили), `volatility_pct`,
`baseline_price` (медиана окна [−30д, −3д), «норма до буста», нужен объём ≥ 5),
`recent_price` (медиана последних 3д, объём ≥ 3), `boost_score` = recent/baseline,
`last_price`/`last_date` (свежайшая точка), `currency` — ФАКТИЧЕСКАЯ валюта
истории (кошелёк аккаунта, детект по price_prefix/suffix), может отличаться от
валюты снапшотов — потому у stats своя колонка currency.

**price_points** — сырые точки истории, `PRIMARY KEY(item_id, ts)` (unix-секунды).
`replaceItemPoints` в транзакции стирает точки предмета и пишет заново только
не старше 35 дней от МАКСИМАЛЬНОГО ts набора (не от Date.now() — чтобы синтетика
с историческими датами не обрезалась). Это сырьё для будущих fill rate и бэктеста
(см. table-profit-detection-campaign).

**items_latest** (view) — items + последний снапшот. Именно её читает
`queryItems` (server/src/items.ts) с `WHERE buy_order IS NOT NULL AND sell_price
IS NOT NULL`, кап кандидатов `CANDIDATE_CAP = 20000`, дефолтный limit ответа 200.
item_stats подтягивается вторым запросом `IN (...)` и мержится в JS — view
намеренно не усложняется JOIN'ом.

## 5. Контракты между слоями

- **runner ↔ вызывающие**: проходы принимают `{app, limit/pages, currency,
  onProgress, signal}` и возвращают `CollectSummary {ok, fail, processed,
  stoppedReason?}`. Логику печати/статуса держит вызывающий (CLI или
  CollectorService). Ошибка одного предмета = fail-счётчик, НЕ падение прохода.
- **SteamHttp ↔ парсеры**: парсеры (`searchRender/orderbook/pricehistory.ts`) —
  чистые функции над `http.getJson/getText`; всё про троттлинг/ретраи/прокси/
  cookie — внутри SteamHttp. Синтетика подсовывает fake-объект
  `{concurrency, getJson, getText, hasCookie}` (паттерн — table-validation-and-qa).
- **server ↔ web**: DTO `ItemDto` (items.ts) — все цены уже в USD (`buyUsd`,
  `realProfitUsd`...), фильтры/сортировка выполняются на сервере в JS ПОСЛЕ
  конвертации. Пара сервисов `buyFrom/sellTo ∈ {steam, steam_auto}` задаёт,
  какая нога — нижний лот, какая — автозапрос; комиссия берётся при любой
  продаже на Steam. Формулы realSell/dip/boost — в table-analysis-toolkit.
- **.env**: грузится через `node --env-file-if-exists=../../.env` в скриптах
  пакетов — сервер и CLI видят один файл в корне. Полный список env —
  table-config-and-env.

## 6. Слабые места (честно; знай, прежде чем строить сверху)

| Слабое место | Следствие | Смягчение / статус |
|---|---|---|
| `items_latest` — INNER JOIN: предмет без единого снапшота в view отсутствует | Свежесинхронизированные предметы не видны в /api/items до первого update-prices; любые расчёты «по всем предметам» через view молча теряют их | Осознанно: без цен строка бесполезна. /api/meta показывает `total` (из items) против `priced` — разрыв виден |
| `fetched_at` — TEXT, точность 1 секунда | Два снапшота в одну секунду неразличимы по времени | Тай-брейк `ORDER BY fetched_at DESC, id DESC` в view — порядок детерминирован |
| Каталог покрыт ~9k из ~33.7k предметов CS2 (total_count=33671) | Ложноотрицательные на уровне КАТАЛОГА: прибыльный предмет может вообще не быть в БД | Тихий троттлинг search/render ограничивает глубину; план — перебор sort_column × sort_dir и фильтров (HANDOFF §2 п.4, НЕ реализовано) |
| История требует cookie ОДНОГО аккаунта → вся история в одной валюте (кошелька) | Смена аккаунта с другой валютой смешает валюты в item_stats/price_points между предметами (per-row currency это переживает, но сравнимость окон — нет) | Валюта детектится и хранится per-row; конверсия в USD на чтении. Живьём формат pricehistory ещё не подтверждён — открыто |
| FX-кэш 12ч, при офлайне может протухнуть/отсутствовать | Нет курса → все `*Usd` поля не-USD предметов = null → сортировка кидает их в конец, USD-фильтры их отсекают — тихие ложноотрицательные | `/api/meta` возвращает `fx.missing` (валюты без курса) — web может предупредить. При добавлении фильтров помни про null-семантику |
| Квота Steam ~1000 запросов/IP за ~30 мин | Полный проход цен (9k+ предметов) за один запуск недостижим | Инварианты 6–7 (возобновляемость + предохранитель); план — пул прокси |
| Один RW-коннект сервера, better-sqlite3 синхронный | Долгий SQL блокирует event loop сервера вместе с API | Пока запросы дешёвые; при fill rate по price_points считать порциями |
| `volume` в снапшотах = cSellOrders (лоты), НЕ объём торгов | Фильтр minVolume фильтрует по предложению, не по обороту | Реальный оборот — sales7d/30d из истории; не путай колонки |

## 7. Правила расширения (чек-лист для нового кода)

- [ ] Новый источник данных площадки → `collector/src/providers/<name>.ts`,
      реализуя `MarketProvider` из shared (интерфейс уже есть, провайдеров пока 0);
      Steam-специфика — только `collector/src/steam/*`.
- [ ] Новая метрика из истории → чистая функция в `collector/src/stats.ts`
      (+ case в stats.selftest.ts), колонка через ensureItemStatsColumns.
- [ ] Новый проход сбора → в runner.ts по образцу enrichHistory: linkedController,
      предохранитель 429, onProgress, кандидаты через listItemsFor* (возобновляемость),
      запуск через CollectorService.begin (409 при занятости).
- [ ] Новое поле API → расчёт в items.ts (USD только через toUsdCents), поле в
      ItemDto сервера И в `web/src/api.ts` (дублированный тип — синхронизируй руками).
- [ ] Новый файл данных → `data/` от корня через import.meta.url + env-override.
- [ ] Любой фильтр по умолчанию НЕ отсекает предметы с null-данными (доктрина, п. 11).
- [ ] Перед коммитом: `npm run build` + `npm run typecheck` + оба selftest'а
      (протокол — table-validation-and-qa; гейты — table-change-control).

## Provenance и поддержка

Факты проверены по коду 2026-07-09 (ветка claude/ecstatic-bardeen-elgcwp,
HEAD 8775cbe). Selftest'ы (`npx tsx packages/shared/src/economics.selftest.ts`,
`npx tsx packages/collector/src/stats.selftest.ts`) выполнены — OK.
Живьём НЕ подтверждено (Steam из контейнера недоступен, 403): формат ответа
pricehistory, фактическое покрытие каталога (~9k — из HANDOFF §2/§3).

Перепроверка того, что может устареть:

| Утверждение | Команда |
|---|---|
| Схема таблиц и view | `sed -n '14,73p' packages/collector/src/db.ts` |
| Инвариант 409/одна задача | `grep -n "Сбор уже выполняется\|begin(" packages/server/src/collectorService.ts` |
| RATE_LIMIT_TRIP, STOP_AFTER_EMPTY, emptyRetryWaits | `grep -n "RATE_LIMIT_TRIP\|STOP_AFTER_EMPTY\|emptyRetryWaits" packages/collector/src/runner.ts` |
| Таймаут/интервал/ретраи HTTP | `grep -n "REQUEST_TIMEOUT_MS\|DEFAULT_INTERVAL_MS\|DEFAULT_MAX_RETRIES\|RATE_LIMIT_PAUSE" packages/collector/src/steam/http.ts` |
| Пути от корня (import.meta.url) | `grep -rn "import.meta.url" packages/*/src` |
| Экспортируемые сабпути collector | `grep -n -A8 '"exports"' packages/collector/package.json` |
| Server не парсит Steam (кроме cookie-check) | `grep -rn "steamcommunity\|@table/collector/steam" packages/server/src` |
| Web ходит только в /api | `grep -n 'BASE' packages/web/src/api.ts && grep -rn "fetch(" packages/web/src` |
| CANDIDATE_CAP / DEFAULT_LIMIT / пороги буста | `grep -n "CANDIDATE_CAP\|DEFAULT_LIMIT\|1.5" packages/server/src/items.ts` |
| Окно price_points 35 дней | `grep -n "WINDOW_SEC" packages/collector/src/repo.ts` |
| FX: TTL, карта валют | `grep -n "TTL_MS\|ECURRENCY_TO_ISO" packages/server/src/fx.ts` |
| Порядок сборки пакетов | `grep -n '"build"' package.json` |
| Мёртвые legacy-модули не импортируются | `grep -rn "histogram\|itemNameId" packages/*/src --include='*.ts' \| grep import` |
