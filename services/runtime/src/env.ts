import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  RUNTIME_PORT: z.coerce.number().default(4002),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ROCKETCHAT_URL: z.string().url(),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
