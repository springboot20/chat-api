import redisClient from '../configs/redis.config.js';

/**
 * Get data from cache or execute fallback and cache the result
 * @param {string} key Cache key
 * @param {Function} fallback Async function to get data if cache miss
 * @param {number} ttl Time to live in seconds (default 1 hour)
 */
export const getOrSetCache = async (key, fallback, ttl = 3600) => {
  try {
    const cachedData = await redisClient.get(key);
    if (cachedData) {
      console.log(` Cache hit for key: ${key}`);
      return JSON.parse(cachedData);
    }

    console.log(` Cache miss for key: ${key}`);
    const result = await fallback();

    // Only cache if result is not null/undefined
    if (result !== undefined && result !== null) {
      await redisClient.set(key, JSON.stringify(result), {
        EX: ttl,
      });
    }

    return result;
  } catch (error) {
    console.error(`❌ Cache error for key ${key}:`, error);
    // On cache error, just execute fallback to ensure app keeps working
    return await fallback();
  }
};

/**
 * Invalidate cache by key or pattern
 * @param {string} pattern Cache key or pattern (e.g., "user:chats:*")
 */
export const invalidateCache = async (pattern) => {
  try {
    if (pattern.includes('*')) {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(keys);
        console.log(` Invalidated ${keys.length} keys matching pattern: ${pattern}`);
      }
    } else {
      await redisClient.del(pattern);
      console.log(` Invalidated key: ${pattern}`);
    }
  } catch (error) {
    console.error(`❌ Cache invalidation error for pattern ${pattern}:`, error);
  }
};
