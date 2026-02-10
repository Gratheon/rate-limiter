import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { RedisClientType } from "redis";
import { TokenBucketRateLimiter, RateLimiterError, ConsumeResult } from "./TokenBucketRateLimiter";

// Mock implementation for the Redis Client used in unit tests
const mockRedisClient = {
  evalSha: jest.fn(() => Promise.resolve([1, 4])) as any,
  scriptLoad: jest.fn(() => Promise.resolve('MOCKED_SHA')) as any,
} as any;

describe("TokenBucketRateLimiter Unit Tests (Mocked Redis)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient.evalSha.mockClear();
    mockRedisClient.scriptLoad.mockClear();
  });

  const config = {
    capacity: 5,
    refillRate: 1,
    prefix: "test-unit",
    redisClient: mockRedisClient as unknown as RedisClientType,
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

    it("should throw error for negative capacity", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          ...config,
          capacity: -5,
        });
      }).toThrow(RateLimiterError);
    });

    it("should throw error for zero capacity", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          ...config,
          capacity: 0,
        });
      }).toThrow(RateLimiterError);
    });

    it("should throw error for negative refillRate", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          ...config,
          refillRate: -1,
        });
      }).toThrow(RateLimiterError);
    });

    it("should throw error for empty prefix", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          ...config,
          prefix: "",
        });
      }).toThrow(RateLimiterError);
    });

    it("should throw error for invalid ttlSeconds", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          ...config,
          ttlSeconds: -1,
        });
      }).toThrow(RateLimiterError);
    });

    it("should accept valid configurations", () => {
      expect(() => {
        new TokenBucketRateLimiter(config);
      }).not.toThrow();
    });

    it("should accept zero refillRate", () => {
      expect(() => {
        new TokenBucketRateLimiter({
          ...config,
          refillRate: 0,
        });
      }).not.toThrow();
    });
  });

  describe("Consume Method", () => {
    it("should load the Lua scripts once on first consumption", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      await limiter.consume("user1");
      await limiter.consume("user1");

      // Now loads 4 scripts: consume, status, reset, batch
      expect(mockRedisClient.scriptLoad).toHaveBeenCalledTimes(4);
      expect(mockRedisClient.evalSha).toHaveBeenCalledTimes(2);
    });

    it("should correctly parse the Lua script arguments on consume", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      const mockNow = 1678886400;
      jest.spyOn(Date, 'now').mockReturnValue(mockNow * 1000);

      mockRedisClient.evalSha.mockResolvedValue([1, 4]);

      await limiter.consume("user2");

      expect(mockRedisClient.evalSha).toHaveBeenCalledWith(
        'MOCKED_SHA',
        {
          keys: ["test-unit:user2"],
          arguments: [
            config.capacity.toString(),
            config.refillRate.toString(),
            mockNow.toString(),
            expect.any(String), // ttlSeconds
          ],
        }
      );
    });

    it("should return detailed result when allowed", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockResolvedValueOnce([1, 4]);

      const result = await limiter.consume("user3");

      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(4);
      expect(result.retryAfter).toBeUndefined();
    });

    it("should return retryAfter when denied", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockResolvedValueOnce([0, 0]);

      const result = await limiter.consume("user3");

      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("should throw RateLimiterError on Redis failure", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockRejectedValueOnce(new Error('Redis error'));

      await expect(limiter.consume("user3")).rejects.toThrow(RateLimiterError);
    });
  });

  describe("GetStatus Method", () => {
    it("should return bucket status without consuming", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockResolvedValueOnce([3, 5, 3]);

      const status = await limiter.getStatus("user4");

      expect(status.remainingTokens).toBe(3);
      expect(status.capacity).toBe(5);
      expect(status.resetTime).toBeDefined();
    });

    it("should handle fresh bucket status", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockResolvedValueOnce([5, 5, 5]);

      const status = await limiter.getStatus("new-user");

      expect(status.remainingTokens).toBe(5);
      expect(status.capacity).toBe(5);
    });

    it("should throw RateLimiterError on Redis failure", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockRejectedValueOnce(new Error('Redis error'));

      await expect(limiter.getStatus("user3")).rejects.toThrow(RateLimiterError);
    });
  });

  describe("Reset Method", () => {
    it("should reset bucket and return true", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockResolvedValueOnce(1);

      const result = await limiter.reset("user5");

      expect(result).toBe(true);
    });

    it("should return false if key does not exist", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockResolvedValueOnce(0);

      const result = await limiter.reset("user5");

      expect(result).toBe(false);
    });

    it("should throw RateLimiterError on Redis failure", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockRejectedValueOnce(new Error('Redis error'));

      await expect(limiter.reset("user3")).rejects.toThrow(RateLimiterError);
    });
  });

  describe("ConsumeBatch Method", () => {
    it("should consume multiple tokens", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockResolvedValueOnce([1, 2]);

      const result = await limiter.consumeBatch("user6", 3);

      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(2);
    });

    it("should deny batch consume exceeding available tokens", async () => {
      const limiter = new TokenBucketRateLimiter(config);
      mockRedisClient.evalSha.mockResolvedValueOnce([0, 1]);

      const result = await limiter.consumeBatch("user6", 5);

      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(1);
    });

    it("should throw error for invalid token count", async () => {
      const limiter = new TokenBucketRateLimiter(config);

      await expect(limiter.consumeBatch("user6", 0)).rejects.toThrow(RateLimiterError);
      await expect(limiter.consumeBatch("user6", -1)).rejects.toThrow(RateLimiterError);
    });

    it("should throw error for tokens exceeding capacity", async () => {
      const limiter = new TokenBucketRateLimiter(config);

      await expect(limiter.consumeBatch("user6", 10)).rejects.toThrow(RateLimiterError);
    });
  });

  describe("GetConfig Method", () => {
    it("should return read-only config", () => {
      const limiter = new TokenBucketRateLimiter({
        ...config,
        ttlSeconds: 300,
      });

      const returnedConfig = limiter.getConfig();
      
      expect(returnedConfig.capacity).toBe(5);
      expect(returnedConfig.refillRate).toBe(1);
      expect(returnedConfig.prefix).toBe("test-unit");
      expect(returnedConfig.ttlSeconds).toBe(300);
    });

    it("should auto-calculate ttl when not provided", () => {
      const limiter = new TokenBucketRateLimiter(config);

      const returnedConfig = limiter.getConfig();
      
      expect(returnedConfig.ttlSeconds).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    it("should handle script load failure", async () => {
      // Create a fresh mock client for this test
      const failingClient = {
        evalSha: jest.fn(() => Promise.resolve([1, 4])),
        scriptLoad: jest.fn(() => Promise.reject(new Error('Script load failed'))),
      };
      
      const limiter = new TokenBucketRateLimiter({
        ...config,
        redisClient: failingClient as unknown as RedisClientType,
      });

      await expect(limiter.consume("user")).rejects.toThrow();
    });

    it("should handle malformed Redis response by throwing RateLimiterError", async () => {
      // Create a fresh mock client for this test
      const malformedClient = {
        evalSha: jest.fn(() => Promise.resolve(null)),
        scriptLoad: jest.fn(() => Promise.resolve('MOCKED_SHA')),
      };
      
      const limiter = new TokenBucketRateLimiter({
        ...config,
        redisClient: malformedClient as unknown as RedisClientType,
      });

      // Should throw RateLimiterError when result is malformed
      await expect(limiter.consume("user")).rejects.toThrow(RateLimiterError);
    });
  });
});
