import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { SteamHttp } from "./steam/http.js";
import { iterateMarketItems } from "./steam/searchRender.js";
import { resolveItemNameId } from "./steam/itemNameId.js";
import { fetchOrderHistogram } from "./steam/histogram.js";
import {
  upsertItem,
  setItemNameId,
  insertSnapshot,
  listItemsNeedingNameId,
  listItemsForPriceUpdate,
  topByMargin,
} from "./repo.js";
import { profit, marginPct, sellerReceives } from "./economics.js";

const VALID_APPS = new Set([730, 570, 252490]);
const PROVIDER = "steam";

interface Args {
  app: number;
  pages?: number;
  limit?: number;
}

/** Простой парсер process.argv: --app 730 --pages 5 --limit 50. */
function parseArgs(argv: string[]): Args {
  const out: Args = { app: 730 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--app":
        out.app = Number(next);
        i++;
        break;
      case "--pages":
        out.pages = Number(next);
        i++;
        break;
      case "--limit":
        out.limit = Number(next);
        i++;
        break;
      default:
        // незнакомые токены игнорируем
        break;
    }
  }
  return out;
}

function validateApp(app: number): void {
  if (!Number.isFinite(app) || !VALID_APPS.has(app)) {
    throw new Error(
      `Неверный --app ${app}. Допустимы: 730 (CS2), 570 (Dota2), 252490 (Rust).`,
    );
  }
}

/** копейки -> рубли с 2 знаками. */
function rub(kopecks: number | null): string {
  if (kopecks === null) return "—";
  return (kopecks / 100).toFixed(2);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

async function cmdSyncItems(db: Database.Database, http: SteamHttp, args: Args) {
  const maxPages = args.pages ?? 5;
  console.log(`sync-items: app=${args.app}, pages=${maxPages}`);
  let count = 0;
  for await (const item of iterateMarketItems(http, args.app, { maxPages })) {
    upsertItem(db, args.app, item.marketHashName, item.iconUrl);
    count++;
    if (count % 100 === 0) {
      console.log(`  ...обработано ${count} предметов`);
    }
  }
  console.log(`sync-items: готово, upsert ${count} предметов (app ${args.app}).`);
}

async function cmdResolveIds(
  db: Database.Database,
  http: SteamHttp,
  args: Args,
) {
  const limit = args.limit ?? 50;
  const items = listItemsNeedingNameId(db, args.app, limit);
  console.log(`resolve-ids: app=${args.app}, к резолву ${items.length} предметов.`);
  let ok = 0;
  let fail = 0;
  for (const it of items) {
    try {
      const nameId = await resolveItemNameId(http, args.app, it.market_hash_name);
      setItemNameId(db, it.id, nameId);
      ok++;
      console.log(`  [ok] ${it.market_hash_name} -> ${nameId}`);
    } catch (err) {
      fail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [fail] ${it.market_hash_name}: ${msg}`);
    }
  }
  console.log(`resolve-ids: готово, успешно ${ok}, ошибок ${fail}.`);
}

async function cmdUpdatePrices(
  db: Database.Database,
  http: SteamHttp,
  args: Args,
) {
  const limit = args.limit ?? 100;
  const items = listItemsForPriceUpdate(db, args.app, limit);
  console.log(`update-prices: app=${args.app}, к обновлению ${items.length} предметов.`);
  let ok = 0;
  let fail = 0;
  for (const it of items) {
    if (it.item_nameid === null) continue; // на всякий случай
    try {
      const h = await fetchOrderHistogram(http, it.item_nameid);
      insertSnapshot(db, {
        itemId: it.id,
        provider: PROVIDER,
        buyOrder: h.highestBuyOrder,
        sellPrice: h.lowestSellOrder,
        volume: null, // объём возьмём из priceoverview позже
      });
      ok++;
      console.log(
        `  [ok] ${it.market_hash_name}: buy=${rub(h.highestBuyOrder)} sell=${rub(
          h.lowestSellOrder,
        )}`,
      );
    } catch (err) {
      fail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [fail] ${it.market_hash_name}: ${msg}`);
    }
  }
  console.log(`update-prices: готово, успешно ${ok}, ошибок ${fail}.`);
}

function cmdTop(db: Database.Database, args: Args) {
  const limit = args.limit ?? 20;
  // topByMargin отдаёт сырые поля; маржу считаем здесь. Чтобы топ по марже был
  // честным, выбираем кандидатов с запасом и сортируем уже в JS.
  const CANDIDATE_CAP = 10000;
  const rows = topByMargin(db, args.app, CANDIDATE_CAP);

  const ranked = rows
    .map((r) => {
      const buy = r.buy_order as number; // обе цены гарантированы запросом
      const sell = r.sell_price as number;
      return {
        name: r.market_hash_name,
        buy,
        sell,
        receive: sellerReceives(sell),
        prof: profit(buy, sell),
        margin: marginPct(buy, sell),
      };
    })
    .sort((a, b) => b.margin - a.margin)
    .slice(0, limit);

  if (ranked.length === 0) {
    console.log(
      `top: для app ${args.app} нет предметов с обеими ценами. Сначала запусти update-prices.`,
    );
    return;
  }

  const NAME_W = 40;
  const NUM_W = 12;
  console.log(
    pad("Предмет", NAME_W) +
      padLeft("Автозапрос ₽", NUM_W) +
      padLeft("Продажа ₽", NUM_W) +
      padLeft("Выручка ₽", NUM_W) +
      padLeft("Прибыль ₽", NUM_W) +
      padLeft("Маржа %", NUM_W),
  );
  for (const r of ranked) {
    const name = r.name.length > NAME_W - 1 ? r.name.slice(0, NAME_W - 2) + "…" : r.name;
    console.log(
      pad(name, NAME_W) +
        padLeft(rub(r.buy), NUM_W) +
        padLeft(rub(r.sell), NUM_W) +
        padLeft(rub(r.receive), NUM_W) +
        padLeft(rub(r.prof), NUM_W) +
        padLeft(r.margin.toFixed(2), NUM_W),
    );
  }
  console.log(`top: показано ${ranked.length} из ${rows.length} (app ${args.app}).`);
}

function usage(): void {
  console.log(
    [
      "collector — сборщик цен Steam Market",
      "",
      "Команды:",
      "  sync-items    --app 730 [--pages 5]    список предметов -> БД",
      "  resolve-ids   --app 730 [--limit 50]   резолв item_nameid",
      "  update-prices --app 730 [--limit 100]  стакан -> snapshot",
      "  top           --app 730 [--limit 20]   топ по марже в консоль",
      "",
      "app: 730 (CS2, по умолч.), 570 (Dota2), 252490 (Rust).",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }

  const args = parseArgs(rest);
  validateApp(args.app);

  const db = openDb();

  // Грейсфул-обработка Ctrl+C: закрываем БД.
  let closed = false;
  const closeDb = () => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {
      /* уже закрыта */
    }
  };
  const onSignal = (sig: string) => {
    console.log(`\nПолучен ${sig}, закрываю БД...`);
    closeDb();
    process.exit(130);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    if (cmd === "top") {
      cmdTop(db, args);
      return;
    }

    const http = new SteamHttp();
    switch (cmd) {
      case "sync-items":
        await cmdSyncItems(db, http, args);
        break;
      case "resolve-ids":
        await cmdResolveIds(db, http, args);
        break;
      case "update-prices":
        await cmdUpdatePrices(db, http, args);
        break;
      default:
        console.error(`Неизвестная команда: ${cmd}`);
        usage();
        process.exitCode = 2;
        break;
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Ошибка: ${msg}`);
  process.exitCode = 1;
});
