import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  COMPOSER_PORT: z.coerce.number().default(4001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MEM0_API_URL: z.string().url().default("http://localhost:4100"),
  MEM0_LLM_BASE_URL: z.string().url(),
  MEM0_LLM_MODEL: z.string().min(1),
  MEM0_LLM_API_KEY: z.string().default("dummy"),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
