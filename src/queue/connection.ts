import { ConnectionOptions } from "bullmq";

/**
 * Common configuration options for the BullMQ connection to the Redis cache database.
 */
export const redisConnection: ConnectionOptions = {
   host: process.env.REDIS_HOST || '127.0.0.1',
   port: parseInt(process.env.REDIS_PORT || '6379', 10)
};