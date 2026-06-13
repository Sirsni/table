import type { SteamHttp } from "./http.js";
import { writeFileSync, mkdirSync } from "node:fs";

// item_nameid встречается в нескольких местах страницы листинга.
const NAMEID_PATTERNS: RegExp[] = [
  /Market_LoadOrderSpread\s*\(\s*(\d+)\s*\)/,
  /ItemActivityTicker\.Start\s*\(\s*(\d+)\s*\)/,
  /item_nameid["'\s:=]+(\d+)/,
];

/**
 * Грузит страницу листинга предмета и извлекает item_nameid.
 * item_nameid не меняется — кешируется навсегда.
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
  for (const re of NAMEID_PATTERNS) {
    const m = re.exec(html);
    if (m) return Number(m[1]);
  }
  // Не нашли — сохраняем страницу для диагностики.
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync("data/last-listing.html", html);
  } catch {
    /* игнор */
  }
  throw new Error(
    `Не найден item_nameid на странице "${marketHashName}" (app ${appId}). ` +
      `HTML сохранён в data/last-listing.html (длина ${html.length}). ` +
      "Возможно, страница вернула капчу/логин-стену/редирект.",
  );
}
