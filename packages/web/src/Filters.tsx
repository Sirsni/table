import { useEffect, useState } from "react";
import type { SortDir, SortKey } from "./api";

export interface FiltersValue {
  app: number;
  search: string;
  minMargin: string;
  minPriceUsd: string;
  maxPriceUsd: string;
  minVolume: string;
  sort: SortKey;
  dir: SortDir;
}

export const DEFAULT_FILTERS: FiltersValue = {
  app: 730,
  search: "",
  minMargin: "",
  minPriceUsd: "",
  maxPriceUsd: "",
  minVolume: "",
  sort: "margin",
  dir: "desc",
};

const GAMES: Array<{ value: number; label: string }> = [
  { value: 730, label: "CS2" },
  { value: 570, label: "Dota 2" },
  { value: 252490, label: "Rust" },
];

const SORT_KEYS: Array<{ value: SortKey; label: string }> = [
  { value: "margin", label: "Маржа %" },
  { value: "profit", label: "Прибыль $" },
  { value: "buy", label: "Автозапрос $" },
  { value: "sell", label: "Продажа $" },
  { value: "volume", label: "Объём" },
  { value: "name", label: "Название" },
];

const DEBOUNCE_MS = 400;

interface FiltersProps {
  value: FiltersValue;
  onChange: (next: FiltersValue) => void;
}

/**
 * Управляемый компонент фильтров. Текстовые/числовые поля дебаунсятся перед
 * вызовом onChange, select'ы применяются сразу. Локальный стейт нужен для
 * того, чтобы поле не "прыгало" при наборе, пока внешнее значение не обновилось.
 */
export function Filters({ value, onChange }: FiltersProps) {
  const [local, setLocal] = useState(value);

  // Внешнее значение изменилось не из-за нашего дебаунса (например, сброс) —
  // синхронизируем локальное отображение.
  useEffect(() => {
    setLocal(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.app, value.sort, value.dir]);

  useEffect(() => {
    const timer = setTimeout(() => {
      onChange(local);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    local.search,
    local.minMargin,
    local.minPriceUsd,
    local.maxPriceUsd,
    local.minVolume,
  ]);

  function setLocalField<K extends keyof FiltersValue>(
    key: K,
    val: FiltersValue[K],
  ): void {
    setLocal((prev) => ({ ...prev, [key]: val }));
  }

  /** Select'ы применяются немедленно, без дебаунса. */
  function setImmediate<K extends keyof FiltersValue>(
    key: K,
    val: FiltersValue[K],
  ): void {
    const next = { ...local, [key]: val };
    setLocal(next);
    onChange(next);
  }

  return (
    <div className="panel">
      <h2 className="panel__title">Фильтры</h2>
      <div className="panel__row">
        <label className="field">
          Игра
          <select
            value={local.app}
            onChange={(e) => setImmediate("app", Number(e.target.value))}
          >
            {GAMES.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--search">
          Поиск по названию
          <input
            type="text"
            value={local.search}
            onChange={(e) => setLocalField("search", e.target.value)}
            placeholder="например, AK-47"
          />
        </label>

        <label className="field field--number">
          Мин. маржа %
          <input
            type="number"
            value={local.minMargin}
            onChange={(e) => setLocalField("minMargin", e.target.value)}
            step="0.1"
          />
        </label>

        <label className="field field--number">
          Цена $ от
          <input
            type="number"
            value={local.minPriceUsd}
            onChange={(e) => setLocalField("minPriceUsd", e.target.value)}
            step="0.01"
            min="0"
          />
        </label>

        <label className="field field--number">
          Цена $ до
          <input
            type="number"
            value={local.maxPriceUsd}
            onChange={(e) => setLocalField("maxPriceUsd", e.target.value)}
            step="0.01"
            min="0"
          />
        </label>

        <label className="field field--number">
          Мин. объём
          <input
            type="number"
            value={local.minVolume}
            onChange={(e) => setLocalField("minVolume", e.target.value)}
            step="1"
            min="0"
          />
        </label>

        <div className="field field--sort">
          Сортировка
          <select
            value={local.sort}
            onChange={(e) =>
              setImmediate("sort", e.target.value as SortKey)
            }
          >
            {SORT_KEYS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            value={local.dir}
            onChange={(e) => setImmediate("dir", e.target.value as SortDir)}
          >
            <option value="desc">убыв.</option>
            <option value="asc">возр.</option>
          </select>
        </div>
      </div>
    </div>
  );
}
