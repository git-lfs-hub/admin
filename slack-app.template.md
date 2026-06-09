# Slack App (lfs-admin notifications)

lfs-admin posts **notifications** to a Slack channel on major storage-lifecycle changes
(repo missing / reappeared, storage archived / restored). Delivery is best-effort and
**no-ops when unconfigured** — leave `admin.slack.channel` empty and the worker simply skips
Slack. Wire it up by registering a Slack App bot, inviting it to a channel, and storing two
values: the bot token (`SLACK_BOT_TOKEN` secret) and the channel id (`admin.slack.channel`).

> Approve/Cancel **interactivity** (the `/webhooks/slack/interactions` endpoint + signing
> secret) is **not** used yet — it lands with the confirmation gate in a later group. This
> manifest covers outbound posting only (`chat:write`).

## Create the App from the manifest

**[api.slack.com/apps](https://api.slack.com/apps) → Create New App → From a manifest** →
pick the workspace whose channel should receive alerts → paste this (the name + scopes are
pre-filled, so there's nothing to click through):

```yaml
display_information:
  name: {{org}} Admin{{#if env}} ({{env}}){{/if}}
  description: Notifications for the {{org}} LFS admin storage lifecycle.
features:
  bot_user:
    display_name: {{org}} Admin{{#if env}} ({{env}}){{/if}}
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Review → **Create**.

## Install + collect the token

**Install App → Install to Workspace** → Allow. Copy the **Bot User OAuth Token** (starts
`xoxb-`) and store it (re-revealable on this page later):

```sh
cd admin && wrangler secret put SLACK_BOT_TOKEN   # the xoxb- bot token
```

## Pick the channel

Create (or choose) the ops channel, then **invite the bot** so it can post:

```
/invite @{{org}} Admin
```

Copy the channel id (channel name → **View channel details → bottom**, e.g. `C0123ABCD`) and
set it as the non-secret config in `vars.input.json` at the deploy root:

```json
{
  "admin": { "slack": { "channel": "C0123ABCD" } }
}
```

Re-render config so the worker picks it up (`turbo run config` at the deploy root, or
`cd admin && bun run config`). The channel id flows into `vars.ADMIN.slack.channel`
(`env.ADMIN.slack.channel`).

## Deploy + verify

Deploy the worker (`turbo deploy`). On the next lifecycle change — e.g. a repo deleted on
GitHub, detected by reconciliation and auto-Archived — a message appears in the channel:

```
📦 owner/repo storage archived — serving blocked   [ Open in admin ]
```

The **Open in admin** button links to {{github.adminHome}}/storage. If nothing arrives,
check that `SLACK_BOT_TOKEN` is set, the bot is a member of the channel, and
`admin.slack.channel` holds the channel **id** (not its name).
