---
name: table-config-and-env
description: Все env-переменные проекта table и среда с нуля — STEAM_COOKIE/PROXY/INTERVAL_MS/CONCURRENCY/TIMEOUT_MS, DB_PATH, FX_CACHE_PATH, PORT; установка на Windows владельца (Node 22, Happ/VLESS, .env, cookie). Загружай при setup, env, .env, конфигурации, переустановке, «не подхватился cookie», Node/npm install проблемах.
---

# Конфигурация и среда

Не использовать для: симптомов после установки (→ table-debugging-playbook), команд запуска (→ table-run-and-operate).

## Env-переменные (перепроверка: `grep -rn "process.env" packages/*/src`)

| Переменная | Что делает | Дефолт | Где читается |
|---|---|---|---|
| STEAM_COOKIE | steamLoginSecure для pricehistory | — | steam/http.ts |
| STEAM_PROXY | http-прокси для всех Steam-запросов | — | steam/http.ts |
| STEAM_INTERVAL_MS | интервал троттла | 3000 | steam/http.ts |
| STEAM_CONCURRENCY | параллельность пула | 1 | steam/http.ts |
| STEAM_TIMEOUT_MS | таймаут одного запроса | 20000 | steam/http.ts |
| DB_PATH | путь SQLite (тесты!) | <корень>/data/table.sqlite | collector/db.ts |
| FX_CACHE_PATH | кэш курсов | <корень>/data/fx-cache.json | server/fx.ts |
| PORT | порт API | 3000 | server/server.ts |

`.env` в КОРНЕ репо, грузится через `node --env-file-if-exists=../../.env` в скриптах package.json (server dev/start, collector cli). Панель веба может переопределять interval/concurrency на запуск.

## Среда с нуля (Windows владельца)
1. **Node 22 LTS СТРОГО** (Node 24 ломает better-sqlite3: нет prebuilt → node-gyp/Python-ад). Проверка: `node -v`.
2. `git clone -b claude/ecstatic-bardeen-elgcwp <repo>` → `cd table` → `npm install` → `npm run build`.
3. Включить показ расширений файлов (Проводник → Вид), иначе `.env` окажется `.env.txt` — классический инцидент.
4. Создать `.env`: строка `STEAM_COOKIE=<value>`. Добыча cookie: ВТОРОЙ аккаунт Steam → F12 → Application → Cookies → steamcommunity.com → `steamLoginSecure` → Value. **Секреты НИКОГДА не в чат.**
5. Туннель Happ (VLESS Reality), режим «для выбранных приложений»: **node.exe обязан быть в списке** (`C:\Program Files\nodejs\node.exe`), иначе 403/429 (CGNAT/датацентр-детект).
6. Везде 127.0.0.1, не localhost (Windows → ::1). PowerShell не знает `&&` — команды по одной.

## Скорости
Рабочий диапазон: concurrency 5–15, интервал 200–500мс. Квоту ~1000/IP скоростью НЕ обойти — только ждать/прокси (деньги — с согласия владельца).

## Контейнер Claude
Steam → 403 всегда; данных в data/ нет. Проверки только синтетикой (→ table-diagnostics-and-tooling).

## Provenance
2026-07-09; источники: package.json скрипты, steam/http.ts, HANDOFF §2. Windows-шаги — из живых инцидентов сессии, из контейнера невоспроизводимы.
