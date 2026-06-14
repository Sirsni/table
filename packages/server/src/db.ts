import { openDb } from "@table/collector/db";
import type Database from "better-sqlite3";

/**
 * Сервер открывает тот же SQLite-файл, что и коллектор, и держит ОДНО
 * соединение (read-write): через него идут и чтения API, и фоновые запуски
 * сбора. Схему/миграции/view создаёт openDb коллектора — переиспользуем его,
 * чтобы не дублировать DDL.
 *
 * Путь: аргумент -> env DB_PATH -> <корень репозитория>/data/table.sqlite
 * (дефолт и обработку DB_PATH задаёт openDb коллектора — единый для CLI и сервера).
 * DB_PATH нужен в т.ч. для тестов на временной БД, не трогая реальные данные.
 */
export function openServerDb(path?: string): Database.Database {
  return openDb(path);
}
