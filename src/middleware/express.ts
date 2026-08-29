import { Request, Response, NextFunction } from "express";
import { TokenBucketRateLimiter, ConsumeResult, RateLimiterConfig } from "../TokenBucketRateLimiter";

export interface ExpressMiddlewareConfig {
  /**
   * Function to extract the client identifier from the request.
   * Default: req.ip
   */
  keyGenerator?: (req: Request) => string;
  
  /**
   * Function to skip rate limiting for certain requests.
   * Default: undefined (no skipping)
   */
  skip?: (req: Request) => boolean;
  
  /**
   * Custom handler for rate limit exceeded.
   * Default: returns 429 with standard headers
   */
  onLimitReached?: (req: Request, res: Response, next: NextFunction, result: ConsumeResult) => void;
  
  /**
   * Whether to include rate limit headers in successful responses.
   * Default: true
   */
  includeHeaders?: boolean;
  
  /**
   * Header names for rate limit information.
   */
  headers?: {
    limit?: string;
    remaining?: string;
    reset?: string;
    retryAfter?: string;
  };
}

const DEFAULT_HEADERS = {
  limit: 'X-RateLimit-Limit',
  remaining: 'X-RateLimit-Remaining',
  reset: 'X-RateLimit-Reset',
  retryAfter: 'Retry-After',
};

/**
 * Creates an Express middleware for rate limiting.
 * @param limiter The TokenBucketRateLimiter instance to use.
 * @param config Middleware configuration options.
 * @returns Express middleware function.
 * 
 * @example
 * ```typescript
 * import express from 'express';
 * import { createClient } from 'redis';
 * import { TokenBucketRateLimiter, createRateLimitMiddleware } from '@gratheon/rate-limiter';
 * 
 * const app = express();
 * const redisClient = createClient({ url: 'redis://localhost:6379' });
 * await redisClient.connect();
 * 
 * const limiter = new TokenBucketRateLimiter({
 *   redisClient,
 *   capacity: 100,
 *   refillRate: 10,
 *   prefix: 'api',
 * });
 * 
 * // Basic usage - rate limit by IP
 * app.use(createRateLimitMiddleware(limiter));
 * 
 * // Rate limit by user ID
 * app.use('/api/protected', createRateLimitMiddleware(limiter, {
 *   keyGenerator: (req) => req.user?.id || req.ip,
 *   capacity: 50,
 *   refillRate: 5,
 * }));
 * 
 * // Skip rate limiting for health checks
 * app.use(createRateLimitMiddleware(limiter, {
 *   skip: (req) => req.path === '/health',
 * }));
 * ```
 */
export function createRateLimitMiddleware(
  limiter: TokenBucketRateLimiter,
  config: ExpressMiddlewareConfig = {}
) {
  const {
    keyGenerator = (req: Request) => req.ip || 'unknown',
    skip,
    onLimitReached,
    includeHeaders = true,
    headers: customHeaders = {},
  } = config;

  const headers = { ...DEFAULT_HEADERS, ...customHeaders };
  const limiterConfig = limiter.getConfig();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Skip if configured
    if (skip?.(req)) {
      next();
      return;
    }

    const clientId = keyGenerator(req);

    try {
      const result = await limiter.consume(clientId);

      // Add rate limit headers to response
      if (includeHeaders) {
        res.setHeader(headers.limit, limiterConfig.capacity.toString());
        res.setHeader(headers.remaining, result.remainingTokens.toString());
        
        if (result.retryAfter) {
          res.setHeader(headers.retryAfter, result.retryAfter.toString());
        }
      }

      if (result.allowed) {
        next();
      } else {
        if (onLimitReached) {
          onLimitReached(req, res, next, result);
        } else {
          res.status(429).json({
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
            retryAfter: result.retryAfter,
          });
        }
      }
    } catch (error) {
      // Log error but allow request through (fail open) for graceful degradation
      console.error('Rate limiter error:', error);
      next();
    }
  };
}

/**
 * Creates a middleware that returns rate limit status without consuming tokens.
 * Useful for endpoints that want to inform clients about their current limits.
 * @param limiter The TokenBucketRateLimiter instance to use.
 * @param config Middleware configuration options.
 * @returns Express middleware function.
 * 
 * @example
 * ```typescript
 * app.get('/api/rate-limit-status', createRateLimitStatusMiddleware(limiter, {
 *   keyGenerator: (req) => req.user?.id || req.ip,
 * }));
 * ```
 */
export function createRateLimitStatusMiddleware(
  limiter: TokenBucketRateLimiter,
  config: ExpressMiddlewareConfig = {}
) {
  const {
    keyGenerator = (req: Request) => req.ip || 'unknown',
    skip,
    includeHeaders = true,
    headers: customHeaders = {},
  } = config;

  const headers = { ...DEFAULT_HEADERS, ...customHeaders };
  const limiterConfig = limiter.getConfig();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (skip?.(req)) {
      next();
      return;
    }

    const clientId = keyGenerator(req);

    try {
      const status = await limiter.getStatus(clientId);

      if (includeHeaders) {
        res.setHeader(headers.limit, status.capacity.toString());
        res.setHeader(headers.remaining, status.remainingTokens.toString());
        
        if (status.resetTime) {
          res.setHeader(headers.reset, Math.floor(status.resetTime.getTime() / 1000).toString());
        }
      }

      // Attach status to request for downstream use
      (req as any).rateLimitStatus = status;
      
      next();
    } catch (error) {
      console.error('Rate limit status error:', error);
      next();
    }
  };
}
