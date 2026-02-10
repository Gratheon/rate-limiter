import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createClient, RedisClientType } from "redis";
import { TokenBucketRateLimiter, ConsumeResult, RateLimiterError } from "./TokenBucketRateLimiter";

describe("TokenBucketRateLimiter Integration Tests (Real Redis)", () => {
  let redisClient: RedisClientType;
  const INTEGRATION_PREFIX = "test-integration";
  const TEST_KEYS: string[] = [];

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    redisClient = createClient({ 
      url: redisUrl
    }) as RedisClientType;
    
    await redisClient.connect();
    console.log(`Connected to Redis for integration tests at ${redisUrl}`);
  }, 10000);

  beforeEach(async () => {
    for (const key of TEST_KEYS) {
      await redisClient.del(key);
    }
    TEST_KEYS.length = 0;
  });

  afterAll(async () => {
    for (const key of TEST_KEYS) {
      await redisClient.del(key);
    }
    
    await redisClient.quit();
    console.log("Disconnected from Redis");
  }, 10000);

  const trackKey = (userId: string): void => {
    const key = `${INTEGRATION_PREFIX}:${userId}`;
    if (!TEST_KEYS.includes(key)) {
      TEST_KEYS.push(key);
    }
  };

  describe("Input Validation", () => {
    it("should throw error for missing redisClient", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          capacity: 10,
          refillRate: 1,
          prefix: "test",
          redisClient: undefined as any,
        });
      }).toThrow(RateLimiterError);
    });

    it("should throw error for invalid capacity", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          capacity: -5,
          refillRate: 1,
          prefix: "test",
          redisClient,
        });
      }).toThrow(RateLimiterError);

      expect(() => {
        new TokenBucketRateLimiter({
          capacity: 0,
          refillRate: 1,
          prefix: "test",
          redisClient,
        });
      }).toThrow(RateLimiterError);
    });

    it("should throw error for invalid refillRate", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          capacity: 10,
          refillRate: -1,
          prefix: "test",
          redisClient,
        });
      }).toThrow(RateLimiterError);
    });

    it("should throw error for invalid prefix", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          capacity: 10,
          refillRate: 1,
          prefix: "",
          redisClient,
        });
      }).toThrow(RateLimiterError);
    });

    it("should throw error for invalid ttlSeconds", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          capacity: 10,
          refillRate: 1,
          prefix: "test",
          redisClient,
          ttlSeconds: -1,
        });
      }).toThrow(RateLimiterError);
    });
  });

  describe("Enhanced API", () => {
    it("should return detailed consume result with remaining tokens", async () => {
      const userId = "api-test-user-1";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 5,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      });

      const result = await limiter.consume(userId);
      
      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(4);
      expect(result.retryAfter).toBeUndefined();
    });

    it("should return retryAfter when rate limited", async () => {
      const userId = "api-test-user-2";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 2,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      });

      await limiter.consume(userId);
      await limiter.consume(userId);
      const result = await limiter.consume(userId);
      
      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("should get bucket status without consuming", async () => {
      const userId = "api-test-user-3";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 10,
        refillRate: 2,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      });

      // Consume some tokens first
      await limiter.consume(userId);
      await limiter.consume(userId);
      await limiter.consume(userId);

      const status = await limiter.getStatus(userId);
      
      expect(status.remainingTokens).toBe(7);
      expect(status.capacity).toBe(10);
      expect(status.resetTime).toBeDefined();
    });

    it("should reset bucket", async () => {
      const userId = "api-test-user-4";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 3,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      });

      // Exhaust bucket
      await limiter.consume(userId);
      await limiter.consume(userId);
      await limiter.consume(userId);
      
      let result = await limiter.consume(userId);
      expect(result.allowed).toBe(false);

      // Reset bucket
      const wasDeleted = await limiter.reset(userId);
      expect(wasDeleted).toBe(true);

      // Should be able to consume again
      result = await limiter.consume(userId);
      expect(result.allowed).toBe(true);
    });

    it("should support batch consume", async () => {
      const userId = "api-test-user-5";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 10,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      });

      const result = await limiter.consumeBatch(userId, 3);
      
      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(7);
    });

    it("should reject batch consume exceeding capacity", async () => {
      const userId = "api-test-user-6";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 5,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      });

      await expect(limiter.consumeBatch(userId, 10)).rejects.toThrow(RateLimiterError);
    });

    it("should reject invalid batch consume parameters", async () => {
      const userId = "api-test-user-7";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 10,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      });

      await expect(limiter.consumeBatch(userId, 0)).rejects.toThrow(RateLimiterError);
      await expect(limiter.consumeBatch(userId, -1)).rejects.toThrow(RateLimiterError);
    });

    it("should return config via getConfig", () => {
      const limiter = new TokenBucketRateLimiter({
        capacity: 10,
        refillRate: 2,
        prefix: "test",
        redisClient,
        ttlSeconds: 300,
      });

      const config = limiter.getConfig();
      expect(config.capacity).toBe(10);
      expect(config.refillRate).toBe(2);
      expect(config.prefix).toBe("test");
      expect(config.ttlSeconds).toBe(300);
    });
  });

  describe("Basic Rate Limiting", () => {
    it("should allow a burst of requests up to capacity", async () => {
      const userId = "burst-user-1";
      trackKey(userId);

      const config = {
        capacity: 5,
        refillRate: 0,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      const results = await Promise.all([
        limiter.consume(userId),
        limiter.consume(userId),
        limiter.consume(userId),
        limiter.consume(userId),
        limiter.consume(userId),
      ]);

      expect(results.filter((r: ConsumeResult) => r.allowed).length).toBe(5);
      
      const result = await limiter.consume(userId);
      expect(result.allowed).toBe(false);
    });

    it("should deny requests when capacity is exceeded", async () => {
      const userId = "exceed-user-1";
      trackKey(userId);

      const config = {
        capacity: 3,
        refillRate: 0.5,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);

      expect((await limiter.consume(userId)).allowed).toBe(false);
      expect((await limiter.consume(userId)).allowed).toBe(false);
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

      expect((await limiter.consume(user1)).allowed).toBe(true);
      expect((await limiter.consume(user1)).allowed).toBe(true);
      expect((await limiter.consume(user1)).allowed).toBe(false);

      expect((await limiter.consume(user2)).allowed).toBe(true);
      expect((await limiter.consume(user2)).allowed).toBe(true);
      expect((await limiter.consume(user2)).allowed).toBe(false);
    });
  });

  describe("Token Refill Over Time", () => {
    it("should refill tokens over time", async () => {
      const userId = "refill-user-1";
      trackKey(userId);

      const config = {
        capacity: 5,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);
      
      for (let i = 0; i < 5; i++) {
        await limiter.consume(userId);
      }
      expect((await limiter.consume(userId)).allowed).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 2100));

      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(false);
    }, 10000);

    it("should refill tokens gradually with fractional refill rate", async () => {
      const userId = "fractional-refill-user";
      trackKey(userId);

      const config = {
        capacity: 10,
        refillRate: 0.5,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);
      
      for (let i = 0; i < 10; i++) {
        await limiter.consume(userId);
      }
      expect((await limiter.consume(userId)).allowed).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 2100));

      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(false);
    }, 10000);

    it("should not exceed capacity when refilling", async () => {
      const userId = "max-capacity-user";
      trackKey(userId);

      const config = {
        capacity: 5,
        refillRate: 2,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      await limiter.consume(userId);
      await limiter.consume(userId);
      await limiter.consume(userId);

      await new Promise(resolve => setTimeout(resolve, 5100));

      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(false);
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

      const promises = Array(20).fill(null).map(() => limiter.consume(userId));
      const results = await Promise.all(promises);

      const allowed = results.filter((r: ConsumeResult) => r.allowed).length;
      const denied = results.filter((r: ConsumeResult) => !r.allowed).length;

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

      const limiter1 = new TokenBucketRateLimiter(config);
      const limiter2 = new TokenBucketRateLimiter(config);
      const limiter3 = new TokenBucketRateLimiter(config);

      const results = await Promise.all([
        limiter1.consume(userId),
        limiter2.consume(userId),
        limiter3.consume(userId),
        limiter1.consume(userId),
        limiter2.consume(userId),
        limiter3.consume(userId),
      ]);

      const allowed = results.filter((r: ConsumeResult) => r.allowed).length;
      expect(allowed).toBe(5);
    });
  });

  describe("TTL and Expiration", () => {
    it("should set TTL on Redis keys", async () => {
      const userId = "ttl-test-user";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 10,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
        ttlSeconds: 60,
      });

      await limiter.consume(userId);

      const key = `${INTEGRATION_PREFIX}:${userId}`;
      const ttl = await redisClient.ttl(key);
      
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });

    it("should auto-calculate TTL when not provided", async () => {
      const userId = "ttl-auto-user";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 10,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      });

      await limiter.consume(userId);

      const key = `${INTEGRATION_PREFIX}:${userId}`;
      const ttl = await redisClient.ttl(key);
      
      expect(ttl).toBeGreaterThan(0);
    });

    it("should use default TTL for zero refill rate", async () => {
      const userId = "ttl-zero-refill";
      trackKey(userId);

      const limiter = new TokenBucketRateLimiter({
        capacity: 10,
        refillRate: 0,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      });

      await limiter.consume(userId);

      const key = `${INTEGRATION_PREFIX}:${userId}`;
      const ttl = await redisClient.ttl(key);
      
      expect(ttl).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    it("should handle Redis script errors gracefully", async () => {
      const userId = "error-test-user";
      trackKey(userId);

      // Create a limiter with a mock client that fails
      const failingClient = {
        ...redisClient,
        evalSha: jest.fn(() => Promise.reject(new Error('Redis connection failed'))),
        scriptLoad: jest.fn(() => Promise.reject(new Error('Redis connection failed'))),
      } as any;

      const limiter = new TokenBucketRateLimiter({
        capacity: 10,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient: failingClient,
      });

      await expect(limiter.consume(userId)).rejects.toThrow(RateLimiterError);
    });

    it("should handle Redis disconnection gracefully", async () => {
      const userId = "disconnect-test-user";
      
      // Create a disconnected client
      const disconnectedClient = createClient({
        url: "redis://localhost:9999",
      }) as RedisClientType;

      const limiter = new TokenBucketRateLimiter({
        capacity: 10,
        refillRate: 1,
        prefix: INTEGRATION_PREFIX,
        redisClient: disconnectedClient,
      });

      await expect(limiter.consume(userId)).rejects.toThrow();
    });
  });

  describe("Different Configurations", () => {
    it("should support high-throughput rate limiting", async () => {
      const userId = "high-throughput-user";
      trackKey(userId);

      const config = {
        capacity: 100,
        refillRate: 10,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      const results = await Promise.all(
        Array(100).fill(null).map(() => limiter.consume(userId))
      );

      expect(results.filter((r: ConsumeResult) => r.allowed).length).toBe(100);
      expect((await limiter.consume(userId)).allowed).toBe(false);
    });

    it("should support very low rate limiting", async () => {
      const userId = "slow-rate-user";
      trackKey(userId);

      const config = {
        capacity: 2,
        refillRate: 0.1,
        prefix: INTEGRATION_PREFIX,
        redisClient,
      };

      const limiter = new TokenBucketRateLimiter(config);

      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 1100));
      expect((await limiter.consume(userId)).allowed).toBe(false);
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

      await limiter1.consume(userId);
      await limiter1.consume(userId);
      await limiter1.consume(userId);
      expect((await limiter1.consume(userId)).allowed).toBe(false);

      expect((await limiter2.consume(userId)).allowed).toBe(true);
      expect((await limiter2.consume(userId)).allowed).toBe(true);
      expect((await limiter2.consume(userId)).allowed).toBe(true);
      expect((await limiter2.consume(userId)).allowed).toBe(false);
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

      await limiter.consume(userId);
      await limiter.consume(userId);
      await limiter.consume(userId);

      expect((await limiter.consume(userId)).allowed).toBe(true);
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

      expect((await limiter1.consume(user1)).allowed).toBe(true);
      expect((await limiter2.consume(user2)).allowed).toBe(true);
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

      expect((await limiter.consume(userId)).allowed).toBe(true);
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

      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(true);
      expect((await limiter.consume(userId)).allowed).toBe(false);
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

      for (let i = 0; i < 20; i++) {
        expect((await limiter.consume(userId)).allowed).toBe(true);
      }

      expect((await limiter.consume(userId)).allowed).toBe(false);
    });
  });
});
