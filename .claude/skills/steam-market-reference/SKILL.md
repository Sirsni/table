---
name: steam-market-reference
description: Справочник Steam Market для проекта table — эндпоинты (search/render, orderbook, pricehistory, priceoverview), квоты и баны (429/403, ~1000 req/IP), комиссия и sellerReceives, eCurrency-коды, commodity/non-commodity, trade hold. Загружай при любой работе со Steam API, словах endpoint, quota, ban, fee, currency, стакан, автозапрос.
---

# Steam Market — доменный справочник

Не использовать для: отладки симптомов (→ table-debugging-playbook), запуска (→ table-run-and-operate).

## Эндпоинты (все в packages/collector/src/steam/)

| Эндпоинт | Что даёт | Ловушки |
|---|---|---|
| `/market/search/render/?appid=A&norender=1&count=100&start=N` | каталог: имя, sell_price, sell_listings, иконка | `count` ИГНОРИРУЕТСЯ (~10/стр); тихий троттлинг = 200 с `{success:true,total_count:0,results:[]}` раз в ~30 запросов; total_count из пустых страниц — ложь. Сырьё пустых: data/sync-debug.log |
| `/market/orderbook?q=Load&qp=[appid,"name"]` | amtMaxBuyOrder (автозапрос), amtMinSellOrder (нижний лот), eCurrency, cBuyOrders, cSellOrders | по ИМЕНИ (item_nameid мёртв с редизайна рынка); валюта = гео выходного IP, параметр currency игнорируется |
| `/market/pricehistory/?appid=A&market_hash_name=N` | ВСЯ история сделок: последний месяц почасово, старше — по дням; формат точки `["Jul 14 2023 01: +0", 12.34, "57"]` | нужен cookie steamLoginSecure; валюта = ВАЛЮТА КОШЕЛЬКА аккаунта (детект по price_prefix/suffix — pricehistory.ts) |
| `/market/priceoverview` | медиана+объём за 24ч, анонимно | слабый; не используется |

## Квоты и баны (по логам владельца, из контейнера непроверяемо — 403)
- ~1000 запросов/IP за окно ~30 мин → 429, бан ~15+ мин. НЕ зависит от скорости (1 req/s банит так же).
- Датацентровые IP → 403 всегда (контейнер Claude не может в Steam).
- search/render дополнительно тихо троттлит (см. выше) — паузы 0.5–30с пережидают (runner.ts).

## Комиссия
`gross = base + max(1,floor(base*0.05)) + max(1,floor(base*0.10))`. Инверсия подбором: `sellerReceives()` в packages/shared/src/economics.ts. Проверено против Steam: $1000 → $869.58. Деньги Steam — «фантики»: кэшаут только через внешние площадки (→ marketplace-integration-campaign).

## eCurrency (fx.ts): 1 USD, 2 GBP, 3 EUR, 4 CHF, 5 RUB, 6 PLN, 7 BRL, 8 JPY, 9 NOK, 18 UAH, 20 CAD, 21 AUD.

## Механика
- Commodity (кейсы): единый стакан. Non-commodity (скины): лоты; у дорогих может не быть автозапросов/лотов.
- Автозапрос (bid) исполняется, когда кто-то продаёт «в бид» — отсюда fill rate по истории.
- App id: CS2=730, Dota2=570, Rust=252490. Trade hold ~7 дней. Автоматизация — серая зона ToS: отдельный аккаунт.

## Provenance
Проверено 2026-07-09 по steam/*.ts, HANDOFF.md §2. Перепроверка: `grep -n "search/render\|orderbook\|pricehistory" packages/collector/src/steam/*.ts`.
