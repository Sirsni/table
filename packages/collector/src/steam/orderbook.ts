import type { SteamHttp } from "./http.js";

/**
 * Новый рынок Steam (React/SSR) отдаёт стакан заявок через эндпоинт
 *   /market/orderbook?q=Load&qp=[appId,"market_hash_name"]
 * по ИМЕНИ предмета — item_nameid больше не требуется.
 *
 * Цены — в минимальных единицах валюты (центы/копейки), integer.
 * Валюта в ответе — поле eCurrency (1 = USD, 5 = RUB, ...). Запрос без
 * параметра валюты возвращает валюту по гео-IP выходного узла.
 */
export interface OrderBook {
  /** Высший автозапрос на покупку (центы) либо null при пустом стакане. */
  highestBuyOrder: number | null;
  /** Низшая цена продажи (центы) либо null при пустом стакане. */
  lowestSellOrder: number | null;
  /** Код валюты ответа (eCurrency). */
  currency: number | null;
  /** Кол-во заявок на покупку (прокси ликвидности спроса). */
  buyOrderCount: number | null;
  /** Кол-во лотов на продажу (прокси ликвидности предложения). */
  sellOrderCount: number | null;
}

interface OrderBookResponseRaw {
  success?: boolean;
  data?: {
    amtMaxBuyOrder?: number | null;
    amtMinSellOrder?: number | null;
    eCurrency?: number | null;
    cBuyOrders?: number | null;
    cSellOrders?: number | null;
  } | null;
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Тянет стакан заявок по имени предмета.
 * @param currency необязательный код валюты Steam (5 = RUB, 1 = USD). Если не
 *   задан — Steam выбирает валюту сам (по гео выходного IP).
 */
export async function fetchOrderBook(
  http: SteamHttp,
  appId: number,
  marketHashName: string,
  currency?: number,
): Promise<OrderBook> {
  // qp — JSON-массив [appId, name]; URLSearchParams корректно кодирует
  // пробелы/& /кавычки.
  const qp = JSON.stringify([appId, marketHashName]);
  const params = new URLSearchParams({ q: "Load", qp });
  if (currency != null) params.set("currency", String(currency));
  const url = `https://steamcommunity.com/market/orderbook?${params.toString()}`;

  const data = await http.getJson<OrderBookResponseRaw>(url);
  if (!data.success || !data.data) {
    throw new Error(
      `orderbook вернул success=${data.success} для "${marketHashName}" (app ${appId})`,
    );
  }
  const d = data.data;
  return {
    highestBuyOrder: numOrNull(d.amtMaxBuyOrder),
    lowestSellOrder: numOrNull(d.amtMinSellOrder),
    currency: numOrNull(d.eCurrency),
    buyOrderCount: numOrNull(d.cBuyOrders),
    sellOrderCount: numOrNull(d.cSellOrders),
  };
}
