import type Database from "better-sqlite3";
import { SteamHttp } from "@table/collector/steam/http";
import type { SteamHttpOptions } from "@table/collector/steam/http";
import { syncItems, updatePrices } from "@table/collector/runner";
import type { CollectProgress } from "@table/collector/runner";

/**
 * Менеджер фоновых задач сбора: ОДНА задача за раз. Запуск возвращает
 * управление сразу (задача крутится в фоне), состояние обновляется через
 * onProgress. Повторный запуск при running -> ошибка (маршрут вернёт 409).
 *
 * Гонки нет: проверка running и его установка в true делаются синхронно до
 * первого await, а Node однопоточен — два обработчика маршрута не выполнят
 * guard одновременно.
 */

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

export interface StartSyncParams {
  app: number;
  pages: number;
  concurrency?: number;
  intervalMs?: number;
}

export interface StartUpdateParams {
  app: number;
  limit: number;
  currency?: number;
  concurrency?: number;
  intervalMs?: number;
}

export class CollectorService {
  private readonly db: Database.Database;

  private running = false;
  private kind: CollectorKind = null;
  private processed = 0;
  private total = 0;
  private ok = 0;
  private fail = 0;
  private lastName: string | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private lastError: string | null = null;

  private controller: AbortController | null = null;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getStatus(): CollectorStatus {
    return {
      running: this.running,
      kind: this.kind,
      processed: this.processed,
      total: this.total,
      ok: this.ok,
      fail: this.fail,
      lastName: this.lastName,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      lastError: this.lastError,
    };
  }

  /** Синхронно занимает «слот» задачи или бросает, если уже занят. */
  private begin(kind: Exclude<CollectorKind, null>): AbortController {
    if (this.running) {
      throw new Error("Сбор уже выполняется");
    }
    this.running = true;
    this.kind = kind;
    this.processed = 0;
    this.total = 0;
    this.ok = 0;
    this.fail = 0;
    this.lastName = null;
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.lastError = null;
    this.controller = new AbortController();
    return this.controller;
  }

  private onProgress = (p: CollectProgress): void => {
    this.processed = p.processed;
    this.total = p.total;
    this.ok = p.ok;
    this.fail = p.fail;
    this.lastName = p.lastName;
  };

  private finish(err?: unknown): void {
    this.running = false;
    this.finishedAt = new Date().toISOString();
    this.controller = null;
    if (err !== undefined) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Собрать SteamHttp, прокинув только заданные опции. */
  private makeHttp(opts: {
    concurrency?: number;
    intervalMs?: number;
  }): SteamHttp {
    const httpOpts: SteamHttpOptions = {};
    if (opts.intervalMs !== undefined && Number.isFinite(opts.intervalMs)) {
      httpOpts.intervalMs = opts.intervalMs;
    }
    if (opts.concurrency !== undefined && Number.isFinite(opts.concurrency)) {
      httpOpts.concurrency = opts.concurrency;
    }
    return new SteamHttp(httpOpts);
  }

  startSync(params: StartSyncParams): CollectorStatus {
    const controller = this.begin("sync");
    const http = this.makeHttp({
      concurrency: params.concurrency,
      intervalMs: params.intervalMs,
    });
    // Запуск в фоне: НЕ ждём здесь, маршрут возвращает 202 сразу.
    void syncItems(this.db, http, {
      app: params.app,
      pages: params.pages,
      onProgress: this.onProgress,
      signal: controller.signal,
    })
      .then(() => this.finish())
      .catch((err) => this.finish(err));
    return this.getStatus();
  }

  startUpdate(params: StartUpdateParams): CollectorStatus {
    const controller = this.begin("update");
    const http = this.makeHttp({
      concurrency: params.concurrency,
      intervalMs: params.intervalMs,
    });
    void updatePrices(this.db, http, {
      app: params.app,
      limit: params.limit,
      currency: params.currency,
      onProgress: this.onProgress,
      signal: controller.signal,
    })
      .then(() => this.finish())
      .catch((err) => this.finish(err));
    return this.getStatus();
  }

  /** Просит текущую задачу прекратиться (между предметами/страницами). */
  stop(): CollectorStatus {
    this.controller?.abort();
    return this.getStatus();
  }
}
