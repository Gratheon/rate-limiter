import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { RedisClientType } from "redis";
import { TokenBucketRateLimiter } from "./TokenBucketRateLimiter";

// Mock implementation for the Redis Client used in unit tests
const mockRedisClient = {
  // Mock only the evalSha and scriptLoad methods used by the limiter
  evalSha: jest.fn(),
  scriptLoad: jest.fn().mockResolvedValue('MOCKED_SHA'), // Mock script loading
} as any; // Use 'any' to bypass strict CommandSignature types

describe("TokenBucketRateLimiter Unit Tests (Mocked Redis)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Ensure evalSha is cleared for correct call count tracking
    mockRedisClient.evalSha.mockClear();
  });

  const config = {
    capacity: 5,
    refillRate: 1, // 1 token per second
    prefix: "test-unit",
    redisClient: mockRedisClient as unknown as RedisClientType,
  };

  it("should load the Lua script once on first consumption", async () => {
    const limiter = new TokenBucketRateLimiter(config);
    await limiter.consume("user1");
    await limiter.consume("user1");

    expect(mockRedisClient.scriptLoad).toHaveBeenCalledTimes(1);
    expect(mockRedisClient.evalSha).toHaveBeenCalledTimes(2);
  });

  it("should correctly parse the Lua script arguments on consume", async () => {
    const limiter = new TokenBucketRateLimiter(config);
    // Mock the time to be constant for predictable ARGV[3] (timestamp)
    const mockNow = 1678886400; // arbitrary timestamp in seconds
    jest.spyOn(Date, 'now').mockReturnValue(mockNow * 1000);

    // Mock the script response: allowed (1), remaining (4)
    mockRedisClient.evalSha.mockResolvedValue([1, 4]);

    await limiter.consume("user2");

    // Expect the first call to evalSha to have the correct arguments
    expect(mockRedisClient.evalSha).toHaveBeenCalledWith(
      'MOCKED_SHA',
      {
        keys: ["test-unit:user2"],
        arguments: [
          config.capacity.toString(), // 5
          config.refillRate.toString(), // 1
          mockNow.toString(), // The mocked current time
        ],
      }
    );
  });

  it("should return true when allowed and false when denied", async () => {
    const limiter = new TokenBucketRateLimiter(config);

    // 1st call: allowed (1), remaining (4)
    mockRedisClient.evalSha.mockResolvedValueOnce([1, 4]);
    expect(await limiter.consume("user3")).toBe(true);

    // 2nd call: denied (0), remaining (0)
    mockRedisClient.evalSha.mockResolvedValueOnce([0, 0]);
    expect(await limiter.consume("user3")).toBe(false);

    // 3rd call: allowed (1), remaining (4)
    mockRedisClient.evalSha.mockResolvedValueOnce([1, 4]);
    expect(await limiter.consume("user3")).toBe(true);
  });
});

// --- Integration Tests (requires a running Redis instance) ---
// NOTE: This section is commented out to avoid requiring a live Redis connection.
/*
import { createClient } from "redis";
describe("TokenBucketRateLimiter Integration Tests (Actual Redis)", () => {
  let redisClient: RedisClientType;
  const INTEGRATION_PREFIX = "test-integration";
  const INTEGRATION_KEY = `${INTEGRATION_PREFIX}:int-user`;

  beforeAll(async () => {
    // Connect to the actual Redis instance
    redisClient = createClient({ url: "redis://localhost:6379" }) as RedisClientType;
    await redisClient.connect();
  });

  beforeEach(async () => {
    // Clear the test key before each test
    await redisClient.del(INTEGRATION_KEY);
  });

  afterAll(async () => {
    // Disconnect from Redis
    await redisClient.disconnect();
  });

  const config = {
    capacity: 5,
    refillRate: 1, // 1 token per second
    prefix: INTEGRATION_PREFIX,
    redisClient,
  };

  it("should allow a burst of requests up to capacity", async () => {
    const limiter = new TokenBucketRateLimiter(config);

    // First burst: 5 requests should be allowed
    const results = await Promise.all([
      limiter.consume("int-user"),
      limiter.consume("int-user"),
      limiter.consume("int-user"),
      limiter.consume("int-user"),
      limiter.consume("int-user"),
    ]);

    expect(results.filter(r => r === true).length).toBe(5);
    expect(await limiter.consume("int-user")).toBe(false);
  });

  it("should refill tokens over time", async () => {
    const limiter = new TokenBucketRateLimiter(config);
    
    // Consume all 5 tokens
    for (let i = 0; i < 5; i++) {
      await limiter.consume("int-user");
    }
    expect(await limiter.consume("int-user")).toBe(false); // Check it's empty

    // Advance time by 2 seconds (should refill 2 tokens)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2 requests should be allowed
    expect(await limiter.consume("int-user")).toBe(true);
    expect(await limiter.consume("int-user")).toBe(true);

    // 3rd request should be denied (0 tokens left)
    expect(await limiter.consume("int-user")).toBe(false);
  }, 5000); // Increase timeout for test that waits 2 seconds
});
*/
