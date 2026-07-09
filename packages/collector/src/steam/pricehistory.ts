import type { SteamHttp } from "./http.js";

/**
 * История продаж предмета на торговой площадке Steam:
 *   /market/pricehistory/?appid=<app>&currency=<cur>&market_hash_name=<name>
 *
 * Эндпоинт ТРЕБУЕТ cookie залогиненного аккаунта (steamLoginSecure). Без него
 * Steam отдаёт success:false (или редирект на логин). Задавай STEAM_COOKIE.
 *
 * Формат ответа:
 *   {
 *     success: boolean,
 *     price_prefix: string,
 *     price_suffix: string,
 *     prices: Array<[dateStr, medianPrice, qtyStr]>
 *   }
 * Точка: ["Jul 14 2023 01: +0", 12.34, "57"]
 *   — дата (строка), медианная цена (float, в валюте запроса), число продаж (строка).
 */

export interface PriceHistoryPoint {
  /** Дата точки (день торгов). */
  date: Date;
  /** Медианная цена за день в МИНИМАЛЬНЫХ единицах валюты запроса (центы). */
  priceCents: number;
  /** Число проданных штук за день. */
  qty: number;
}

export interface PriceHistory {
  points: PriceHistoryPoint[];
  /**
   * ФАКТИЧЕСКАЯ валюта истории (Steam eCurrency), определённая по
   * price_prefix/suffix ответа, либо null, если распознать не удалось.
   * ВАЖНО: pricehistory ИГНОРИРУЕТ параметр currency в URL и отдаёт цены в
   * валюте КОШЕЛЬКА аккаунта, чей cookie использован (у RU-аккаунта — рубли).
   */
  currency: number | null;
}

/**
 * Определяет Steam eCurrency по префиксу/суффиксу цены из ответа pricehistory.
 * Steam пишет «руб.» иногда с латинской p («pуб.») — матчим оба алфавита.
 */
export function detectHistoryCurrency(
  prefix: string | undefined,
  suffix: string | undefined,
): number | null {
  const s = `${prefix ?? ""} ${suffix ?? ""}`.trim();
  if (s === "") return null;
  if (/[pр]у[б6]/i.test(s)) return 5; // RUB («руб.» / «pуб.»)
  if (s.includes("zł")) return 6; // PLN
  if (s.includes("€")) return 3; // EUR
  if (s.includes("£")) return 2; // GBP
  if (s.includes("CHF")) return 4;
  if (s.includes("R$")) return 7; // BRL
  if (s.includes("¥")) return 8; // JPY
  if (s.includes("kr")) return 9; // NOK (и прочие kr — трактуем как NOK)
  if (s.includes("₴")) return 18; // UAH
  if (s.includes("CDN$")) return 20; // CAD
  if (s.includes("A$")) return 21; // AUD
  if (s.includes("$")) return 1; // USD (после проверки составных *$)
  return null;
}

interface PriceHistoryResponseRaw {
  success?: boolean;
  price_prefix?: string;
  price_suffix?: string;
  // Steam отдаёт смешанные типы: [string, number, string]
  prices?: Array<[string, number, string]> | null;
}

/**
 * Парсит дату Steam-формата "Mon DD YYYY HH: +0".
 * Хвост " +0" (часовой пояс-заглушка) Date.parse не понимает — отрезаем его,
 * остаётся "Mon DD YYYY HH:" → ещё убираем висящее двоеточие после часа.
 * Возвращает null, если получился невалидный Date.
 */
export function parseSteamDate(raw: string): Date | null {
  // "Jul 14 2023 01: +0" -> "Jul 14 2023 01:00:00"
  let s = raw.trim();
  // отрезаем хвост вида " +0" / " +1" (смещение, которое Date не парсит)
  s = s.replace(/\s*\+\d+\s*$/, "").trim();
  // "Jul 14 2023 01:" -> час без минут; нормализуем "HH:" -> "HH:00"
  s = s.replace(/(\d{1,2}):\s*$/, "$1:00");
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t);
  // запасной вариант: без часа вовсе ("Jul 14 2023")
  const s2 = s.replace(/\s+\d{1,2}(:\d{2})?$/, "").trim();
  const t2 = Date.parse(s2);
  return Number.isFinite(t2) ? new Date(t2) : null;
}

export async function fetchPriceHistory(
  http: SteamHttp,
  appId: number,
  marketHashName: string,
  currency = 1,
  signal?: AbortSignal,
): Promise<PriceHistory> {
  if (!http.hasCookie) {
    throw new Error(
      "pricehistory требует STEAM_COOKIE (cookie залогиненного аккаунта). " +
        "Задай env STEAM_COOKIE=steamLoginSecure=...",
    );
  }

  const url =
    `https://steamcommunity.com/market/pricehistory/?appid=${appId}` +
    `&currency=${currency}` +
    `&market_hash_name=${encodeURIComponent(marketHashName)}`;

  const data = await http.getJson<PriceHistoryResponseRaw>(url, signal);

  if (data.success !== true || !Array.isArray(data.prices)) {
    throw new Error(
      `pricehistory вернул success=${data.success} для "${marketHashName}" ` +
        `(app ${appId}). Проверь STEAM_COOKIE — он мог истечь.`,
    );
  }
  if (data.prices.length === 0) {
    throw new Error(
      `pricehistory: пустая история для "${marketHashName}" (app ${appId})`,
    );
  }

  const points: PriceHistoryPoint[] = [];
  for (const row of data.prices) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const [dateStr, median, qtyStr] = row;
    const date = parseSteamDate(String(dateStr));
    if (date === null) continue; // битая дата — пропускаем точку
    if (typeof median !== "number" || !Number.isFinite(median)) continue;
    const qty = Math.trunc(Number(qtyStr));
    if (!Number.isFinite(qty) || qty < 0) continue;
    points.push({
      date,
      priceCents: Math.round(median * 100),
      qty,
    });
  }

  if (points.length === 0) {
    throw new Error(
      `pricehistory: нет валидных точек для "${marketHashName}" (app ${appId})`,
    );
  }

  return {
    points,
    currency: detectHistoryCurrency(data.price_prefix, data.price_suffix),
  };
}
