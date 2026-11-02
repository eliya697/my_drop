import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { aiTask } from "./enums";
import { profiles } from "./users";

export const AI_GENERATION_STATUSES = [
  "ok",
  "refusal",
  "parse_error",
  "api_error",
  "rejected_by_validator",
] as const;
export type AiGenerationStatus = (typeof AI_GENERATION_STATUSES)[number];

/** Every Claude call — successful or not — with tokens, cost, and latency. */
export const aiGenerations = pgTable(
  "ai_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    task: aiTask("task").notNull(),
    /** 'product' | 'ticket' | 'campaign' */
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    model: text("model").notNull(),
    /** e.g. 'listing@3' */
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    output: jsonb("output"),
    status: text("status").$type<AiGenerationStatus>().notNull(),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" }),
    latencyMs: integer("latency_ms"),
    /** The server re-ran the request on another model after a policy decline. */
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    /** Produced through the Batches API (billed at 50%). */
    batch: boolean("batch").notNull().default(false),
    approvedBy: uuid("approved_by").references(() => profiles.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_generations_subject_idx").on(t.subjectType, t.subjectId, t.task),
    index("ai_generations_input_hash_idx").on(t.inputHash),
    index("ai_generations_created_at_idx").on(t.createdAt),
    check(
      "ai_generations_status_check",
      sql`${t.status} in ('ok', 'refusal', 'parse_error', 'api_error', 'rejected_by_validator')`,
    ),
  ],
);

export type AiBatchStatus = "submitted" | "ended" | "failed";

/** A Message Batches API submission; items are keyed by `custom_id` = subject id. */
export const aiBatches = pgTable(
  "ai_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerBatchId: text("provider_batch_id").notNull().unique(),
    task: aiTask("task").notNull(),
    status: text("status").$type<AiBatchStatus>().notNull().default("submitted"),
    itemCount: integer("item_count").notNull(),
    subjectIds: uuid("subject_ids").array().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [
    index("ai_batches_status_idx").on(t.status),
    check("ai_batches_status_check", sql`${t.status} in ('submitted', 'ended', 'failed')`),
  ],
);
