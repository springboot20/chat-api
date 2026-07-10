// helpers/cache.helper.js
import redisClient from "../configs/redis.config.js";

/**
 * Get simple JSON data from cache or execute fallback and cache the result
 * Use this for: User profiles, static configs, and sessions.
 * @param {string} key Cache key
 * @param {Function} fallback Async function to get data if cache miss
 * @param {number} ttl Time to live in seconds (default 1 hour)
 */
export const getOrSetCache = async (key, fallback, ttl = 3600) => {
  try {
    const cachedData = await redisClient.get(key);
    if (cachedData) {
      console.log(`🎯 Cache hit for key: ${key}`);
      return JSON.parse(cachedData);
    }

    console.log(`🐢 Cache miss for key: ${key}`);
    const result = await fallback();

    // Only cache if result is not null or undefined
    if (result !== undefined && result !== null) {
      await redisClient.set(key, JSON.stringify(result), {
        EX: ttl,
      });
    }

    return result;
  } catch (error) {
    console.error(`❌ Cache error for key ${key}:`, error);
    // Silent fallback to database so your users never experience a crash
    return await fallback();
  }
};

/**
 * Invalidate cache safely using SCAN instead of the dangerous KEYS command
 * @param {string} pattern Cache key or pattern (e.g., "user:profile:*")
 */
export const invalidateCache = async (pattern) => {
  try {
    if (pattern.includes("*")) {
      let keysToDelete = [];

      // Safely fetch keys in chunks of 100 without stopping the Node.js event loop
      for await (const key of redisClient.scanIterator({
        MATCH: pattern,
        COUNT: 100,
      })) {
        keysToDelete.push(key);
      }

      if (keysToDelete.length > 0) {
        await redisClient.del(keysToDelete);
        console.log(
          `🧹 Safe-invalidated ${keysToDelete.length} keys for pattern: ${pattern}`,
        );
      }
    } else {
      await redisClient.del(pattern);
      console.log(`🧹 Invalidated key: ${pattern}`);
    }
  } catch (error) {
    console.error(`❌ Cache invalidation error for pattern ${pattern}:`, error);
  }
};
