import { z } from "zod";
import { formatIssues } from "./issues";

export function parseEnv<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment: ${formatIssues(result.error)}`);
  }
  return result.data;
}
