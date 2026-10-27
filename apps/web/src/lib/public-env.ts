import { loadPublicEnv } from "@dropship/config/public";

/** Browser-safe configuration, validated once per bundle. */
export const publicEnv = loadPublicEnv();
