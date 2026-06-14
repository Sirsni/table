/** Хелперы форматирования значений для таблицы. */

const ICON_BASE = "https://community.fastly.steamstatic.com/economy/image/";

/** Форматирует доллары: "$1.98" или "—" для null. */
export function usd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

/** Форматирует проценты: "−8.96%" или "—" для null. Минус — типографский (U+2212). */
export function pct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

/**
 * Превращает iconUrl из ItemDto в готовый src для <img>.
 * - null -> null (нет иконки).
 * - значение, начинающееся с http -> как есть (уже полный URL).
 * - иначе -> фрагмент пути иконки от Steam, собираем полный URL.
 */
export function iconSrc(iconUrl: string | null): string | null {
  if (iconUrl === null) return null;
  if (iconUrl.startsWith("http")) return iconUrl;
  return `${ICON_BASE}${iconUrl}/48fx48f`;
}

/** Короткая дата/время для столбца "Обновлено". */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
