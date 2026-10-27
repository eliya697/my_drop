import { customType } from "drizzle-orm/pg-core";

/** Case-insensitive text (requires the `citext` extension, created in the first migration). */
export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
