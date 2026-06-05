import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable(
  "repos",
  {
    // lowercased
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    // Canonical `OwnerCase/RepoCase` name as written to R2 by lfs-server,
    // matching server Repos DO `name`.
    name: text("name").notNull(),
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

export const orgs = sqliteTable("orgs", {
  org: text("org").primaryKey(),
  status: text("status", {
    enum: ["active", "missing", "no_installation", "forbidden", "transient_error"],
  }).notNull(),
  firstSeen: text("first_seen").notNull(),
  updatedAt: text("updated_at").notNull(),
  missingAt: text("missing_at"),
  lastError: text("last_error"),
});

export type OrgStatus = "active" | "missing" | "no_installation" | "forbidden" | "transient_error";
