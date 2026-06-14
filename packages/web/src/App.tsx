import { useCallback, useEffect, useState } from "react";
import type { FetchItemsParams, ItemDto, Meta } from "./api";
import { fetchItems, fetchMeta } from "./api";
import { CollectorPanel } from "./CollectorPanel";
import { DEFAULT_FILTERS, Filters } from "./Filters";
import type { FiltersValue } from "./Filters";
import { Table } from "./Table";

const AUTO_REFRESH_MS = 10_000;

/** Преобразует строковое числовое поле фильтра в number|undefined. */
function parseNum(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Собирает параметры запроса /api/items из значения фильтров. */
function toItemsParams(filters: FiltersValue): FetchItemsParams {
  return {
    app: filters.app,
    search: filters.search.trim() === "" ? undefined : filters.search.trim(),
    minMargin: parseNum(filters.minMargin),
    minPriceUsd: parseNum(filters.minPriceUsd),
    maxPriceUsd: parseNum(filters.maxPriceUsd),
    minVolume: parseNum(filters.minVolume),
    sort: filters.sort,
    dir: filters.dir,
  };
}

/** Короткая дата/время для меты (последний сбор, обновление курсов). */
function shortMetaTime(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function App() {
  const [filters, setFilters] = useState<FiltersValue>(DEFAULT_FILTERS);
  const [items, setItems] = useState<ItemDto[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const app = filters.app;

  const loadItems = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchItems(toItemsParams(filters));
      setItems(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const loadMeta = useCallback(async (): Promise<void> => {
    try {
      const m = await fetchMeta(app);
      setMeta(m);
    } catch {
      // Мета — вспомогательная информация, ошибку загрузки таблицы не дублируем.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app]);

  // Загрузка предметов при изменении фильтров/сортировки.
  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  // Загрузка меты при смене игры.
  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // Авто-обновление таблицы и меты по таймеру.
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void loadItems();
      void loadMeta();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, loadItems, loadMeta]);

  // По завершении задачи сбора — обновить таблицу и мету.
  const handleJobChange = useCallback(() => {
    void loadItems();
    void loadMeta();
  }, [loadItems, loadMeta]);

  function handleManualRefresh(): void {
    void loadItems();
    void loadMeta();
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>Steam Market — сравнение цен</h1>
        <div className="meta">
          {meta && (
            <>
              <span>
                Предметов: <strong>{meta.total}</strong>
              </span>
              <span>
                С ценами: <strong>{meta.priced}</strong>
              </span>
              <span>
                Последний сбор: <strong>{shortMetaTime(meta.lastFetched)}</strong>
              </span>
              <span>
                Курсы обновлены:{" "}
                <strong>{shortMetaTime(meta.fx.updatedAt)}</strong>
              </span>
            </>
          )}
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Автообновление (10с)
          </label>
          <button type="button" onClick={handleManualRefresh} disabled={loading}>
            {loading ? "Обновление…" : "Обновить"}
          </button>
        </div>
      </header>

      {meta && meta.fx.missing.length > 0 && (
        <div className="meta__warning">
          Нет курса для: {meta.fx.missing.join(", ")} — цены в USD недоступны
          для этих валют.
        </div>
      )}

      <CollectorPanel defaultApp={app} onJobChange={handleJobChange} />

      <Filters value={filters} onChange={setFilters} />

      {loadError && <div className="collector__error">{loadError}</div>}

      <Table data={items} />
    </div>
  );
}
