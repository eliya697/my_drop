import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orders } from "./orders";
import { citext } from "./types";

export type SupportTicketStatus = "open" | "ai_answered" | "escalated" | "closed";
export type SupportMessageRole = "customer" | "ai" | "agent" | "system";

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email").notNull(),
    orderId: uuid("order_id").references(() => orders.id),
    status: text("status").$type<SupportTicketStatus>().notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("support_tickets_status_idx").on(t.status, t.createdAt),
    index("support_tickets_email_idx").on(t.email),
    check("support_tickets_status_check", sql`${t.status} in ('open', 'ai_answered', 'escalated', 'closed')`),
  ],
);

export const supportMessages = pgTable(
  "support_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    role: text("role").$type<SupportMessageRole>().notNull(),
    body: text("body").notNull(),
    toolCalls: jsonb("tool_calls"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("support_messages_ticket_id_idx").on(t.ticketId, t.createdAt),
    check("support_messages_role_check", sql`${t.role} in ('customer', 'ai', 'agent', 'system')`),
  ],
);
