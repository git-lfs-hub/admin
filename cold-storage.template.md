# Cold storage (S3 backup tier)

lfs-admin can back up archived LFS storage to an external **S3 bucket** (Glacier classes) — a
cheap long-term tier beside the live Cloudflare R2 bucket. Enabling it adds **Back up**,
**Clear** (drop the live copy, keep the cold one), **Delete backup**, cold **Restore** (thaw
from Glacier), and the cold path of **Purge** to the Storage view.

**Off by default** — those actions stay hidden until `gc.coldStorage` names a backend, so the
worker runs fine with no bucket. Four steps to turn it on: provision a bucket, point config at
it, store two secrets, deploy.

## 1. Provision the S3 bucket

**Create bucket** — Console → S3 → **Create bucket** (or any S3-compatible store supporting the
Glacier classes + `RestoreObject`). Note its **region** and **name**:

- Bucket namespace → **Global namespace** (general purpose bucket) — not the "recommended"
  Account Regional namespace; the policy ARN and Glacier lifecycle below assume a global bucket
- Bucket name → `{{github.org}}-backup{{#if env}}-{{env}}{{/if}}`
- AWS Region → your region
- Block Public Access → **Block all public access**
- Bucket Versioning → **Disable**
- Default encryption → Encryption type → **SSE-S3** (AES256, S3-managed keys); Bucket Key → **Enable**

> The worker sends no encryption headers, so the bucket's default encryption applies — SSE-S3
> needs no extra permissions. SSE-KMS works only if you also grant the IAM identity `kms:Decrypt`
> + `kms:GenerateDataKey` (step 3's policy is S3-only); without them every cold op fails.

**Add a lifecycle rule** — the worker writes objects as `GLACIER_IR` (Instant Retrieval); this
rule ages them colder and reaps orphan upload parts. Console → your bucket → **Management** →
**Lifecycle rules** → **Create lifecycle rule**:

- Lifecycle rule name → `cold-aging`
- Choose a rule scope → **Apply to all objects in the bucket** (tick the acknowledgement box)
- Lifecycle rule actions:
  - [x] Transition current versions of objects between storage classes
  - [x] Delete expired object delete markers or incomplete multipart uploads
- Transition current versions of objects between storage classes:
  - Storage class transitions → **Glacier Deep Archive**
  - Days after object creation → `90`
- Delete expired object delete markers or incomplete multipart uploads:
  - [x] Delete incomplete multipart uploads → Number of days → `1`
- **Review timeline**, then **Create rule**

> 90 days is `GLACIER_IR`'s minimum billable duration, so the transition is penalty-free; the
> 1-day multipart expiry reaps orphan parts left by aborted backups, which the worker does not
> clean up.

How that lines up with the default `gc` schedule (day 0 = archived, which a repo reaches
`gc.autoDays.archive` = 7 days after it goes missing):

| Day | What happens | Driven by | Storage class | Restore |
|---|---|---|---|---|
| 0 | Archived + auto-backup → cold copy created | `gc.autoDays.archive` (7) | `GLACIER_IR` | instant (live still present) |
| 30 | Live R2 cleared (cold copy kept) | `gc.autoDays.clear` (30) | `GLACIER_IR` | instant (from cold) |
| 90 | Transition to Deep Archive | **S3 lifecycle rule** | `DEEP_ARCHIVE` | ~12 h thaw |
| 365 | Cold purge — live + cold deleted | `gc.retentionDays.cold` (365) | — (deleted) | — |

- Deep Archive residency = 365 − 90 = **275 days**, past its 180-day minimum.
- `GLACIER_IR` reads immediately; `DEEP_ARCHIVE` thaws async (~12 h). Live clears at day 30 while
  still `GLACIER_IR`, so prefixes restored in their first 90 days come back fast — older ones pay
  the thaw wait. Latency, not data loss.
- If you raise `gc.autoDays.clear` past 90 or drop `gc.retentionDays.cold` below ~270, move the
  transition day so it still respects the minimums.
- Cold storage **off**: no backup/clear/transition — the prefix is purged outright at
  `gc.retentionDays.live` (30).

## 2. Point config at the bucket

Set the region + name at the deploy root in `vars.input.json` (or per-env
`vars.input.{{env}}.json`). The minimum cold-storage config is the bucket plus the on/off flag:

```json
{
  "s3": { "backup": { "bucket": "{{github.org}}-backup{{#if env}}-{{env}}{{/if}}", "region": "us-east-1" } },
  "gc": { "coldStorage": "s3.backup" }
}
```

- `gc.coldStorage` is the on/off flag — `""` keeps cold storage off even with a bucket named.
- Everything else in `gc` is the lifecycle schedule; **every key has a built-in default**, so
  restate one only to override it. The block below shows them **for illustration only** — the
  values are the defaults, so copying it changes nothing:

```json
{
  "gc": {
    "coldStorage": "s3.backup",
    "autoDays": { "archive": 7, "clear": 30 },
    "confirmDays": 3,
    "retentionDays": { "live": 30, "cold": 365 }
  }
}
```

| `gc` key | Default | Meaning |
|---|---|---|
| `autoDays.archive` | 7 | days a repo stays missing before its storage is auto-archived (serve-blocked) |
| `autoDays.clear` | 30 | days after archive before the live R2 copy is auto-cleared (cold copy kept) |
| `confirmDays` | 3 | grace window an admin-triggered purge waits for confirmation before proceeding |
| `retentionDays.cold` | 365 | days after archive before a backed-up prefix is auto-purged (cold path) |
| `retentionDays.live` | 30 | days after archive before purge when cold storage is **off** (no backup) |

Re-render so the worker picks it up: `turbo run config` (deploy root) or `cd admin && bun run config`.

Currently rendered: region `{{#if s3.backup.region}}{{s3.backup.region}}{{else}}(empty){{/if}}`,
bucket `{{#if s3.backup.bucket}}{{s3.backup.bucket}}{{else}}(empty){{/if}}`, coldStorage
`{{#if gc.coldStorage}}{{gc.coldStorage}}{{else}}(empty — disabled){{/if}}`.

## 3. Store the credentials

**Create the IAM user** — Console → IAM → **Users** → **Create user**:

1. User name → `{{github.org}}-backup{{#if env}}-{{env}}{{/if}}`. Leave **Provide user access to the AWS Management
   Console** unchecked. **Next**.
2. Set permissions → **Next** without attaching anything (the policy goes on the user next).
   **Create user**.

**Attach the policy** — IAM → **Users** → open `{{github.org}}-backup{{#if env}}-{{env}}{{/if}}` → **Permissions** tab →
**Add permissions** → **Create inline policy**:

1. **JSON** tab → select all in the editor, paste the policy below over it. **Next**.
2. Policy name → `{{github.org}}-backup{{#if env}}-{{env}}{{/if}}-s3`. **Create policy**.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:RestoreObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::{{#if s3.backup.bucket}}{{s3.backup.bucket}}{{else}}{{github.org}}-backup{{#if env}}-{{env}}{{/if}}{{/if}}",
        "arn:aws:s3:::{{#if s3.backup.bucket}}{{s3.backup.bucket}}{{else}}{{github.org}}-backup{{#if env}}-{{env}}{{/if}}{{/if}}/*"
      ]
    }
  ]
}
```

**Make an access key** — IAM → **Users** → open `{{github.org}}-backup{{#if env}}-{{env}}{{/if}}` → **Security credentials**
→ **Create access key**:

1. Use case → **Application running outside AWS**. **Next**. (It recommends IAM Roles Anywhere —
   the worker needs a static long-lived key, so ignore it and continue.)
2. **Create access key**, then copy the **Access key ID** + **Secret access key** (the secret is
   shown once).

**Store both as secrets:**

```sh
wrangler secret put S3_BACKUP_ACCESS_KEY_ID      # IAM access key id
wrangler secret put S3_BACKUP_SECRET_ACCESS_KEY  # IAM secret access key
```

Both are **optional** — used only when cold storage is on. Set them **before** flipping the
flag, or every cold op fails.

## 4. Deploy + verify

1. Deploy the worker: `turbo deploy`.
2. Open **Storage** ({{github.adminHome}}/storage). An archived prefix's `…` overflow menu now
   shows **Back up / Clear / Delete backup**, and a **Backup** column reports the cold-copy state.
3. Smoke-test one prefix, end to end:
   - **Back up** → objects copied to S3 as `GLACIER_IR`; the Backup column shows a complete copy.
   - **Clear** → live R2 copy deleted, cold copy kept; the prefix stays archived.
   - **Restore** → thaws from Glacier (hours on colder tiers) and refills the live copy.
   - **Delete backup** → removes the cold copy while live is still present.

If a cold op errors, check:
- `S3_BACKUP_ACCESS_KEY_ID` / `S3_BACKUP_SECRET_ACCESS_KEY` are set.
- The IAM policy covers the actions above.
- `s3.backup.region` matches the bucket's real region (a wrong region shows up as an auth error).

To disable again: set `gc.coldStorage` back to `""` and re-render. The buttons disappear; existing
cold copies stay untouched in S3.
