"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenBucketRateLimiter = exports.RateLimiterError = void 0;
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
class RateLimiterError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RateLimiterError';
    }
}
exports.RateLimiterError = RateLimiterError;
class TokenBucketRateLimiter {
    constructor(config) {
        this.consumeScriptSha = null;
        this.statusScriptSha = null;
        this.resetScriptSha = null;
        this.batchConsumeScriptSha = null;
        this.validateConfig(config);
        this.config = {
            ...config,
            ttlSeconds: config.ttlSeconds ?? this.calculateDefaultTTL(config),
        };
    }
    validateConfig(config) {
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
    calculateDefaultTTL(config) {
        // Default TTL is 2x the time it takes to refill the bucket + 60s buffer
        if (config.refillRate === 0) {
            return 3600; // 1 hour for non-refilling buckets
        }
        return Math.ceil((config.capacity / config.refillRate) * 2) + 60;
    }
    async loadScripts() {
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
    async ensureScriptsLoaded() {
        if (!this.consumeScriptSha || !this.statusScriptSha || !this.resetScriptSha || !this.batchConsumeScriptSha) {
            await this.loadScripts();
        }
    }
    getKey(clientId) {
        return `${this.config.prefix}:${clientId}`;
    }
    calculateRetryAfter(remainingTokens) {
        if (remainingTokens >= 1 || this.config.refillRate === 0) {
            return 0;
        }
        return Math.ceil((1 - remainingTokens) / this.config.refillRate);
    }
    calculateResetTime(remainingTokens) {
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
    async consume(clientId) {
        await this.ensureScriptsLoaded();
        const key = this.getKey(clientId);
        const now = Math.floor(Date.now() / 1000);
        try {
            const result = (await this.config.redisClient.evalSha(this.consumeScriptSha, {
                keys: [key],
                arguments: [
                    this.config.capacity.toString(),
                    this.config.refillRate.toString(),
                    now.toString(),
                    this.config.ttlSeconds.toString(),
                ],
            }));
            const allowed = result[0] === 1;
            const remainingTokens = result[1];
            return {
                allowed,
                remainingTokens,
                retryAfter: allowed ? undefined : this.calculateRetryAfter(remainingTokens),
            };
        }
        catch (error) {
            throw new RateLimiterError(`Failed to consume token: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Attempts to consume multiple tokens for the given client ID.
     * @param clientId A unique identifier for the client.
     * @param tokens Number of tokens to consume.
     * @returns A promise that resolves to ConsumeResult.
     */
    async consumeBatch(clientId, tokens) {
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
            const result = (await this.config.redisClient.evalSha(this.batchConsumeScriptSha, {
                keys: [key],
                arguments: [
                    this.config.capacity.toString(),
                    this.config.refillRate.toString(),
                    now.toString(),
                    this.config.ttlSeconds.toString(),
                    tokens.toString(),
                ],
            }));
            const allowed = result[0] === 1;
            const remainingTokens = result[1];
            return {
                allowed,
                remainingTokens,
                retryAfter: allowed ? undefined : this.calculateRetryAfter(remainingTokens),
            };
        }
        catch (error) {
            throw new RateLimiterError(`Failed to consume batch tokens: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Gets the current status of the bucket without consuming any tokens.
     * @param clientId A unique identifier for the client.
     * @returns A promise that resolves to BucketStatus.
     */
    async getStatus(clientId) {
        await this.ensureScriptsLoaded();
        const key = this.getKey(clientId);
        const now = Math.floor(Date.now() / 1000);
        try {
            const result = (await this.config.redisClient.evalSha(this.statusScriptSha, {
                keys: [key],
                arguments: [
                    this.config.capacity.toString(),
                    this.config.refillRate.toString(),
                    now.toString(),
                ],
            }));
            const remainingTokens = result[0];
            const capacity = result[1];
            return {
                remainingTokens,
                capacity,
                resetTime: this.calculateResetTime(remainingTokens),
            };
        }
        catch (error) {
            throw new RateLimiterError(`Failed to get status: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Resets/clears the rate limit bucket for a client.
     * @param clientId A unique identifier for the client.
     * @returns A promise that resolves to true if a key was deleted.
     */
    async reset(clientId) {
        await this.ensureScriptsLoaded();
        const key = this.getKey(clientId);
        try {
            const result = (await this.config.redisClient.evalSha(this.resetScriptSha, {
                keys: [key],
                arguments: [],
            }));
            return result === 1;
        }
        catch (error) {
            throw new RateLimiterError(`Failed to reset bucket: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Gets the rate limiter configuration (read-only).
     */
    getConfig() {
        return { ...this.config };
    }
}
exports.TokenBucketRateLimiter = TokenBucketRateLimiter;
