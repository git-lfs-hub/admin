# GitHub App (lfs-admin)

lfs-admin uses one **GitHub App** for everything: browser login (user-to-server OAuth),
reconciliation (installation token), and webhook-driven repo-change detection. (lfs-server
keeps its own OAuth App — see `server/github-app.md`.)

## Register the App

**Settings → Developer settings → GitHub Apps → New GitHub App** (register it under the
`{{org}}` org so it can be installed org-wide). The fields below follow the registration
form top to bottom.

**GitHub App name**

```
{{org}} Admin{{#if env}} ({{env}}){{/if}}
```

**Description** (Markdown; shown on the install/authorization screen)

```md
Install this app to sign in to the LFS admin dashboard and let it scan your
organization's repositories on GitHub. It uses:

- **Organization → Members (read)** — to sign you in and confirm you're an org admin
- **Repository → Metadata (read)** — to scan which repositories exist
- **Repository → Contents (read)** — to read each repo's `.lfsconfig` storage mapping
```

**Homepage URL**

```
{{github.adminHome}}
```

### Identifying and authorizing users

- **Callback URL**
  ```
  {{github.adminHome}}/login/oauth/callback
  ```
- [x] **Expire user authorization tokens** (the worker rotates refresh tokens)
- [x] **Request user authorization (OAuth) during installation**

### Post installation

Leave defaults (no Setup URL).

### Webhook

- [x] **Active**
- **Webhook URL**
  ```
  {{github.adminHome}}/webhooks/github
  ```
- **Secret**: a random string, e.g. `openssl rand -hex 32`, the same as `GITHUB_WEBHOOK_SECRET` below

### Permissions

**Repository**

- Metadata → `Read-only` (mandatory default) — detect which repos still exist
- Contents → `Read-only` — read each repo's committed `.lfsconfig` (storage prefix mapping)

**Organization**

- Members → `Read-only` — confirm the user is an org admin at login

### Subscribe to events

- [x] **Repository**
- [x] **Push** — scan `.lfsconfig` only when a push touches it (0 API calls otherwise)

### Where can this app be installed?

- **Only on this account** (`{{org}}`).

## Collect and store secrets

Creating the App lands you on its settings page. Collect from the **General** tab
and save with `wrangler` (you won't see secret values again):

```sh
wrangler secret put GITHUB_APP_ID           # About → App ID
wrangler secret put GITHUB_CLIENT_ID        # About → Client ID
wrangler secret put GITHUB_CLIENT_SECRET    # Client secrets → Generate a new client secret
wrangler secret put GITHUB_WEBHOOK_SECRET   # the Webhook secret you set above
wrangler secret put LOGIN_SECRET            # your own random string: openssl rand -hex 32
```

The private key (**Private keys → Generate a private key**, downloads a `.pem`) is
multiline and in PKCS#1 — convert to PKCS#8 and pipe from the file (the interactive prompt
can't take multiline input):

```sh
openssl pkcs8 -topk8 -nocrypt -in ~/Downloads/your-app.private-key.pem | \
wrangler secret put GITHUB_APP_PRIVATE_KEY
```

## Deploy

Deploy the worker (`turbo deploy`) **before** installing the App, so the OAuth callback and
webhook endpoint are live when the first install event fires. (If you install first, that
event is lost — harmless; the hourly reconciliation backfills it.)

## Install

Install the App on the org(s) whose repos are managed (`{{org}}`), choosing **All
repositories**. This covers current + future repos automatically (requires an org owner),
so reconciliation and webhooks see everything. **Only select repositories** would require
maintaining a list and re-installing for each new repo — webhooks fire only for installed
repos, and reconciliation lists installed orgs.

## After install

Sign in at {{github.adminHome}} — access is gated by `GITHUB_ORG` (`{{org}}`), org admins
only. The repo list is **empty until the first reconciliation** populates it; reconciliation
runs hourly (cron), so the initial sync can take up to an hour.
