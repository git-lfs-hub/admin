import { test, expect } from "vitest";
import { repos, orgs } from "@/db/repos-schema";
import { getTableConfig } from "drizzle-orm/sqlite-core";

test("repos table has composite primary key on (owner, repo)", () => {
  const config = getTableConfig(repos);
  const pk = config.primaryKeys[0];
  expect(pk).toBeDefined();
  expect(pk.columns.map((c) => c.name).sort()).toEqual(["owner", "repo"]);
});

test("repos status column has expected enum values", () => {
  const config = getTableConfig(repos);
  const status = config.columns.find((c) => c.name === "status")!;
  expect(status.enumValues).toEqual(["active", "missing", "archived", "purged"]);
});

test("repos table carries the cold-storage lifecycle columns", () => {
  const config = getTableConfig(repos);
  const names = config.columns.map((c) => c.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "archived_at",
      "backed_up_at",
      "backup_complete",
      "cleared_at",
      "active_op",
    ]),
  );
  expect(names).not.toContain("deleted_at");
});

test("orgs table has primary key on org", () => {
  const config = getTableConfig(orgs);
  const orgCol = config.columns.find((c) => c.name === "org")!;
  expect(orgCol.primary).toBe(true);
});

test("orgs status enum mirrors repos overlap + access states", () => {
  const config = getTableConfig(orgs);
  const status = config.columns.find((c) => c.name === "status")!;
  expect(status.enumValues).toEqual([
    "active",
    "missing",
    "no_installation",
    "forbidden",
    "transient_error",
  ]);
});

