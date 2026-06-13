import type { SteamHttp } from "./http.js";

export interface OrderHistogram {
  /** Высший автозапрос на покупку (копейки) либо null при пустом стакане. */
  highestBuyOrder: number | null;
  /** Низшая цена продажи (копейки) либо null при пустом стакане. */
  lowestSellOrder: number | null;
}

interface HistogramResponseRaw {
  success?: number;
  highest_buy_order?: string | null;
  lowest_sell_order?: string | null;
}

/** "12345" -> 12345; "" / null / undefined / нечисло -> null. */
function parseKopecks(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Тянет стакан заявок по item_nameid. Цены приходят строками в копейках.
 * success !== 1 трактуется как ошибка.
 */
export async function fetchOrderHistogram(
  http: SteamHttp,
  itemNameId: number,
): Promise<OrderHistogram> {
  const params = new URLSearchParams({
    country: "RU",
    language: "russian",
    currency: "5",
    item_nameid: String(itemNameId),
    two_factor: "0",
  });
  const url = `https://steamcommunity.com/market/itemordershistogram?${params.toString()}`;

  const data = await http.getJson<HistogramResponseRaw>(url);
  if (data.success !== 1) {
    throw new Error(
      `itemordershistogram вернул success=${data.success} для item_nameid=${itemNameId}`,
    );
  }

  return {
    highestBuyOrder: parseKopecks(data.highest_buy_order),
    lowestSellOrder: parseKopecks(data.lowest_sell_order),
  };
}
