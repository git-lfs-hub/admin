import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable(
  "repos",
  {
    // lowercased
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    // Canonical `OwnerCase/RepoCase` name as written to R2 by lfs-server,
    // matching server Repos DO `name`.
    name: text("name").notNull(),
    // Resting states only; cold sub-steps advance fields below, not status.
    status: text("status", {
      enum: ["active", "missing", "archived", "purged"],
    })
      .notNull()
      .default("active"),
    firstSeen: text("first_seen").notNull(),
    updatedAt: text("updated_at").notNull(),
    missingAt: text("missing_at"),
    // when archived (blocked); anchors grace deadlines. Live retained.
    archivedAt: text("archived_at"),
    // when the last BackUp finished, any state; existence marker for a cold copy.
    backedUpAt: text("backed_up_at"),
    // true only if blocked the entire backup → cold copy provably complete; the Clear gate.
    backupComplete: integer("backup_complete", { mode: "boolean" }).notNull().default(false),
    // when Clear started (cold storage); once set, Restore needs Glacier.
    clearedAt: text("cleared_at"),
    purgedAt: text("purged_at"),
    // denormalized in-flight op set/cleared by the per-repo REPO DO; null = idle.
    activeOp: text("active_op"),
  },
  (table) => [primaryKey({ columns: [table.owner, table.repo] })],
);

export type RepoStatus = "active" | "missing" | "archived" | "purged";

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
