/**
 * Экономика Steam Market. Все суммы — integer-копейки.
 *
 * Модель комиссии Steam (для CS2/Dota2/Rust): покупатель платит брутто-цену
 *   gross = base + steamFee + gameFee
 * где base — выручка продавца ("получает на руки"),
 *   steamFee = max(1, floor(base * 0.05))   (5% Steam)
 *   gameFee  = max(1, floor(base * 0.10))   (10% разработчику игры)
 *
 * Нам известна брутто-цена продажи (sellPrice/lowest_sell_order), и нужно
 * посчитать, сколько реально получит продавец. Прямой формулы нет (округления),
 * поэтому подбираем base итеративно: ищем такое base, что
 *   feeFor(base).total === gross.
 * Если точного совпадения нет (бывает из-за округлений Steam) — берём ближайшее
 * валидное base снизу (продавец не получит больше, чем позволяет модель).
 */

export interface SteamFee {
  base: number; // выручка продавца
  steamFee: number;
  gameFee: number;
  total: number; // брутто (что платит покупатель)
}

const STEAM_FEE_RATIO = 0.05;
const GAME_FEE_RATIO = 0.1;

/** Считает комиссии и брутто-цену по базовой выручке продавца. */
export function feeForBase(base: number): SteamFee {
  const steamFee = Math.max(1, Math.floor(base * STEAM_FEE_RATIO));
  const gameFee = Math.max(1, Math.floor(base * GAME_FEE_RATIO));
  return { base, steamFee, gameFee, total: base + steamFee + gameFee };
}

/**
 * По брутто-цене продажи (копейки) возвращает выручку продавца (копейки).
 * Инвертирует модель комиссии Steam.
 */
export function sellerReceives(grossKopecks: number): number {
  const gross = Math.floor(grossKopecks);
  if (!Number.isFinite(gross) || gross <= 0) return 0;

  // Минимальный брутто при base=1: 1 + max(1,0) + max(1,0) = 1+1+1 = 3.
  if (gross < 3) return 0;

  // Грубая оценка base ~ gross/1.15, затем уточняем поиском вокруг неё.
  const guess = Math.floor(gross / (1 + STEAM_FEE_RATIO + GAME_FEE_RATIO));

  // Ищем точное совпадение в небольшом окне вокруг оценки.
  const lo = Math.max(1, guess - 4);
  const hi = guess + 4;
  let bestExact = -1;
  let bestUnder = -1; // наибольший base, дающий total <= gross
  for (let base = lo; base <= hi; base++) {
    const total = feeForBase(base).total;
    if (total === gross) {
      bestExact = base; // точное совпадение
    }
    if (total <= gross && base > bestUnder) {
      bestUnder = base;
    }
  }
  if (bestExact >= 0) return bestExact;
  if (bestUnder >= 0) return bestUnder;

  // Фолбэк (окно не покрыло — на практике не случается): линейный спуск.
  let base = guess;
  while (base > 1 && feeForBase(base).total > gross) base--;
  return Math.max(0, base);
}

/** Прибыль: выручка с продажи по sellPrice минус цена автозапроса buyOrder. */
export function profit(buyOrder: number, sellPrice: number): number {
  return sellerReceives(sellPrice) - buyOrder;
}

/** Маржа в процентах относительно цены автозапроса. */
export function marginPct(buyOrder: number, sellPrice: number): number {
  if (buyOrder <= 0) return 0;
  return (profit(buyOrder, sellPrice) / buyOrder) * 100;
}
