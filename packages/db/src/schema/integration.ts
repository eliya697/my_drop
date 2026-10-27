import { sql } from "drizzle-orm";
import { bigserial, check, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { bytea } from "./types";

/** Idempotency ledger for every inbound webhook. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("webhook_events_provider_event_id_key").on(t.provider, t.eventId),
    // Serves the sweeper that re-enqueues events that were received but never processed.
    index("webhook_events_unprocessed_idx")
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

export type AuditActorType = "user" | "system" | "ai" | "webhook";

/** Every state transition and every sensitive action. Append-only. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorType: text("actor_type").$type<AuditActorType>().notNull(),
    actorId: text("actor_id"),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId, t.createdAt.desc()),
    check("audit_log_actor_type_check", sql`${t.actorType} in ('user', 'system', 'ai', 'webhook')`),
  ],
);

/** OAuth tokens for AliExpress / Meta / TikTok, encrypted with AES-256-GCM before storage. */
export const integrationCredentials = pgTable("integration_credentials", {
  provider: text("provider").primaryKey(),
  secretCipher: bytea("secret_cipher").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
});
