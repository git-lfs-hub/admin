import { DurableObject } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { alertCopy, type AlertSeverity } from '@/alerts/message';
import { deliverSlack, type SlackDelivery } from '@/alerts/slack';
import { alerts, slack, SYSTEM_SLACK_SCOPE, type AlertKind } from '@/db/alerts-schema';
import { isoNow } from '@/lib/time';

export type AlertRow = typeof alerts.$inferSelect;
export type SlackError = { message: string; at: string };

export type NotifyInput = {
  kind: AlertKind;
  scope: string;
  severity?: AlertSeverity;
};

/**
 * Singleton alerts DO (`getByName("global")`). Every alert lives in one `alerts` table keyed
 * `(scope, kind)` — storage alerts (scope `lc(owner/repo)`) and global health (scope
 * `system:*`) alike. Group D is notify-only; approve/cancel + confirmation kinds are Group E.
 */
export class Alerts extends DurableObject<CloudflareBindings> {
  private db: DrizzleSqliteDODatabase;

  static global(env: CloudflareBindings): DurableObjectStub<Alerts> {
    return env.ALERTS.getByName('global');
  }

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS alerts (
          scope      TEXT NOT NULL,
          kind       TEXT NOT NULL,
          severity   TEXT NOT NULL,
          detail     TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (scope, kind)
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS slack (
          scope   TEXT PRIMARY KEY,
          kind    TEXT NOT NULL,
          sent_at TEXT NOT NULL,
          channel TEXT NOT NULL,
          ts      TEXT NOT NULL
        )
      `);
    });
  }

  /**
   * Idempotent so level-triggered callers (reconcile re-sends every unused prefix each tick)
   * cause no churn. Existing alert left untouched but re-passed to `deliverSlack` — which
   * still posts if no Slack row exists yet (alert raised while Slack was unconfigured).
   */
  async sendNotification(input: NotifyInput): Promise<AlertRow> {
    const existing = await this.getAlert(input.scope, input.kind);
    if (existing) {
      await deliverSlack(this.env, this, existing);
      return existing;
    }
    const now = isoNow();
    const severity = input.severity ?? alertCopy(input.kind, input.scope).severity;
    const [row] = await this.db
      .insert(alerts)
      .values({ scope: input.scope, kind: input.kind, severity, createdAt: now, updatedAt: now })
      .returning();
    await deliverSlack(this.env, this, row);
    return row;
  }

  async getAlert(scope: string, kind: string): Promise<AlertRow | null> {
    const [row] = await this.db.select().from(alerts).where(keyWhere(scope, kind));
    return row ?? null;
  }

  async listAlerts(): Promise<AlertRow[]> {
    return await this.db.select().from(alerts);
  }

  async clearAlert(scope: string, kind: string): Promise<void> {
    // Drop the alert row only — the per-scope `slack` message row persists so the next state
    // chat.updates it in place rather than posting a new message. Raw SQL: drizzle's
    // composite-`where` DELETE qualifies columns (`alerts.scope`), which DO SQLite rejects.
    this.ctx.storage.sql.exec('DELETE FROM alerts WHERE scope = ? AND kind = ?', scope, kind);
  }

  // --- SlackStore (used by deliverSlack): one message per scope ---

  async getSlackDelivery(scope: string): Promise<SlackDelivery | null> {
    const [row] = await this.db.select().from(slack).where(eq(slack.scope, scope));
    return row ? { kind: row.kind, sentAt: row.sentAt, channel: row.channel, ts: row.ts } : null;
  }

  async recordSlackDelivery(scope: string, delivery: SlackDelivery): Promise<void> {
    await this.db
      .insert(slack)
      .values({ scope, ...delivery })
      .onConflictDoUpdate({ target: slack.scope, set: delivery });
  }

  // --- global Slack delivery health: just another alert row (scope `system:slack`) ---

  async getSlackError(): Promise<SlackError | null> {
    const row = await this.getAlert(SYSTEM_SLACK_SCOPE, 'slack');
    return row?.detail ? { message: row.detail, at: row.updatedAt } : null;
  }

  async recordSlackError(message: string): Promise<void> {
    const now = isoNow();
    await this.db
      .insert(alerts)
      .values({
        scope: SYSTEM_SLACK_SCOPE,
        kind: 'slack',
        severity: 'warning',
        detail: message,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [alerts.scope, alerts.kind],
        set: { detail: message, updatedAt: now },
      });
  }

  async clearSlackError(): Promise<void> {
    await this.clearAlert(SYSTEM_SLACK_SCOPE, 'slack');
  }
}

function keyWhere(scope: string, kind: string) {
  return and(eq(alerts.scope, scope), eq(alerts.kind, kind));
}
