import PQueue from "p-queue";
import { ProxyAgent } from "undici";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_INTERVAL_MS = 3000;
const DEFAULT_MAX_RETRIES = 4;

/** Ошибка, означающая блокировку датацентрового IP (HTTP 403). */
export class SteamBlockedError extends Error {
  constructor(url: string) {
    super(
      `Steam вернул 403 для ${shortenUrl(url)}. ` +
        "Steam блокирует датацентровые IP, запускай с домашнего IP или через прокси.",
    );
    this.name = "SteamBlockedError";
  }
}

/** Прочие HTTP-ошибки после исчерпания ретраев. */
export class SteamHttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`Steam HTTP ${status} для ${shortenUrl(url)} (ретраи исчерпаны)`);
    this.name = "SteamHttpError";
    this.status = status;
  }
}

/** Запрос прерван по AbortSignal (нажат «Стоп» / сработал предохранитель). */
export class SteamAbortError extends Error {
  constructor() {
    super("Запрос отменён");
    this.name = "SteamAbortError";
  }
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    // оставляем path + пару ключевых параметров, без полной простыни query
    const keep = ["appid", "start", "item_nameid"];
    const params: string[] = [];
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v !== null) params.push(`${k}=${v}`);
    }
    const q = params.length ? `?${params.join("&")}` : "";
    return `${u.host}${u.pathname}${q}`;
  } catch {
    return url;
  }
}

/** Пауза, прерываемая через AbortSignal (для мгновенной остановки сбора). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SteamAbortError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new SteamAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Сколько раз повторять на 429: коротко. При лимите долбить бесполезно —
// проход сам остановится предохранителем в runner.
const RATE_LIMIT_RETRIES = 1;
const RATE_LIMIT_PAUSE_MS = 3000;

// Таймаут одного запроса. Без него undici-fetch может зависнуть навсегда на
// оборванном соединении (нестабильный тоннель/VPN) — и пул воркеров «замерзает».
// По таймауту запрос прерывается и ретраится как сетевая ошибка.
const REQUEST_TIMEOUT_MS = (() => {
  const v = Number(process.env.STEAM_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 20000;
})();

/** Экспоненциальная пауза 2s,4s,8s,16s + джиттер до 1s. */
function backoffMs(attempt: number): number {
  const base = 2000 * 2 ** attempt; // attempt 0 -> 2000
  const jitter = Math.floor(Math.random() * 1000);
  return base + jitter;
}

export interface SteamHttpOptions {
  intervalMs?: number;
  maxRetries?: number;
  concurrency?: number;
}

/**
 * Единая точка HTTP к Steam: throttle через PQueue (1 запрос / intervalMs),
 * ретраи с экспоненциальной паузой на 429/5xx/сетевые ошибки.
 */
export class SteamHttp {
  private readonly queue: PQueue;
  private readonly maxRetries: number;
  private readonly dispatcher: ProxyAgent | undefined;
  private readonly concurrencyValue: number;
  /** Готовое значение заголовка Cookie (или undefined, если не задан). */
  private readonly cookie: string | undefined;

  /** Сконфигурированная параллельность — размер пула для вызывающего (runner). */
  get concurrency(): number {
    return this.concurrencyValue;
  }

  constructor(opts: SteamHttpOptions = {}) {
    // Интервал между запросами: опция -> env STEAM_INTERVAL_MS -> дефолт 3000.
    const envInterval = Number(process.env.STEAM_INTERVAL_MS);
    const intervalMs =
      opts.intervalMs ??
      (Number.isFinite(envInterval) && envInterval > 0
        ? envInterval
        : DEFAULT_INTERVAL_MS);
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (intervalMs !== DEFAULT_INTERVAL_MS) {
      console.log(`[steam] интервал между запросами: ${intervalMs}ms`);
    }
    // Параллельность: опция -> env STEAM_CONCURRENCY -> дефолт 1 (серийно).
    const envConc = Number(process.env.STEAM_CONCURRENCY);
    const envConcurrency =
      Number.isFinite(envConc) && envConc > 0 ? Math.floor(envConc) : 1;
    const concurrency =
      opts.concurrency != null && opts.concurrency > 0
        ? Math.floor(opts.concurrency)
        : envConcurrency;
    if (concurrency > 1) {
      console.log(`[steam] параллельных запросов: ${concurrency}`);
    }
    this.concurrencyValue = concurrency;
    this.queue = new PQueue({
      concurrency,
      interval: intervalMs,
      intervalCap: concurrency,
    });
    // STEAM_PROXY=http://user:pass@host:port — пускаем запросы через прокси,
    // если прямой IP забанен/задушен Steam (CGNAT, датацентр и т.п.).
    const proxyUrl = process.env.STEAM_PROXY;
    if (proxyUrl) {
      this.dispatcher = new ProxyAgent(proxyUrl);
      console.log(`[steam] использую прокси из STEAM_PROXY`);
    }
    // STEAM_COOKIE — cookie залогиненного аккаунта (нужен для pricehistory).
    // Если задан «голый» токен без '=', оборачиваем как steamLoginSecure=<token>.
    // Значение НЕ логируем.
    const rawCookie = process.env.STEAM_COOKIE?.trim();
    if (rawCookie) {
      this.cookie = rawCookie.includes("=")
        ? rawCookie
        : `steamLoginSecure=${rawCookie}`;
      console.log(`[steam] STEAM_COOKIE задан — запросы пойдут с авторизацией`);
    }
  }

  /** Есть ли cookie авторизации (для понятных ошибок у вызывающих). */
  get hasCookie(): boolean {
    return this.cookie !== undefined;
  }

  async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const text = await this.getText(url, signal);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Steam вернул не-JSON ответ для ${shortenUrl(url)}`);
    }
  }

  getText(url: string, signal?: AbortSignal): Promise<string> {
    // оборачиваем в очередь, чтобы соблюсти rate-limit между всеми запросами
    return this.queue.add(() => this.fetchWithRetry(url, signal), {
      throwOnTimeout: true,
    }) as Promise<string>;
  }

  private async fetchWithRetry(
    url: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let lastErr: unknown;
    let forbiddenSeen = false;
    let rateLimitTries = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw new SteamAbortError();
      try {
        // Таймаут на запрос + внешняя отмена («Стоп»/предохранитель) — единым
        // сигналом. По таймауту fetch прервётся и пойдёт в ретрай (см. catch).
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const reqSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        const res = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "ru-RU,ru;q=0.9",
            Accept: "application/json, text/javascript, text/html, */*; q=0.01",
            // Cookie добавляем только если задан — иначе запрос как раньше.
            ...(this.cookie ? { Cookie: this.cookie } : {}),
          },
          signal: reqSignal,
          // undici-специфичное поле, в типах RequestInit его нет
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        } as RequestInit);

        if (res.ok) {
          console.log(`[steam] GET ${shortenUrl(url)} -> ${res.status}`);
          return await res.text();
        }

        // 403 — датацентровый IP: один повтор, потом понятная ошибка.
        if (res.status === 403) {
          console.warn(
            `[steam] GET ${shortenUrl(url)} -> 403 (попытка ${attempt + 1})`,
          );
          if (forbiddenSeen) {
            throw new SteamBlockedError(url);
          }
          forbiddenSeen = true;
          await sleep(2000, signal);
          continue;
        }

        // 429 — лимит. Быстрый отказ: один короткий повтор, затем ошибка
        // (решение «остановить весь проход» принимает предохранитель в runner).
        if (res.status === 429) {
          if (rateLimitTries >= RATE_LIMIT_RETRIES) {
            console.warn(`[steam] GET ${shortenUrl(url)} -> 429 (лимит)`);
            throw new SteamHttpError(429, url);
          }
          rateLimitTries++;
          attempt--; // короткий 429-повтор не тратит общий бюджет ретраев
          await sleep(RATE_LIMIT_PAUSE_MS, signal);
          continue;
        }

        // 5xx — ретраим с экспоненциальной паузой.
        if (res.status >= 500) {
          const retriable = attempt < this.maxRetries;
          const pause = backoffMs(attempt);
          console.warn(
            `[steam] GET ${shortenUrl(url)} -> ${res.status} ` +
              `(попытка ${attempt + 1}${retriable ? `, пауза ${pause}ms` : ", ретраи исчерпаны"})`,
          );
          if (!retriable) throw new SteamHttpError(res.status, url);
          await sleep(pause, signal);
          continue;
        }

        // Прочие 4xx — не ретраим, бросаем сразу.
        console.warn(`[steam] GET ${shortenUrl(url)} -> ${res.status}`);
        throw new SteamHttpError(res.status, url);
      } catch (err) {
        // Отмена и наши «терминальные» ошибки не глушим и не ретраим.
        if (
          err instanceof SteamAbortError ||
          err instanceof SteamBlockedError ||
          err instanceof SteamHttpError
        ) {
          throw err;
        }
        // ТОЛЬКО внешняя отмена («Стоп»/предохранитель) терминальна. Таймаут
        // запроса (timeoutSignal) тоже бросает AbortError, но это НЕ отмена —
        // его ретраим как сетевую ошибку, иначе зависший запрос убил бы воркер.
        if (signal?.aborted) {
          throw new SteamAbortError();
        }
        // Сетевая ошибка или таймаут запроса — ретраим.
        lastErr = err;
        const retriable = attempt < this.maxRetries;
        const pause = backoffMs(attempt);
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[steam] GET ${shortenUrl(url)} -> сетевая ошибка: ${msg} ` +
            `(попытка ${attempt + 1}${retriable ? `, пауза ${pause}ms` : ", ретраи исчерпаны"})`,
        );
        if (!retriable) break;
        await sleep(pause, signal);
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Не удалось загрузить ${shortenUrl(url)}`);
  }
}
