/**
 * Every queue in the system with its retry policy, per ARCHITECTURE.md §1.5. Queues are created
 * at startup (idempotently) so producers can enqueue before the consuming worker ships.
 * Jobs that exhaust their retries move to DEAD_LETTER_QUEUE, which alerts and never auto-retries.
 */
export const DEAD_LETTER_QUEUE = "system.dead_letter";

export type QueuePolicy = {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  /** Days to keep completed jobs before archival. */
  retentionDays?: number;
};

const ENRICH: QueuePolicy = { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 15 * 60 };
const FULFILL: QueuePolicy = { retryLimit: 6, retryDelay: 60, retryBackoff: true, expireInSeconds: 10 * 60 };
const STRIPE: QueuePolicy = { retryLimit: 10, retryDelay: 10, retryBackoff: true, expireInSeconds: 5 * 60 };
const DEFAULT: QueuePolicy = { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 10 * 60 };
const CRON: QueuePolicy = { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 5 * 60 };

export const QUEUES = {
  "system.heartbeat": CRON,

  "import.fetch": DEFAULT,
  "import.media": DEFAULT,
  "enrich.listing": ENRICH,
  "price.compute": DEFAULT,
  "publish.product": DEFAULT,
  "seo.sitemap.rebuild": DEFAULT,

  "stripe.event": STRIPE,
  "webhooks.sweep": CRON,

  "fulfill.place": FULFILL,
  "fulfill.confirm_payment": FULFILL,
  "track.poll": DEFAULT,

  "email.send": DEFAULT,
  "cart.scan": CRON,
  "cart.recover": DEFAULT,

  "ads.generate_creative": ENRICH,
  "ads.launch": DEFAULT,
  "ads.sync_metrics": DEFAULT,
  "ads.capi.purchase": STRIPE,

  "support.reply": ENRICH,
} as const satisfies Record<string, QueuePolicy>;

export type QueueName = keyof typeof QUEUES;
