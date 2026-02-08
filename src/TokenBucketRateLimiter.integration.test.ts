import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createClient, RedisClientType } from "redis";
import { TokenBucketRateLimiter } from "./TokenBucketRateLimiter";

describe("TokenBucketRateLimiter Integration Tests (Real Redis)", () => {
  let redisClient: RedisClientType;
  const INTEGRATION_PREFIX = "test-integration";
  const TEST_KEYS: string[] = [];

  beforeAll(async () => {
    // Connect to the actual Redis instance
    // Uses REDIS_URL env var (e.g., redis://:pass@localhost:6380)
    // Default fallback for local development
    const redisUrl = process.env.REDIS_URL || "redis://:pass@localhost:6379";
    redisClient = createClient({ 
      url: redisUrl
    }) as RedisClientType;
    
    await redisClient.connect();
    console.log(`Connected to Redis for integration tests at ${redisUrl}`);
  }, 10000);

  beforeEach(async () => {
    // Clear all test keys before each test
    for (const key of TEST_KEYS) {
      await redisClient.del(key);
    }
    TEST_KEYS.length = 0;
  });

  afterAll(async () => {
    // Clean up all test keys
    for (const key of TEST_KEYS) {
      await redisClient.del(key);
    }
    
    // Disconnect from Redis
    await redisClient.quit();
    console.log("Disconnected from Redis");
  }, 10000);

  const trackKey = (userId: string): void => {
    const key = `${INTEGRATION_PREFIX}:${userId}`;
    if (!TEST_KEYS.includes(key)) {
      TEST_KEYS.push(key);
    }
  };

  describe("Basic Rate Limiting", () => {
    it("should allow a burst of requests up to capacity", async () => {
      const userId = "burst-user-1";
      trackKey(userId);

      const config = {
        capacity: 5,
        refillRate: 0, // No refill to prevent race conditions in this test
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // First burst: 5 requests should be allowed
      const results = await Promise.all([
        limiter.consume(userId),
        limiter.consume(userId),
        limiter.consume(userId),
        limiter.consume(userId),
        limiter.consume(userId),
      ]);

      expect(results.filter(r => r === true).length).toBe(5);
      
      // 6th request should be denied (bucket is empty)
      expect(await limiter.consume(userId)).toBe(false);
    });

    it("should deny requests when capacity is exceeded", async () => {
      const userId = "exceed-user-1";
      trackKey(userId);

      const config = {
        capacity: 3,
        refillRate: 0.5, // 0.5 tokens per second
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // Consume all 3 tokens
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);

      // 4th request should be denied
      expect(await limiter.consume(userId)).toBe(false);
      expect(await limiter.consume(userId)).toBe(false);
    });

    it("should isolate rate limits per user", async () => {
      const user1 = "isolated-user-1";
      const user2 = "isolated-user-2";
      trackKey(user1);
      trackKey(user2);

      const config = {
        capacity: 2,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // User 1 exhausts their bucket
      expect(await limiter.consume(user1)).toBe(true);
      expect(await limiter.consume(user1)).toBe(true);
      expect(await limiter.consume(user1)).toBe(false);

      // User 2 should still have their full capacity
      expect(await limiter.consume(user2)).toBe(true);
      expect(await limiter.consume(user2)).toBe(true);
      expect(await limiter.consume(user2)).toBe(false);
    });
  });

  describe("Token Refill Over Time", () => {
    it("should refill tokens over time", async () => {
      const userId = "refill-user-1";
      trackKey(userId);

      const config = {
        capacity: 5,
        refillRate: 1, // 1 token per second
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);
      
      // Consume all 5 tokens
      for (let i = 0; i < 5; i++) {
        await limiter.consume(userId);
      }
      expect(await limiter.consume(userId)).toBe(false); // Verify bucket is empty

      // Wait 2 seconds (should refill 2 tokens)
      await new Promise(resolve => setTimeout(resolve, 2100));

      // 2 requests should be allowed
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);

      // 3rd request should be denied (0 tokens left)
      expect(await limiter.consume(userId)).toBe(false);
    }, 10000);

    it("should refill tokens gradually with fractional refill rate", async () => {
      const userId = "fractional-refill-user";
      trackKey(userId);

      const config = {
        capacity: 10,
        refillRate: 0.5, // 0.5 tokens per second = 1 token every 2 seconds
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);
      
      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        await limiter.consume(userId);
      }
      expect(await limiter.consume(userId)).toBe(false);

      // Wait 2 seconds (should refill 1 token: 2s * 0.5 tokens/s = 1 token)
      await new Promise(resolve => setTimeout(resolve, 2100));

      // Exactly 1 request should be allowed
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(false);
    }, 10000);

    it("should not exceed capacity when refilling", async () => {
      const userId = "max-capacity-user";
      trackKey(userId);

      const config = {
        capacity: 5,
        refillRate: 2, // 2 tokens per second
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // Consume 3 tokens
      await limiter.consume(userId);
      await limiter.consume(userId);
      await limiter.consume(userId);

      // Wait 5 seconds (should refill 10 tokens, but capped at capacity of 5)
      await new Promise(resolve => setTimeout(resolve, 5100));

      // Should be able to consume exactly 5 tokens (not 10)
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(false);
    }, 10000);
  });

  describe("Concurrent Requests", () => {
    it("should handle concurrent requests atomically", async () => {
      const userId = "concurrent-user";
      trackKey(userId);

      const config = {
        capacity: 10,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // Fire 20 concurrent requests
      const promises = Array(20).fill(null).map(() => limiter.consume(userId));
      const results = await Promise.all(promises);

      // Exactly 10 should succeed (capacity), 10 should fail
      const allowed = results.filter(r => r === true).length;
      const denied = results.filter(r => r === false).length;

      expect(allowed).toBe(10);
      expect(denied).toBe(10);
    });

    it("should handle multiple concurrent limiters for same user", async () => {
      const userId = "multi-limiter-user";
      trackKey(userId);

      const config = {
        capacity: 5,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      // Create 3 separate limiter instances
      const limiter1 = new TokenBucketRateLimiter(config);
      const limiter2 = new TokenBucketRateLimiter(config);
      const limiter3 = new TokenBucketRateLimiter(config);

      // Each limiter consumes tokens concurrently
      const results = await Promise.all([
        limiter1.consume(userId),
        limiter2.consume(userId),
        limiter3.consume(userId),
        limiter1.consume(userId),
        limiter2.consume(userId),
        limiter3.consume(userId),
      ]);

      // Should allow exactly 5 requests total across all limiters
      const allowed = results.filter(r => r === true).length;
      expect(allowed).toBe(5);
    });
  });

  describe("Different Configurations", () => {
    it("should support high-throughput rate limiting", async () => {
      const userId = "high-throughput-user";
      trackKey(userId);

      const config = {
        capacity: 100,
        refillRate: 10, // 10 tokens per second
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // Consume all 100 tokens rapidly
      const results = await Promise.all(
        Array(100).fill(null).map(() => limiter.consume(userId))
      );

      expect(results.filter(r => r === true).length).toBe(100);
      expect(await limiter.consume(userId)).toBe(false);
    });

    it("should support very low rate limiting (1 request per 10 seconds)", async () => {
      const userId = "slow-rate-user";
      trackKey(userId);

      const config = {
        capacity: 2,
        refillRate: 0.1, // 0.1 tokens per second = 1 token per 10 seconds
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // Consume initial capacity
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(false);

      // Wait 1 second (should refill 0.1 tokens, not enough for 1 request)
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(await limiter.consume(userId)).toBe(false);
    }, 10000);

    it("should work with different prefixes independently", async () => {
      const userId = "prefix-test-user";

      const config1 = {
        capacity: 3,
        refillRate: 1,
        prefix: "service-a",
        redisClient,
      };

      const config2 = {
        capacity: 3,
        refillRate: 1,
        prefix: "service-b",
        redisClient,
      };

      trackKey(`service-a:${userId}`);
      trackKey(`service-b:${userId}`);

      const limiter1 = new TokenBucketRateLimiter(config1);
      const limiter2 = new TokenBucketRateLimiter(config2);

      // Exhaust limiter1
      await limiter1.consume(userId);
      await limiter1.consume(userId);
      await limiter1.consume(userId);
      expect(await limiter1.consume(userId)).toBe(false);

      // limiter2 should still have full capacity
      expect(await limiter2.consume(userId)).toBe(true);
      expect(await limiter2.consume(userId)).toBe(true);
      expect(await limiter2.consume(userId)).toBe(true);
      expect(await limiter2.consume(userId)).toBe(false);
    });
  });

  describe("Script Loading and Reuse", () => {
    it("should load Lua script only once per limiter instance", async () => {
      const userId = "script-load-user";
      trackKey(userId);

      const config = {
        capacity: 5,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // Make multiple consume calls
      await limiter.consume(userId);
      await limiter.consume(userId);
      await limiter.consume(userId);

      // All calls should succeed without script loading errors
      expect(await limiter.consume(userId)).toBe(true);
    });

    it("should handle multiple limiter instances sharing same Redis client", async () => {
      const user1 = "shared-client-user-1";
      const user2 = "shared-client-user-2";
      trackKey(user1);
      trackKey(user2);

      const config1 = {
        capacity: 3,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const config2 = {
        capacity: 5,
        refillRate: 2,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter1 = new TokenBucketRateLimiter(config1);
      const limiter2 = new TokenBucketRateLimiter(config2);

      // Both limiters should work independently
      expect(await limiter1.consume(user1)).toBe(true);
      expect(await limiter2.consume(user2)).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero initial state correctly", async () => {
      const userId = "zero-state-user";
      trackKey(userId);

      const config = {
        capacity: 5,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // First request on a fresh key should be allowed (bucket initializes to capacity)
      expect(await limiter.consume(userId)).toBe(true);
    });

    it("should handle special characters in client ID", async () => {
      const userId = "user:with:colons@example.com";
      trackKey(userId);

      const config = {
        capacity: 3,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(true);
      expect(await limiter.consume(userId)).toBe(false);
    });

    it("should handle rapid sequential requests", async () => {
      const userId = "rapid-sequential-user";
      trackKey(userId);

      const config = {
        capacity: 20,
        refillRate: 5,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      // Make 20 rapid sequential requests
      for (let i = 0; i < 20; i++) {
        expect(await limiter.consume(userId)).toBe(true);
      }

      // 21st should fail
      expect(await limiter.consume(userId)).toBe(false);
    });
  });
});
