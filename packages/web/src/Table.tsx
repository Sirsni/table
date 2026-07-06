import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { ColumnDef, SortingFn, SortingState } from "@tanstack/react-table";
import type { ItemDto } from "./api";
import { count, iconSrc, pct, shortDateTime, signedPct, usd } from "./format";

interface TableProps {
  data: ItemDto[];
}

/** Числовая сортировка с null всегда в конце, независимо от направления. */
const nullsLastSort: SortingFn<ItemDto> = (rowA, rowB, columnId) => {
  const a = rowA.getValue<number | null>(columnId);
  const b = rowB.getValue<number | null>(columnId);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
};

function signedClass(n: number | null): string | undefined {
  if (n === null) return undefined;
  if (n > 0) return "positive";
  if (n < 0) return "negative";
  return undefined;
}

const columns: ColumnDef<ItemDto>[] = [
  {
    id: "name",
    header: "Название",
    accessorKey: "name",
    enableSorting: true,
    cell: ({ row }) => {
      const item = row.original;
      const src = iconSrc(item.iconUrl);
      return (
        <div className="col-name">
          {src ? (
            <img className="col-name__icon" src={src} alt="" />
          ) : (
            <span className="col-name__icon--empty" />
          )}
          <a
            className="col-name__link"
            href={item.steamUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={item.name}
          >
            {item.name}
          </a>
          {item.boostSuspect === true && (
            <span
              className="badge-boost"
              title={
                "Недавние цены аномально выше месячной нормы" +
                (item.boostScore ? `, x${item.boostScore}` : "")
              }
            >
              ⚠ буст
            </span>
          )}
        </div>
      );
    },
  },
  {
    id: "buyUsd",
    header: "Покупка $",
    accessorKey: "buyUsd",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => (
      <span className="col-num">{usd(getValue<number | null>())}</span>
    ),
  },
  {
    id: "sellUsd",
    header: "Продажа $",
    accessorKey: "sellUsd",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => (
      <span className="col-num">{usd(getValue<number | null>())}</span>
    ),
  },
  {
    id: "receiveUsd",
    header: "Выручка $",
    accessorKey: "receiveUsd",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => (
      <span className="col-num">{usd(getValue<number | null>())}</span>
    ),
  },
  {
    id: "profitUsd",
    header: "Прибыль $",
    accessorKey: "profitUsd",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return (
        <span className={`col-num ${signedClass(v) ?? ""}`}>{usd(v)}</span>
      );
    },
  },
  {
    id: "marginPct",
    header: "Маржа %",
    accessorKey: "marginPct",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return (
        <span className={`col-num ${signedClass(v) ?? ""}`}>{pct(v)}</span>
      );
    },
  },
  {
    id: "volume",
    header: "Объём",
    accessorKey: "volume",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return <span className="col-num">{v === null ? "—" : v}</span>;
    },
  },
  {
    id: "sales7d",
    header: "Продаж/нед",
    accessorKey: "sales7d",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => (
      <span className="col-num">{count(getValue<number | null>())}</span>
    ),
  },
  {
    id: "sales30d",
    header: "Продаж/мес",
    accessorKey: "sales30d",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => (
      <span className="col-num">{count(getValue<number | null>())}</span>
    ),
  },
  {
    id: "avg30dUsd",
    header: "Средняя $",
    accessorKey: "avg30dUsd",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => (
      <span className="col-num">{usd(getValue<number | null>())}</span>
    ),
  },
  {
    id: "median30dUsd",
    header: "Медиана $",
    accessorKey: "median30dUsd",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => (
      <span className="col-num">{usd(getValue<number | null>())}</span>
    ),
  },
  {
    id: "realProfitUsd",
    header: "Реал. прибыль $",
    accessorKey: "realProfitUsd",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return (
        <span className={`col-num ${signedClass(v) ?? ""}`}>{usd(v)}</span>
      );
    },
  },
  {
    id: "realMarginPct",
    header: "Реал. маржа %",
    accessorKey: "realMarginPct",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return (
        <span className={`col-num ${signedClass(v) ?? ""}`}>{pct(v)}</span>
      );
    },
  },
  {
    id: "dipPct",
    header: "Скидка %",
    accessorKey: "dipPct",
    sortingFn: nullsLastSort,
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return (
        <span className={`col-num ${signedClass(v) ?? ""}`}>
          {signedPct(v)}
        </span>
      );
    },
  },
  {
    id: "fetchedAt",
    header: "Обновлено",
    accessorKey: "fetchedAt",
    cell: ({ getValue }) => (
      <span className="col-num">{shortDateTime(getValue<string>())}</span>
    ),
  },
];

/** Индикатор направления сортировки текущего столбца. */
function sortIndicator(dir: false | "asc" | "desc"): string | null {
  if (dir === "asc") return "▲";
  if (dir === "desc") return "▼";
  return null;
}

export function Table({ data }: TableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const cols = useMemo(() => columns, []);

  const table = useReactTable({
    data,
    columns: cols,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="table-wrap">
      <table>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  <span className="sort-indicator">
                    {sortIndicator(header.column.getIsSorted())}
                  </span>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length === 0 && <div className="table__empty">Нет данных</div>}
    </div>
  );
}
