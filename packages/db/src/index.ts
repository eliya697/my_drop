export * from "./schema/index";
export {
  createDb,
  pingDatabase,
  type CreateDbOptions,
  type Database,
  type DbHandle,
  type Schema,
  type Transaction,
} from "./client";
export {
  SYSTEM_ACTOR,
  transitionOrder,
  transitionProduct,
  type Actor,
  type Executor,
  type OrderPatch,
  type ProductPatch,
  type TransitionResult,
} from "./transitions";
export {
  listPendingImages,
  markImageFailed,
  markImageStored,
  normalizedOf,
  stableHash,
  upsertImportedProduct,
  type ImportedVariant,
  type ImportResult,
  type PendingImage,
} from "./catalog-import";
export {
  aiSpendMicros,
  availableSlug,
  closeBatch,
  findReusableGeneration,
  idsInOpenBatches,
  loadEnrichmentSource,
  openBatches,
  productsInStatus,
  recordBatch,
  recordGeneration,
  type EnrichmentSource,
  type GenerationRecord,
} from "./enrichment";
export {
  loadPricingContext,
  saveVariantPrices,
  type PricingContext,
  type VariantPriceUpdate,
} from "./pricing-store";
export {
  CredentialDecryptionError,
  CredentialStore,
  decryptSecret,
  encryptSecret,
  type CredentialStoreOptions,
} from "./credentials";
export { sql } from "drizzle-orm";
// Migrations are exposed via "@dropship/db/migrate" only, so bundlers (Next.js) never pull in
// the migrator or its filesystem paths.
