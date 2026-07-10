import { createClient } from "redis";

// Initialize the client instance
const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

// Setup event listeners for debugging and error handling
redisClient.on("error", (err) => console.error("❌ Redis Client Error:", err));
redisClient.on("connect", () => console.log("🔄 Redis Connecting..."));
redisClient.on("ready", () =>
  console.log("🟢 Redis Client Connected and Ready!"),
);

// Connect to the Redis Server immediately
try {
  await redisClient.connect();
} catch (error) {
  console.error("❌ Failed to establish initial Redis connection:", error);
}

export default redisClient;
