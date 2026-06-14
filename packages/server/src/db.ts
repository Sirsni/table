import { openDb } from "@table/collector/db";
import type Database from "better-sqlite3";

/**
 * Сервер открывает тот же SQLite-файл, что и коллектор, и держит ОДНО
 * соединение (read-write): через него идут и чтения API, и фоновые запуски
 * сбора. Схему/миграции/view создаёт openDb коллектора — переиспользуем его,
 * чтобы не дублировать DDL.
 *
 * Путь: аргумент -> env DB_PATH -> data/table.sqlite. DB_PATH нужен в т.ч. для
 * тестов на временной БД, не трогая реальные данные пользователя.
 */
export function openServerDb(path?: string): Database.Database {
  const dbPath = path ?? process.env.DB_PATH ?? "data/table.sqlite";
  return openDb(dbPath);
}
