import { Redis } from 'ioredis';
import { config } from '../config.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Export the singleton instance so your other files can import { redis }
export const redis = new Redis(REDIS_URL, {

    maxRetriesPerRequest: 3,
    retryStrategy(times) {
        // Reconnect after a delay if the Redis container drops
        return Math.min(times * 50, 2000);
    }
});

redis.on('connect', () => {
    console.log('[Reids] connected Sucessfully');
});

redis.on('error', (err) => {
    console.error(err.message);
})