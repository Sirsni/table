import { useEffect, useRef, useState } from "react";
import type { CollectorStatus } from "./api";
import {
  getCollectorStatus,
  startSync,
  startUpdate,
  stopCollector,
} from "./api";

const STATUS_POLL_MS = 1500;

const GAMES: Array<{ value: number; label: string }> = [
  { value: 730, label: "CS2" },
  { value: 570, label: "Dota 2" },
  { value: 252490, label: "Rust" },
];

interface CollectorPanelProps {
  /** Текущая игра из App (используется как значение по умолчанию). */
  defaultApp: number;
  /**
   * Вызывается, когда сбор завершился (running: true -> false), чтобы App
   * мог обновить таблицу/мету.
   */
  onJobChange?: () => void;
}

/**
 * Панель управления сбором: запуск синхронизации списка предметов, запуск
 * обновления цен, остановка и отображение текущего статуса с поллингом.
 */
export function CollectorPanel({ defaultApp, onJobChange }: CollectorPanelProps) {
  const [app, setApp] = useState(defaultApp);
  const [pages, setPages] = useState("5");
  const [limit, setLimit] = useState("100");
  const [currency, setCurrency] = useState("1");
  const [concurrency, setConcurrency] = useState("1");
  const [intervalMs, setIntervalMs] = useState("1000");

  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Предыдущее значение running — чтобы отловить переход true -> false.
  const prevRunningRef = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const next = await getCollectorStatus();
        if (cancelled) return;
        const prevRunning = prevRunningRef.current;
        if (prevRunning === true && next.running === false) {
          onJobChange?.();
        }
        prevRunningRef.current = next.running;
        setStatus(next);
      } catch {
        // Сетевые ошибки поллинга игнорируем — попробуем на следующем тике.
      }
    }

    void poll();
    const timer = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onJobChange]);

  const running = status?.running ?? false;

  function num(v: string, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== "" ? n : fallback;
  }

  async function handleSync(): Promise<void> {
    setError(null);
    const result = await startSync({ app, pages: num(pages, 5) });
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setStatus(result);
    prevRunningRef.current = result.running;
  }

  async function handleUpdate(): Promise<void> {
    setError(null);
    const result = await startUpdate({
      app,
      limit: num(limit, 100),
      currency: num(currency, 1),
      concurrency: num(concurrency, 1),
      intervalMs: num(intervalMs, 1000),
    });
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setStatus(result);
    prevRunningRef.current = result.running;
  }

  async function handleStop(): Promise<void> {
    setError(null);
    const result = await stopCollector();
    setStatus(result);
    prevRunningRef.current = result.running;
  }

  return (
    <div className="panel">
      <h2 className="panel__title">Сбор данных</h2>
      <div className="panel__row">
        <label className="field">
          Игра
          <select
            value={app}
            onChange={(e) => setApp(Number(e.target.value))}
            disabled={running}
          >
            {GAMES.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--number">
          Страниц (sync)
          <input
            type="number"
            value={pages}
            onChange={(e) => setPages(e.target.value)}
            min="1"
            step="1"
            disabled={running}
          />
        </label>

        <label className="field field--number">
          Лимит (update)
          <input
            type="number"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            min="1"
            step="1"
            disabled={running}
          />
        </label>

        <label className="field field--number">
          Валюта
          <input
            type="number"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            min="1"
            step="1"
            disabled={running}
          />
        </label>

        <label className="field field--number">
          Параллельность
          <input
            type="number"
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            min="1"
            step="1"
            disabled={running}
          />
        </label>

        <label className="field field--number">
          Интервал, мс
          <input
            type="number"
            value={intervalMs}
            onChange={(e) => setIntervalMs(e.target.value)}
            min="0"
            step="50"
            disabled={running}
          />
        </label>

        <div className="field field--actions">
          <span>&nbsp;</span>
          <div className="panel__buttons">
            <button
              type="button"
              className="button--primary"
              onClick={handleSync}
              disabled={running}
            >
              Синхронизировать список
            </button>
            <button
              type="button"
              className="button--primary"
              onClick={handleUpdate}
              disabled={running}
            >
              Обновить цены
            </button>
            <button
              type="button"
              className="button--danger"
              onClick={handleStop}
              disabled={!running}
            >
              Стоп
            </button>
          </div>
        </div>
      </div>

      {status && (
        <div className="collector__status">
          <span>
            Статус:{" "}
            <strong>
              {status.running
                ? `выполняется (${status.kind ?? "—"})`
                : "не выполняется"}
            </strong>
          </span>
          <span>
            Прогресс: <strong>{status.processed}</strong> / {status.total}
          </span>
          <span>
            ok: <strong className="positive">{status.ok}</strong> / fail:{" "}
            <strong className={status.fail > 0 ? "negative" : undefined}>
              {status.fail}
            </strong>
          </span>
          {status.lastName && (
            <span>
              Последний: <strong>{status.lastName}</strong>
            </span>
          )}
          {status.lastError && (
            <span className="collector__error">
              Ошибка: {status.lastError}
            </span>
          )}
        </div>
      )}

      {error && <div className="collector__error">{error}</div>}

      <div className="collector__warning">
        Высокая скорость (низкий интервал/высокая параллельность) повышает риск
        временного бана IP со стороны Steam.
      </div>
    </div>
  );
}
