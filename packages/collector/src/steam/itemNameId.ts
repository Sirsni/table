import type { SteamHttp } from "./http.js";

// Market_LoadOrderSpread( 123456 ) — пробелы вокруг числа вариативны.
const NAMEID_RE = /Market_LoadOrderSpread\s*\(\s*(\d+)\s*\)/;

/**
 * Грузит страницу листинга предмета и извлекает item_nameid из вызова
 * Market_LoadOrderSpread(<digits>). item_nameid не меняется — кешируется навсегда.
 */
export async function resolveItemNameId(
  http: SteamHttp,
  appId: number,
  marketHashName: string,
): Promise<number> {
  const url = `https://steamcommunity.com/market/listings/${appId}/${encodeURIComponent(
    marketHashName,
  )}`;
  const html = await http.getText(url);
  const m = NAMEID_RE.exec(html);
  if (!m) {
    throw new Error(
      `Не найден item_nameid (Market_LoadOrderSpread) на странице "${marketHashName}" (app ${appId}). ` +
        "Возможно, предмет снят с продажи или страница вернула капчу/редирект.",
    );
  }
  return Number(m[1]);
}
