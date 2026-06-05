import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const storageStatuses = ["pending", "present", "missing", "deleted", "purged"] as const;
export type StorageStatus = (typeof storageStatuses)[number];

export const objectSources = ["upload", "verify", "download", "storage_scan"] as const;
export type ObjectSource = (typeof objectSources)[number];

export const objects = sqliteTable("objects", {
  oid: text("oid").primaryKey(),
  size: integer("size").notNull(),
  storageStatus: text("storage_status", { enum: storageStatuses })
    .notNull()
    .default("pending"),
  source: text("source", { enum: objectSources }).notNull(),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
  lastAccessed: text("last_accessed").notNull(),
});
