import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { SteamHttp } from "./steam/http.js";
import { iterateMarketItems } from "./steam/searchRender.js";
import { fetchOrderBook } from "./steam/orderbook.js";
import {
  upsertItem,
  insertSnapshot,
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
  currency?: number;
  name?: string;
}

/** Простой парсер process.argv: --app 730 --pages 5 --limit 50 --currency 5 --name "...". */
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
      case "--currency":
        out.currency = Number(next);
        i++;
        break;
      case "--name":
        out.name = next;
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

/** Минимальные единицы валюты (центы/копейки) -> 2 знака после запятой. */
function money(units: number | null): string {
  if (units === null) return "—";
  return (units / 100).toFixed(2);
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

/** Точечная проверка одного предмета по имени (без БД). */
async function cmdProbe(http: SteamHttp, args: Args) {
  if (!args.name) {
    throw new Error(
      'probe требует --name "<полное имя предмета>". ' +
        'Напр.: probe --name "AK-47 | Redline (Field-Tested)"',
    );
  }
  console.log(`probe: app=${args.app}, "${args.name}"`);
  const ob = await fetchOrderBook(http, args.app, args.name, args.currency);
  const buy = ob.highestBuyOrder;
  const sell = ob.lowestSellOrder;
  console.log(`  валюта (eCurrency): ${ob.currency ?? "—"}`);
  console.log(`  автозапрос (highest buy): ${money(buy)}`);
  console.log(`  продажа (lowest sell):    ${money(sell)}`);
  console.log(`  заявок на покупку: ${ob.buyOrderCount ?? "—"}`);
  console.log(`  лотов на продажу:  ${ob.sellOrderCount ?? "—"}`);
  if (buy !== null && sell !== null) {
    console.log(`  выручка после комиссии: ${money(sellerReceives(sell))}`);
    console.log(`  прибыль автозапрос->продажа: ${money(profit(buy, sell))}`);
    console.log(`  маржа: ${marginPct(buy, sell).toFixed(2)}%`);
  } else {
    console.log("  одна из сторон стакана пуста — спред не посчитать.");
  }
}

function cmdResolveIds() {
  console.log(
    "resolve-ids: больше не требуется. Новый рынок Steam отдаёт стакан по имени " +
      "предмета (orderbook), item_nameid не нужен. Сразу запускай update-prices.",
  );
}

async function cmdUpdatePrices(
  db: Database.Database,
  http: SteamHttp,
  args: Args,
) {
  const limit = args.limit ?? 100;
  const currency = args.currency; // если не задан — Steam выберет по гео-IP
  const items = listItemsForPriceUpdate(db, args.app, limit);
  console.log(
    `update-prices: app=${args.app}, к обновлению ${items.length} предметов.`,
  );
  let ok = 0;
  let fail = 0;
  const seenCurrencies = new Set<number>();
  for (const it of items) {
    try {
      const ob = await fetchOrderBook(http, args.app, it.market_hash_name, currency);
      if (ob.currency !== null) seenCurrencies.add(ob.currency);
      insertSnapshot(db, {
        itemId: it.id,
        provider: PROVIDER,
        buyOrder: ob.highestBuyOrder,
        sellPrice: ob.lowestSellOrder,
        volume: ob.sellOrderCount, // кол-во лотов на продажу — прокси ликвидности
      });
      ok++;
      console.log(
        `  [ok] ${it.market_hash_name}: buy=${money(ob.highestBuyOrder)} ` +
          `sell=${money(ob.lowestSellOrder)}`,
      );
    } catch (err) {
      fail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [fail] ${it.market_hash_name}: ${msg}`);
    }
  }
  console.log(`update-prices: готово, успешно ${ok}, ошибок ${fail}.`);
  if (seenCurrencies.size > 1) {
    console.warn(
      `  ⚠ разные валюты в ответах: ${[...seenCurrencies].join(", ")} — ` +
        "цены несравнимы. Зафиксируй валюту флагом --currency (5=RUB, 1=USD).",
    );
  } else if (seenCurrencies.size === 1) {
    console.log(`  валюта ответа Steam (eCurrency): ${[...seenCurrencies][0]}`);
  }
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
      padLeft("Автозапрос", NUM_W) +
      padLeft("Продажа", NUM_W) +
      padLeft("Выручка", NUM_W) +
      padLeft("Прибыль", NUM_W) +
      padLeft("Маржа %", NUM_W),
  );
  for (const r of ranked) {
    const name =
      r.name.length > NAME_W - 1 ? r.name.slice(0, NAME_W - 2) + "…" : r.name;
    console.log(
      pad(name, NAME_W) +
        padLeft(money(r.buy), NUM_W) +
        padLeft(money(r.sell), NUM_W) +
        padLeft(money(r.receive), NUM_W) +
        padLeft(money(r.prof), NUM_W) +
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
      "  sync-items    --app 730 [--pages 5]                список предметов -> БД",
      "  update-prices --app 730 [--limit 100] [--currency 5]  стакан -> snapshot",
      "  probe         --app 730 --name \"<имя>\" [--currency 5]  проверка 1 предмета",
      "  top           --app 730 [--limit 20]               топ по марже в консоль",
      "",
      "app: 730 (CS2, по умолч.), 570 (Dota2), 252490 (Rust).",
      "currency: 5=RUB, 1=USD (по умолч. Steam выбирает по гео-IP).",
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
    if (cmd === "resolve-ids") {
      cmdResolveIds();
      return;
    }

    const http = new SteamHttp();
    switch (cmd) {
      case "sync-items":
        await cmdSyncItems(db, http, args);
        break;
      case "update-prices":
        await cmdUpdatePrices(db, http, args);
        break;
      case "probe":
        await cmdProbe(http, args);
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
