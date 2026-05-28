import { test, expect } from "vitest";
import { repos } from "./_repos-schema";
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
  expect(status.enumValues).toEqual(["active", "missing", "deleted", "purged"]);
});
