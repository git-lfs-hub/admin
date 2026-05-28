import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable(
  "repos",
  {
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    status: text("status", {
      enum: ["active", "missing", "deleted", "purged"],
    })
      .notNull()
      .default("active"),
    firstSeen: text("first_seen").notNull(),
    updatedAt: text("updated_at").notNull(),
    missingAt: text("missing_at"),
    deletedAt: text("deleted_at"),
    purgedAt: text("purged_at"),
  },
  (table) => [primaryKey({ columns: [table.owner, table.repo] })],
);

export type RepoStatus = "active" | "missing" | "deleted" | "purged";
