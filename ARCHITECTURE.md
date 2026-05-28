# Architecture

**Entry:** `src/index.tsx` — exports the Hono app alongside Durable Object classes.

**Route structure:**

Ingest

- **`POST /ingest`** — upsert a `repos` row when an upload or download event arrives from the LFS server.

Admin API (GitHub OAuth, org admin role required)

- **`GET /repos`** — repo list with status, object count, total size, and last reconciliation timestamp. Content-negotiated JSON or HTML.
- **`POST /repos/:owner/:repo/delete`** — block the repo on the LFS server, then set status `deleted` and record `earliest_purge`.
- **`POST /repos/:owner/:repo/undelete`** — unblock the repo on the LFS server, then restore status to `active`.

**Bindings:**

- **`REPOS`** (Durable Object, SQLite) — repository metadata and lifecycle state (`active` → `missing` → `deleted` → `purged`).
- **`LFS_BUCKET`** (R2) — LFS object storage; enumerated during R2 prefix listing and purged on confirmed deletion.

**Vars:** `GITHUB_ORG`, `GC_PURGE_GRACE_DAYS`.
**Secrets:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`.
