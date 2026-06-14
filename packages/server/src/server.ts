import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openServerDb } from "./db.js";
import { ensureRates, fxStatus } from "./fx.js";
import { queryItems } from "./items.js";
import type { QueryItemsParams, SortDir, SortKey } from "./items.js";
import { CollectorService } from "./collectorService.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const DEV_ORIGIN = "http://localhost:5173";

const db = openServerDb();
const collector = new CollectorService(db);

const app = Fastify({ logger: false });

/**
 * CORS для dev: фронт на Vite (localhost:5173) ходит на API (localhost:3000).
 * Без новой зависимости — ручной хук + обработка preflight OPTIONS.
 */
app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done) => {
  const origin = req.headers.origin;
  if (origin === DEV_ORIGIN || origin === "http://127.0.0.1:5173") {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    reply.code(204).send();
    return;
  }
  done();
});

/** Безопасно парсит число из query; пустое/нечисло -> undefined. */
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s;
}

interface ItemsQuery {
  app?: string;
  search?: string;
  minMargin?: string;
  minPriceUsd?: string;
  maxPriceUsd?: string;
  minVolume?: string;
  sort?: string;
  dir?: string;
  limit?: string;
}

const SORT_KEYS = new Set(["margin", "profit", "buy", "sell", "volume", "name"]);

// ---- /api/items ----
app.get<{ Querystring: ItemsQuery }>("/api/items", async (req) => {
  await ensureRates();
  const q = req.query;
  const app = num(q.app);
  if (app === undefined) {
    return [];
  }
  const sortRaw = str(q.sort);
  const params: QueryItemsParams = {
    app,
    search: str(q.search),
    minMargin: num(q.minMargin),
    minPriceUsd: num(q.minPriceUsd),
    maxPriceUsd: num(q.maxPriceUsd),
    minVolume: num(q.minVolume),
    sort:
      sortRaw && SORT_KEYS.has(sortRaw) ? (sortRaw as SortKey) : undefined,
    dir: q.dir === "asc" ? ("asc" as SortDir) : q.dir === "desc" ? "desc" : undefined,
    limit: num(q.limit),
  };
  return queryItems(db, params);
});

// ---- /api/meta ----
interface MetaQuery {
  app?: string;
}
app.get<{ Querystring: MetaQuery }>("/api/meta", async (req, reply) => {
  const app = num(req.query.app);
  if (app === undefined) {
    return reply.code(400).send({ error: "Параметр app обязателен" });
  }

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM items WHERE app_id = ?`)
      .get(app) as { c: number }
  ).c;

  const priced = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM items_latest
         WHERE app_id = ? AND buy_order IS NOT NULL AND sell_price IS NOT NULL`,
      )
      .get(app) as { c: number }
  ).c;

  const lastFetched = (
    db
      .prepare(`SELECT MAX(fetched_at) AS m FROM items_latest WHERE app_id = ?`)
      .get(app) as { m: string | null }
  ).m;

  const currencyRows = db
    .prepare(
      `SELECT DISTINCT s.currency AS currency
       FROM price_snapshots s
       JOIN items i ON i.id = s.item_id
       WHERE i.app_id = ? AND s.currency IS NOT NULL
       ORDER BY s.currency`,
    )
    .all(app) as Array<{ currency: number }>;

  return {
    total,
    priced,
    lastFetched,
    fx: fxStatus(),
    currencies: currencyRows.map((r) => r.currency),
  };
});

// ---- collector ----
app.get("/api/collector/status", async () => collector.getStatus());

interface SyncBody {
  app?: number;
  pages?: number;
  concurrency?: number;
  intervalMs?: number;
}
app.post<{ Body: SyncBody }>("/api/collector/sync", async (req, reply) => {
  const body = req.body ?? {};
  const app = num(body.app) ?? 730;
  const pages = num(body.pages) ?? 5;
  try {
    const status = collector.startSync({
      app,
      pages,
      concurrency: num(body.concurrency),
      intervalMs: num(body.intervalMs),
    });
    return reply.code(202).send(status);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return reply.code(409).send({ error });
  }
});

interface UpdateBody {
  app?: number;
  limit?: number;
  currency?: number;
  concurrency?: number;
  intervalMs?: number;
}
app.post<{ Body: UpdateBody }>("/api/collector/update", async (req, reply) => {
  const body = req.body ?? {};
  const app = num(body.app) ?? 730;
  const limit = num(body.limit) ?? 100;
  try {
    const status = collector.startUpdate({
      app,
      limit,
      currency: num(body.currency),
      concurrency: num(body.concurrency),
      intervalMs: num(body.intervalMs),
    });
    return reply.code(202).send(status);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return reply.code(409).send({ error });
  }
});

app.post("/api/collector/stop", async () => collector.stop());

// ---- статика фронта (prod). В dev фронт на Vite — пропускаем. ----
async function registerStatic(): Promise<void> {
  // packages/server/src -> packages/web/dist
  const here = fileURLToPath(new URL(".", import.meta.url));
  const webDist = resolve(here, "../../web/dist");
  if (!existsSync(webDist)) return;
  try {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  } catch {
    // отсутствие пакета/dist не должно ронять сервер
  }
}

async function start(): Promise<void> {
  await registerStatic();
  await app.listen({ host: HOST, port: PORT });
  // eslint-disable-next-line no-console
  console.log(`server: http://${HOST}:${PORT}`);
}

start().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`server: ошибка запуска: ${msg}`);
  process.exit(1);
});
