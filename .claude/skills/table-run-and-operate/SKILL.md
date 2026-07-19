---
name: table-run-and-operate
description: Запуск и эксплуатация проекта table — npm run dev/build, CLI коллектора (sync-items, update-prices, enrich-history, probe, top), панель веба (Синхронизировать/Обновить цены/Обновить историю/Стоп/Проверить cookie), ритм сбора, артефакты data/. Загружай при «как запустить», «что нажимать», «в каком порядке собирать», операционных вопросах.
---

# Запуск и эксплуатация

Не использовать для: установки среды (→ table-config-and-env), отладки (→ table-debugging-playbook).

## Команды
- `npm run dev` — predev собирает shared+collector, затем сервер (127.0.0.1:3000) + vite (127.0.0.1:5173, браузер откроется сам). Разовый ECONNREFUSED при старте — норма (гонка).
- `npm run build` / `npm run typecheck` — полная сборка/типы. `npm run start` — prod-сервер (отдаёт web/dist).
- CLI (из корня): `npm run cli -w @table/collector -- <cmd>`: `sync-items [--app 730] [--pages N]`, `update-prices [--limit N] [--currency 1]`, `enrich-history [--limit N]`, `probe --name "AK-47 | Redline (Field-Tested)"`, `top [--limit 20]`. Без limit/pages — весь каталог.

## Панель веба (правильный РИТМ: sync → update → enrich)
| Кнопка | Что делает |
|---|---|
| Синхронизировать список | каталог предметов (search/render, последовательно, паузы на троттлинг) |
| Обновить цены | стакан по каждому предмету (orderbook) — автозапрос/лот |
| Обновить историю | pricehistory (нужен cookie!) → медианы/продажи/буст |
| Проверить cookie | 1 живой запрос истории — работает ли STEAM_COOKIE |
| Стоп | мгновенная отмена (AbortSignal сквозной) |

Поля скорости (параллельность/интервал) применяются ко всем задачам. Статус: processed/total, ok/fail, stoppedReason (читай — там причина авто-остановки: квота/троттлинг).

## Артефакты (data/, в .gitignore)
`table.sqlite(+wal/shm)` — БД; `fx-cache.json` — курсы (TTL 12ч); `sync-debug.log` — сырые пустые ответы search/render (растёт, можно чистить).

## Рабочий цикл поиска прибыли
Фильтр «Мин. продаж/мес» (30–50) → сортировка «Р.маржа» убыв. → «Скрыть возможный буст». Колонки: Покупка/Продажа (зависят от пары Купить на/Продать на: steam_auto=автозапрос, steam=лот), Р.прибыль/Р.маржа — по min(лот, свежая медиана сделок), Скидка — лот vs свежая медиана, Буст — ⚠ xN.

## Ожидания
Проход цен ~10k предметов упрётся в 429-предохранитель — норма; перезапуск продолжает (сортировка по давности). Полная синхронизация каталога недостижима за раз (квота).

## Provenance
2026-07-09; источники: package.json, collector/src/index.ts, web/src/CollectorPanel.tsx, items.ts. Перепроверка CLI: `grep -n "case \"" packages/collector/src/index.ts`.
