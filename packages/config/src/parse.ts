import { type z } from "zod";

export class EnvValidationError extends Error {
  readonly issues: readonly { key: string; message: string }[];

  constructor(issues: readonly { key: string; message: string }[], label: string) {
    const lines = issues.map((i) => `  - ${i.key}: ${i.message}`).join("\n");
    super(`Invalid environment for ${label}:\n${lines}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Parses and validates environment variables. On failure, throws an error that lists every
 * problem by key name — never by value, so secrets cannot leak into logs or crash reports.
 */
export function parseEnv<S extends z.ZodTypeAny>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
  label = "application",
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      key: issue.path.join(".") || "(root)",
      message:
        issue.code === "invalid_type" && issue.received === "undefined" ? "is required" : issue.message,
    }));
    throw new EnvValidationError(issues, label);
  }
  return Object.freeze(result.data);
}
