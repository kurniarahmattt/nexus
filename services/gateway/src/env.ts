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
  // Public-facing base URL for join links + bridge WebSocket. Format:
  // "https://nexus.team.com" (no trailing slash). Defaults to localhost
  // for dev. Admin should set this to the externally-reachable origin
  // before issuing any join links — otherwise the URLs printed will not
  // be reachable by remote developers.
  NEXUS_PUBLIC_URL: z.string().default("http://localhost:4000"),
  // Default TTL for issued join codes (hours). 0 = never expire (not
  // recommended). The admin can override per-issue with a query param.
  NEXUS_JOIN_TTL_HOURS: z.coerce.number().default(24),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
