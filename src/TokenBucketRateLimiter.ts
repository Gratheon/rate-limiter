import { RedisClientType } from "redis";

// Lua script for atomic Token Bucket consume operation
// KEYS[1] = Redis key for the bucket
// ARGV[1] = capacity (max tokens)
// ARGV[2] = refill rate (tokens per second)
// ARGV[3] = current timestamp (in seconds)
// ARGV[4] = TTL in seconds
const CONSUME_SCRIPT = `
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  local refillRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4])

  -- HGET tokens and last_refill_timestamp
  local currentTokens = tonumber(redis.call('HGET', key, 'tokens'))
  local lastRefillTimestamp = tonumber(redis.call('HGET', key, 'timestamp'))

  if not currentTokens then
    currentTokens = capacity
    lastRefillTimestamp = now
  end

  -- Calculate tokens to add since last refill
  local elapsed = now - lastRefillTimestamp
  local tokensToAdd = elapsed * refillRate

  if tokensToAdd > 0 then
    currentTokens = currentTokens + tokensToAdd
    lastRefillTimestamp = now
  end

  -- Cap tokens at capacity
  if currentTokens > capacity then
    currentTokens = capacity
  end

  -- Check if a token can be consumed
  local allowed = 0
  local remainingTokens = currentTokens

  if remainingTokens >= 1 then
    remainingTokens = remainingTokens - 1
    allowed = 1
  end

  -- Update the bucket state
  redis.call('HSET', key, 'tokens', remainingTokens)
  redis.call('HSET', key, 'timestamp', lastRefillTimestamp)
  
  -- Set TTL to prevent key accumulation
  redis.call('EXPIRE', key, ttl)

  return {allowed, remainingTokens}
`;

// Lua script for getting bucket status without consuming
// KEYS[1] = Redis key for the bucket
// ARGV[1] = capacity (max tokens)
// ARGV[2] = refill rate (tokens per second)
// ARGV[3] = current timestamp (in seconds)
const STATUS_SCRIPT = `
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  local refillRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])

  -- HGET tokens and last_refill_timestamp
  local currentTokens = tonumber(redis.call('HGET', key, 'tokens'))
  local lastRefillTimestamp = tonumber(redis.call('HGET', key, 'timestamp'))

  if not currentTokens then
    return {capacity, capacity, capacity}
  end

  -- Calculate tokens to add since last refill
  local elapsed = now - lastRefillTimestamp
  local tokensToAdd = elapsed * refillRate
  local newTokens = currentTokens + tokensToAdd

  -- Cap tokens at capacity
  if newTokens > capacity then
    newTokens = capacity
  end

  return {math.floor(newTokens), capacity, math.floor(newTokens)}
`;

// Lua script for resetting/clearing a bucket
// KEYS[1] = Redis key for the bucket
const RESET_SCRIPT = `
  local key = KEYS[1]
  return redis.call('DEL', key)
`;

// Lua script for batch consume
// KEYS[1] = Redis key for the bucket
// ARGV[1] = capacity (max tokens)
// ARGV[2] = refill rate (tokens per second)
// ARGV[3] = current timestamp (in seconds)
// ARGV[4] = TTL in seconds
// ARGV[5] = number of tokens to consume
const BATCH_CONSUME_SCRIPT = `
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  local refillRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4])
  local tokensToConsume = tonumber(ARGV[5])

  -- HGET tokens and last_refill_timestamp
  local currentTokens = tonumber(redis.call('HGET', key, 'tokens'))
  local lastRefillTimestamp = tonumber(redis.call('HGET', key, 'timestamp'))

  if not currentTokens then
    currentTokens = capacity
    lastRefillTimestamp = now
  end

  -- Calculate tokens to add since last refill
  local elapsed = now - lastRefillTimestamp
  local tokensToAdd = elapsed * refillRate

  if tokensToAdd > 0 then
    currentTokens = currentTokens + tokensToAdd
    lastRefillTimestamp = now
  end

  -- Cap tokens at capacity
  if currentTokens > capacity then
    currentTokens = capacity
  end

  -- Check if tokens can be consumed
  local allowed = 0
  local remainingTokens = currentTokens

  if remainingTokens >= tokensToConsume then
    remainingTokens = remainingTokens - tokensToConsume
    allowed = 1
  end

  -- Update the bucket state
  redis.call('HSET', key, 'tokens', remainingTokens)
  redis.call('HSET', key, 'timestamp', lastRefillTimestamp)
  
  -- Set TTL to prevent key accumulation
  redis.call('EXPIRE', key, ttl)

  return {allowed, remainingTokens}
`;

export interface RateLimiterConfig {
  capacity: number;
  refillRate: number; // Tokens per second
  prefix: string;
  redisClient: RedisClientType;
  ttlSeconds?: number; // Optional TTL for Redis keys (default: calculated from capacity/refillRate)
}

export interface ConsumeResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfter?: number; // Seconds until next token available
}

export interface BucketStatus {
  remainingTokens: number;
  capacity: number;
  resetTime?: Date; // When bucket will be full again
}

export class RateLimiterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimiterError';
  }
}

export class TokenBucketRateLimiter {
  private config: Required<RateLimiterConfig>;
  private consumeScriptSha: string | null = null;
  private statusScriptSha: string | null = null;
  private resetScriptSha: string | null = null;
  private batchConsumeScriptSha: string | null = null;

  constructor(config: RateLimiterConfig) {
    this.validateConfig(config);
    this.config = {
      ...config,
      ttlSeconds: config.ttlSeconds ?? this.calculateDefaultTTL(config),
    };
  }

  private validateConfig(config: RateLimiterConfig): void {
    if (!config.redisClient) {
      throw new RateLimiterError('redisClient is required');
    }
    
    if (typeof config.capacity !== 'number' || config.capacity <= 0) {
      throw new RateLimiterError('capacity must be a positive number');
    }
    
    if (typeof config.refillRate !== 'number' || config.refillRate < 0) {
      throw new RateLimiterError('refillRate must be a non-negative number');
    }
    
    if (typeof config.prefix !== 'string' || config.prefix.length === 0) {
      throw new RateLimiterError('prefix must be a non-empty string');
    }
    
    if (config.ttlSeconds !== undefined && (typeof config.ttlSeconds !== 'number' || config.ttlSeconds <= 0)) {
      throw new RateLimiterError('ttlSeconds must be a positive number');
    }
  }

  private calculateDefaultTTL(config: RateLimiterConfig): number {
    // Default TTL is 2x the time it takes to refill the bucket + 60s buffer
    if (config.refillRate === 0) {
      return 3600; // 1 hour for non-refilling buckets
    }
    return Math.ceil((config.capacity / config.refillRate) * 2) + 60;
  }

  private async loadScripts(): Promise<void> {
    if (!this.consumeScriptSha) {
      this.consumeScriptSha = await this.config.redisClient.scriptLoad(CONSUME_SCRIPT);
    }
    if (!this.statusScriptSha) {
      this.statusScriptSha = await this.config.redisClient.scriptLoad(STATUS_SCRIPT);
    }
    if (!this.resetScriptSha) {
      this.resetScriptSha = await this.config.redisClient.scriptLoad(RESET_SCRIPT);
    }
    if (!this.batchConsumeScriptSha) {
      this.batchConsumeScriptSha = await this.config.redisClient.scriptLoad(BATCH_CONSUME_SCRIPT);
    }
  }

  private async ensureScriptsLoaded(): Promise<void> {
    if (!this.consumeScriptSha || !this.statusScriptSha || !this.resetScriptSha || !this.batchConsumeScriptSha) {
      await this.loadScripts();
    }
  }

  private getKey(clientId: string): string {
    return `${this.config.prefix}:${clientId}`;
  }

  private calculateRetryAfter(remainingTokens: number): number {
    if (remainingTokens >= 1 || this.config.refillRate === 0) {
      return 0;
    }
    return Math.ceil((1 - remainingTokens) / this.config.refillRate);
  }

  private calculateResetTime(remainingTokens: number): Date | undefined {
    if (this.config.refillRate === 0) {
      return undefined;
    }
    const tokensNeeded = this.config.capacity - remainingTokens;
    const secondsToFull = tokensNeeded / this.config.refillRate;
    return new Date(Date.now() + secondsToFull * 1000);
  }

  /**
   * Attempts to consume one token for the given client ID.
   * @param clientId A unique identifier for the client (e.g., user ID, IP address).
   * @returns A promise that resolves to ConsumeResult with detailed information.
   */
  public async consume(clientId: string): Promise<ConsumeResult> {
    await this.ensureScriptsLoaded();

    const key = this.getKey(clientId);
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = (await this.config.redisClient.evalSha(this.consumeScriptSha!, {
        keys: [key],
        arguments: [
          this.config.capacity.toString(),
          this.config.refillRate.toString(),
          now.toString(),
          this.config.ttlSeconds.toString(),
        ],
      })) as [number, number];

      const allowed = result[0] === 1;
      const remainingTokens = result[1];

      return {
        allowed,
        remainingTokens,
        retryAfter: allowed ? undefined : this.calculateRetryAfter(remainingTokens),
      };
    } catch (error) {
      throw new RateLimiterError(`Failed to consume token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Attempts to consume multiple tokens for the given client ID.
   * @param clientId A unique identifier for the client.
   * @param tokens Number of tokens to consume.
   * @returns A promise that resolves to ConsumeResult.
   */
  public async consumeBatch(clientId: string, tokens: number): Promise<ConsumeResult> {
    if (tokens <= 0) {
      throw new RateLimiterError('tokens must be a positive number');
    }
    
    if (tokens > this.config.capacity) {
      throw new RateLimiterError(`Cannot consume ${tokens} tokens, exceeds capacity of ${this.config.capacity}`);
    }

    await this.ensureScriptsLoaded();

    const key = this.getKey(clientId);
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = (await this.config.redisClient.evalSha(this.batchConsumeScriptSha!, {
        keys: [key],
        arguments: [
          this.config.capacity.toString(),
          this.config.refillRate.toString(),
          now.toString(),
          this.config.ttlSeconds.toString(),
          tokens.toString(),
        ],
      })) as [number, number];

      const allowed = result[0] === 1;
      const remainingTokens = result[1];

      return {
        allowed,
        remainingTokens,
        retryAfter: allowed ? undefined : this.calculateRetryAfter(remainingTokens),
      };
    } catch (error) {
      throw new RateLimiterError(`Failed to consume batch tokens: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Gets the current status of the bucket without consuming any tokens.
   * @param clientId A unique identifier for the client.
   * @returns A promise that resolves to BucketStatus.
   */
  public async getStatus(clientId: string): Promise<BucketStatus> {
    await this.ensureScriptsLoaded();

    const key = this.getKey(clientId);
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = (await this.config.redisClient.evalSha(this.statusScriptSha!, {
        keys: [key],
        arguments: [
          this.config.capacity.toString(),
          this.config.refillRate.toString(),
          now.toString(),
        ],
      })) as [number, number, number];

      const remainingTokens = result[0];
      const capacity = result[1];

      return {
        remainingTokens,
        capacity,
        resetTime: this.calculateResetTime(remainingTokens),
      };
    } catch (error) {
      throw new RateLimiterError(`Failed to get status: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Resets/clears the rate limit bucket for a client.
   * @param clientId A unique identifier for the client.
   * @returns A promise that resolves to true if a key was deleted.
   */
  public async reset(clientId: string): Promise<boolean> {
    await this.ensureScriptsLoaded();

    const key = this.getKey(clientId);

    try {
      const result = (await this.config.redisClient.evalSha(this.resetScriptSha!, {
        keys: [key],
        arguments: [],
      })) as number;

      return result === 1;
    } catch (error) {
      throw new RateLimiterError(`Failed to reset bucket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Gets the rate limiter configuration (read-only).
   */
  public getConfig(): Readonly<RateLimiterConfig> {
    return { ...this.config };
  }
}
