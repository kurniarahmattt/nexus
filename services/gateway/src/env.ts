import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  GATEWAY_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  NEXUS_WEBHOOK_TOKEN: z.string().min(1),
  MEM0_API_URL: z.string().url().default("http://localhost:4100"),
  ROCKETCHAT_URL: z.string().url().default("http://localhost:3000"),
  ROCKETCHAT_ADMIN_USERNAME: z.string().default("admin"),
  ROCKETCHAT_ADMIN_PASSWORD: z.string().min(1),
  NEXUS_ADMIN_TOKEN: z.string().optional(),
  NEXUS_SESSION_SECRET: z.string().min(16).default("nexus_dev_session_secret_at_least_16"),
  NEXUS_WEB_ORIGIN: z.string().default("http://localhost:5173"),
  NEXUS_DEBOUNCE_MS: z.coerce.number().default(3000),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
