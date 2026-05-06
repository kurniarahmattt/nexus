import { Queue } from "bullmq";
import IORedis from "ioredis";
import { QueueNames, type InvokeJob } from "@nexus/schema";
import { env } from "./env.ts";

// BullMQ requires maxRetriesPerRequest=null for its blocking connection.
export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const invokeQueue = new Queue<InvokeJob>(QueueNames.invoke, {
  connection: redisConnection,
});
