"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenBucketRateLimiter = void 0;
// Lua script for atomic Token Bucket logic
// KEYS[1] = Redis key for the bucket (e.g., "ratelimit:client:123")
// ARGV[1] = capacity (max tokens)
// ARGV[2] = refill rate (tokens per second)
// ARGV[3] = current timestamp (in seconds)
const LUA_SCRIPT = `
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  local refillRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])

  -- HGET tokens and last_refill_timestamp
  local currentTokens = tonumber(redis.call('HGET', key, 'tokens'))
  local lastRefillTimestamp = tonumber(redis.call('HGET', key, 'timestamp'))

  if not currentTokens then
    currentTokens = capacity -- Initialize tokens to capacity on first run
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

  -- Update the bucket state and set expiration (Optional, but good practice to clean up)
  redis.call('HSET', key, 'tokens', remainingTokens)
  redis.call('HSET', key, 'timestamp', lastRefillTimestamp)

  -- Set a long expiration time (e.g., twice the window, or 100 seconds if rate is 1 token/sec)
  -- This is a heuristic to prevent state buildup. Using ARGV[4] for an explicit TTL is better.
  -- For now, let's just set a TTL based on refill rate * 2 + 10 seconds. 
  -- For simplicity in this script, we'll omit an explicit TTL for now, but note it as a required improvement.
  -- redis.call('EXPIRE', key, math.ceil(capacity / refillRate) * 2)

  return {allowed, remainingTokens}
`;
class TokenBucketRateLimiter {
    constructor(config) {
        this.luaScriptSha = null;
        this.config = config;
    }
    /**
     * Loads the Lua script into Redis and caches the SHA.
     */
    async loadScript() {
        if (!this.luaScriptSha) {
            this.luaScriptSha = await this.config.redisClient.scriptLoad(LUA_SCRIPT);
        }
    }
    /**
     * Attempts to consume one token for the given client ID.
     * @param clientId A unique identifier for the client (e.g., user ID, IP address).
     * @returns A promise that resolves to true if the request is allowed, false otherwise.
     */
    async consume(clientId) {
        if (!this.luaScriptSha) {
            await this.loadScript();
        }
        const key = `${this.config.prefix}:${clientId}`;
        const now = Math.floor(Date.now() / 1000); // Current timestamp in seconds
        // Execute the Lua script using EVALSHA
        // KEYS = [key]
        // ARGV = [capacity, refillRate, now]
        const result = (await this.config.redisClient.evalSha(this.luaScriptSha, {
            keys: [key],
            arguments: [
                this.config.capacity.toString(),
                this.config.refillRate.toString(),
                now.toString(),
            ],
        })); // result is {allowed: number, remainingTokens: number}
        const allowed = result[0] === 1;
        // const remainingTokens = result[1]; // We can use this for a RateLimit header
        return allowed;
    }
}
exports.TokenBucketRateLimiter = TokenBucketRateLimiter;
