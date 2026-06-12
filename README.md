# table

Сервис для сравнения цен предметов на Steam Market (CS2, Dota 2, Rust) и
других торговых площадках. План разработки по этапам — см. [PLAN.md](./PLAN.md).

## Установка

```sh
npm install
npm run build
```

## Структура

- `packages/shared` — общие типы и константы.
- `packages/collector` — сборщик цен (парсер) и работа с локальной БД SQLite.
