import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Конвертация цен Steam в доллары США. ОБЯЗАН переживать отсутствие сети:
 * при недоступном API курсов используем файловый кэш; если и его нет —
 * конвертация для не-USD валют вернёт null (цены просто не покажутся в USD).
 *
 * Источник курсов: open.er-api.com/v6/latest/USD. Поле rates: { EUR: .., PLN: .. }
 * — это СКОЛЬКО ЕДИНИЦ валюты за 1 USD. Значит:
 *   usd = amount / rate[ISO].
 * Суммы в минимальных единицах (центы/гроши) делятся на тот же rate, т.к.
 * множитель 1/100 сокращается: usdCents = round(amountMinor / rate[ISO]).
 */

/** Steam eCurrency -> ISO 4217. Неизвестный код -> null (не конвертируем). */
const ECURRENCY_TO_ISO: Record<number, string> = {
  1: "USD",
  2: "GBP",
  3: "EUR",
  4: "CHF",
  5: "RUB",
  6: "PLN",
  7: "BRL",
  8: "JPY",
  9: "NOK",
  18: "UAH",
  20: "CAD",
  21: "AUD",
};

export function eCurrencyToIso(eCurrency: number | null): string | null {
  if (eCurrency === null) return null;
  return ECURRENCY_TO_ISO[eCurrency] ?? null;
}

const API_URL = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 12 * 60 * 60 * 1000; // 12 часов
const FETCH_TIMEOUT_MS = 8000;

interface FxCache {
  fetchedAt: string; // ISO-время последнего успешного обновления
  rates: Record<string, number>; // ISO -> единиц валюты за 1 USD
}

function cachePath(): string {
  return process.env.FX_CACHE_PATH ?? "data/fx-cache.json";
}

// Кэш в памяти на время жизни процесса.
let memory: FxCache | null = null;

function isFresh(c: FxCache): boolean {
  const t = Date.parse(c.fetchedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < TTL_MS;
}

function readFileCache(): FxCache | null {
  try {
    const raw = readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<FxCache>;
    if (
      parsed &&
      typeof parsed.fetchedAt === "string" &&
      parsed.rates &&
      typeof parsed.rates === "object"
    ) {
      return { fetchedAt: parsed.fetchedAt, rates: parsed.rates };
    }
  } catch {
    // нет файла / битый JSON — нет кэша
  }
  return null;
}

function writeFileCache(c: FxCache): void {
  try {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(c, null, 2));
  } catch {
    // не критично: останется кэш в памяти
  }
}

interface ErApiResponse {
  result?: string;
  rates?: Record<string, number> | null;
}

async function fetchRates(): Promise<Record<string, number> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as ErApiResponse;
    if (data.result !== "success" || !data.rates) return null;
    // Берём только числовые курсы.
    const rates: Record<string, number> = {};
    for (const [iso, v] of Object.entries(data.rates)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) rates[iso] = v;
    }
    return Object.keys(rates).length > 0 ? rates : null;
  } catch {
    return null; // таймаут / сеть недоступна / битый JSON
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Гарантирует наличие актуальных курсов в памяти.
 * Порядок: свежий кэш в памяти -> свежий файл-кэш -> запрос к API ->
 * протухший файл-кэш (лучше старые курсы, чем никакие) -> пустые курсы.
 * Никогда не бросает: сеть может быть недоступна.
 */
export async function ensureRates(): Promise<void> {
  if (memory && isFresh(memory)) return;

  // Подхватим файл-кэш (на случай рестарта процесса).
  if (!memory) {
    const file = readFileCache();
    if (file) {
      memory = file;
      if (isFresh(file)) return;
    }
  }

  // Кэш протух или его нет — пробуем сеть.
  const fresh = await fetchRates();
  if (fresh) {
    memory = { fetchedAt: new Date().toISOString(), rates: fresh };
    writeFileCache(memory);
    return;
  }

  // Сеть не дала результата. Оставляем то, что есть (протухший memory/файл),
  // либо инициализируем пустыми курсами, чтобы toUsdCents не падал.
  if (!memory) {
    memory = { fetchedAt: new Date(0).toISOString(), rates: {} };
  }
}

/** Текущие курсы (только чтение). Может быть пустым при офлайне без кэша. */
function currentRates(): Record<string, number> {
  return memory?.rates ?? {};
}

/**
 * Сумма в минимальных единицах исходной валюты -> центы USD.
 * Неизвестная валюта/отсутствующий курс/невалидная сумма -> null.
 */
export function toUsdCents(
  amountMinor: number | null,
  eCurrency: number | null,
): number | null {
  if (amountMinor === null || !Number.isFinite(amountMinor)) return null;
  const iso = eCurrencyToIso(eCurrency);
  if (iso === null) return null;
  if (iso === "USD") return Math.round(amountMinor);
  const rate = currentRates()[iso];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  return Math.round(amountMinor / rate);
}

/** Список ISO-валют, для которых нужен курс, но его нет в текущих rates. */
export function fxStatus(): { updatedAt: string | null; missing: string[] } {
  const rates = currentRates();
  const updatedAt =
    memory && Date.parse(memory.fetchedAt) > 0 ? memory.fetchedAt : null;
  const missing: string[] = [];
  for (const iso of Object.values(ECURRENCY_TO_ISO)) {
    if (iso === "USD") continue; // USD не требует курса
    if (typeof rates[iso] !== "number") missing.push(iso);
  }
  return { updatedAt, missing };
}
