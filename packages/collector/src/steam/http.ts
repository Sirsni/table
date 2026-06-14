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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  }

  async getJson<T>(url: string): Promise<T> {
    const text = await this.getText(url);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Steam вернул не-JSON ответ для ${shortenUrl(url)}`);
    }
  }

  getText(url: string): Promise<string> {
    // оборачиваем в очередь, чтобы соблюсти rate-limit между всеми запросами
    return this.queue.add(() => this.fetchWithRetry(url), {
      throwOnTimeout: true,
    }) as Promise<string>;
  }

  private async fetchWithRetry(url: string): Promise<string> {
    let lastErr: unknown;
    let forbiddenSeen = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "ru-RU,ru;q=0.9",
            Accept: "application/json, text/javascript, text/html, */*; q=0.01",
          },
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
          await sleep(2000);
          continue;
        }

        // 429 / 5xx — ретраим с паузой.
        if (res.status === 429 || res.status >= 500) {
          const retriable = attempt < this.maxRetries;
          let pause = backoffMs(attempt);
          // Бан по 429 у Steam держится минуты — ждём 30s, 60s, 120s, 240s.
          if (res.status === 429) pause = 30000 * 2 ** attempt;
          console.warn(
            `[steam] GET ${shortenUrl(url)} -> ${res.status} ` +
              `(попытка ${attempt + 1}${retriable ? `, пауза ${pause}ms` : ", ретраи исчерпаны"})`,
          );
          if (!retriable) throw new SteamHttpError(res.status, url);
          await sleep(pause);
          continue;
        }

        // Прочие 4xx — не ретраим, бросаем сразу.
        console.warn(`[steam] GET ${shortenUrl(url)} -> ${res.status}`);
        throw new SteamHttpError(res.status, url);
      } catch (err) {
        // Наши собственные «терминальные» ошибки не глушим.
        if (err instanceof SteamBlockedError || err instanceof SteamHttpError) {
          throw err;
        }
        // Сетевая ошибка (fetch бросил) — ретраим.
        lastErr = err;
        const retriable = attempt < this.maxRetries;
        const pause = backoffMs(attempt);
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[steam] GET ${shortenUrl(url)} -> сетевая ошибка: ${msg} ` +
            `(попытка ${attempt + 1}${retriable ? `, пауза ${pause}ms` : ", ретраи исчерпаны"})`,
        );
        if (!retriable) break;
        await sleep(pause);
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Не удалось загрузить ${shortenUrl(url)}`);
  }
}
