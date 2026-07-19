---
name: table-analysis-toolkit
description: Математика проекта table как рецепты — инверсия комиссии Steam, взвешенная медиана/перцентиль, VWAP, окна baseline/recent и boostScore, кламп realSell=min(лот, свежая медиана), валютная дисциплина. Загружай при изменении/проверке метрик, словах median, VWAP, percentile, boost, real margin, formula.
---

# Аналитический тулкит (формулы и почему они такие)

Не использовать для: исполнения кампании (→ table-profit-detection-campaign).

## 1. Комиссия Steam
`gross = base + max(1,floor(base×0.05)) + max(1,floor(base×0.10))`; прямой формулы инверсии нет (округления) → `sellerReceives(gross)` подбирает base (shared/src/economics.ts). Эталон: $1000 → $869.58 (сверено со Steam). Ручная проверка: `node -e "import('./packages/shared/dist/economics.js').then(m=>console.log(m.sellerReceives(100000)))"` → 86958.

## 2. Взвешенная медиана / перцентиль (stats.ts)
Сортировка точек по цене, кумулятивная сумма qty, первая цена где cum ≥ total×q (медиана q=0.5, p25 q=0.25). На чётной границе — нижнее значение (конвенция). Эталоны — в stats.selftest.ts (запускай его).

## 3. VWAP vs медиана
VWAP = Σ(price×qty)/Σqty — хранится как avg; для realSell используется МЕДИАНА: устойчива к выбросам (один аномальный дорогой день не сдвигает оценку).

## 4. Окна и boostScore
baseline = взвеш. медиана точек [now−30д, now−3д) (мин. 5 шт); recent = [now−3д] (мин. 3 шт); boostScore = recent/baseline. 3 дня исключаются из baseline, чтобы буст не загрязнял собственную норму. Порог подозрения 1.5 (эвристика, кандидат на v2 → table-research-frontier). boostSuspect также при лот ≥ 1.5× медианы-30д и sales30d ≥ 5.

## 5. Кламп realSell = min(нижний лот, свежая медиана recent??7d??30d)
Один механизм закрывает ОБА хвоста: обвал (Cologne 2026-стикеры: лот копеечный, медиана месяца в разы выше и НЕДОСТИЖИМА — продать дороже лота нельзя) и буст (лот задран — медиана возвращает честную цену). Реальная выручка = sellerReceives(realSell), реальная маржа — от неё. Числа кейсов — в тексте коммита 751bb4e.

## 6. Валютная дисциплина
Всё в БД — integer minor units + код валюты РЯДОМ. Сравнивать/вычитать величины МОЖНО только после приведения обеих в USD-центы (fx.toUsdCents). Главные грабли: price_points/item_stats — в валюте КОШЕЛЬКА аккаунта; price_snapshots — в валюте гео-IP. Смешивание без конвертации = ошибки в разы (инцидент «медианы ×70»).

## 7. Ручная перепроверка любой метрики
SQL точек предмета → пересчёт node-однострочником → сверка с item_stats → сверка с UI. Расхождение = баг, а не «погрешность».

## Provenance
2026-07-09; источники: economics.ts, stats.ts(+selftest), items.ts, коммиты 751bb4e/8775cbe. Перепроверка окон: `grep -n "since7\|since30\|baseline" packages/collector/src/stats.ts`.
