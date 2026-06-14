/**
 * Типизированный клиент REST API сервера (@table/server).
 * Базовый префикс /api, в dev проксируется Vite на http://localhost:3000.
 */

const BASE = "/api";

export interface ItemDto {
  name: string;
  appId: number;
  iconUrl: string | null;
  steamUrl: string;
  buyUsd: number | null;
  sellUsd: number | null;
  receiveUsd: number | null;
  profitUsd: number | null;
  marginPct: number | null;
  volume: number | null;
  currency: number | null;
  fetchedAt: string;
}

export interface FxStatus {
  updatedAt: string | null;
  missing: string[];
}

export interface Meta {
  total: number;
  priced: number;
  lastFetched: string | null;
  fx: FxStatus;
  currencies: number[];
}

export type SortKey = "margin" | "profit" | "buy" | "sell" | "volume" | "name";
export type SortDir = "asc" | "desc";

export type CollectorKind = "sync" | "update" | null;

export interface CollectorStatus {
  running: boolean;
  kind: CollectorKind;
  processed: number;
  total: number;
  ok: number;
  fail: number;
  lastName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

export interface ApiError {
  error: string;
}

export interface FetchItemsParams {
  app: number;
  search?: string;
  minMargin?: number;
  minPriceUsd?: number;
  maxPriceUsd?: number;
  minVolume?: number;
  sort?: SortKey;
  dir?: SortDir;
  limit?: number;
}

export interface StartSyncBody {
  app: number;
  pages: number;
  concurrency?: number;
  intervalMs?: number;
}

export interface StartUpdateBody {
  app: number;
  limit: number;
  currency?: number;
  concurrency?: number;
  intervalMs?: number;
}

/** Собирает query-строку, пропуская undefined/null/"" значения. */
function toQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export async function fetchItems(params: FetchItemsParams): Promise<ItemDto[]> {
  const qs = toQuery({
    app: params.app,
    search: params.search,
    minMargin: params.minMargin,
    minPriceUsd: params.minPriceUsd,
    maxPriceUsd: params.maxPriceUsd,
    minVolume: params.minVolume,
    sort: params.sort,
    dir: params.dir,
    limit: params.limit,
  });
  const res = await fetch(`${BASE}/items${qs}`);
  if (!res.ok) {
    throw new Error(`GET /items: ${res.status}`);
  }
  return (await res.json()) as ItemDto[];
}

export async function fetchMeta(app: number): Promise<Meta> {
  const qs = toQuery({ app });
  const res = await fetch(`${BASE}/meta${qs}`);
  if (!res.ok) {
    throw new Error(`GET /meta: ${res.status}`);
  }
  return (await res.json()) as Meta;
}

export async function getCollectorStatus(): Promise<CollectorStatus> {
  const res = await fetch(`${BASE}/collector/status`);
  if (!res.ok) {
    throw new Error(`GET /collector/status: ${res.status}`);
  }
  return (await res.json()) as CollectorStatus;
}

/** POST JSON. Если ответ 409 — возвращает { error }, иначе результат типа T. */
async function postJson<T>(path: string, body: unknown): Promise<T | ApiError> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    return (await res.json()) as ApiError;
  }
  if (!res.ok) {
    throw new Error(`POST ${path}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function startSync(
  body: StartSyncBody,
): Promise<CollectorStatus | ApiError> {
  return postJson<CollectorStatus>("/collector/sync", body);
}

export async function startUpdate(
  body: StartUpdateBody,
): Promise<CollectorStatus | ApiError> {
  return postJson<CollectorStatus>("/collector/update", body);
}

export async function stopCollector(): Promise<CollectorStatus> {
  const res = await fetch(`${BASE}/collector/stop`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`POST /collector/stop: ${res.status}`);
  }
  return (await res.json()) as CollectorStatus;
}
