// @ts-nocheck
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Request, Response, NextFunction } from "express";
import { TokenBucketRateLimiter } from "../TokenBucketRateLimiter";
import { createRateLimitMiddleware, createRateLimitStatusMiddleware } from "./express";

describe("Express Middleware", () => {
  let mockLimiter: {
    consume: jest.Mock;
    getStatus: jest.Mock;
    getConfig: jest.Mock;
  };
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockLimiter = {
      consume: jest.fn(),
      getStatus: jest.fn(),
      getConfig: jest.fn(() => ({
        capacity: 10,
        refillRate: 1,
        prefix: 'test',
        redisClient: {} as any,
        ttlSeconds: 60,
      })),
    };

    mockReq = {
      ip: '127.0.0.1',
      path: '/api/test',
    };
    
    mockRes = {
      setHeader: jest.fn().mockReturnThis() as any,
      status: jest.fn().mockReturnThis() as any,
      json: jest.fn().mockReturnThis() as any,
    };
    
    mockNext = jest.fn();

    jest.clearAllMocks();
  });

  describe("createRateLimitMiddleware", () => {
    it("should allow request when rate limit not exceeded", async () => {
      mockLimiter.consume.mockResolvedValue({
        allowed: true,
        remainingTokens: 9,
      });

      const middleware = createRateLimitMiddleware(mockLimiter as unknown as TokenBucketRateLimiter);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockLimiter.consume).toHaveBeenCalledWith('127.0.0.1');
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '9');
    });

    it("should deny request when rate limit exceeded", async () => {
      mockLimiter.consume.mockResolvedValue({
        allowed: false,
        remainingTokens: 0,
        retryAfter: 60,
      });

      const middleware = createRateLimitMiddleware(mockLimiter as unknown as TokenBucketRateLimiter);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(429);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Too Many Requests',
        retryAfter: 60,
      }));
      expect(mockRes.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    });

    it("should use custom key generator", async () => {
      mockLimiter.consume.mockResolvedValue({
        allowed: true,
        remainingTokens: 5,
      });

      interface CustomRequest extends Request {
        user?: { id: string };
      }

      const customReq: CustomRequest = {
        ...mockReq,
        user: { id: 'user123' },
      } as CustomRequest;

      const middleware = createRateLimitMiddleware(mockLimiter as unknown as TokenBucketRateLimiter, {
        keyGenerator: (req: CustomRequest) => req.user?.id || req.ip || 'unknown',
      });

      await middleware(customReq as Request, mockRes as Response, mockNext);

      expect(mockLimiter.consume).toHaveBeenCalledWith('user123');
    });

    it("should skip rate limiting when skip function returns true", async () => {
      const middleware = createRateLimitMiddleware(mockLimiter as unknown as TokenBucketRateLimiter, {
        skip: (req) => req.path === '/health',
      });

      const healthReq = { ...mockReq, path: '/health' } as Request;
      await middleware(healthReq, mockRes as Response, mockNext);

      expect(mockLimiter.consume).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should call custom onLimitReached handler", async () => {
      const onLimitReached = jest.fn();
      mockLimiter.consume.mockResolvedValue({
        allowed: false,
        remainingTokens: 0,
        retryAfter: 30,
      });

      const middleware = createRateLimitMiddleware(mockLimiter as unknown as TokenBucketRateLimiter, {
        onLimitReached,
      });

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(onLimitReached).toHaveBeenCalledWith(
        mockReq,
        mockRes,
        mockNext,
        expect.objectContaining({ allowed: false })
      );
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("should fail open when limiter throws error", async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockLimiter.consume.mockRejectedValue(new Error('Redis error'));

      const middleware = createRateLimitMiddleware(mockLimiter as unknown as TokenBucketRateLimiter);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });

    it("should use custom headers", async () => {
      mockLimiter.consume.mockResolvedValue({
        allowed: true,
        remainingTokens: 7,
      });

      const middleware = createRateLimitMiddleware(mockLimiter as unknown as TokenBucketRateLimiter, {
        headers: {
          limit: 'X-Custom-Limit',
          remaining: 'X-Custom-Remaining',
        },
      });

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Custom-Limit', '10');
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Custom-Remaining', '7');
    });

    it("should not include headers when includeHeaders is false", async () => {
      mockLimiter.consume.mockResolvedValue({
        allowed: true,
        remainingTokens: 9,
      });

      const middleware = createRateLimitMiddleware(mockLimiter as unknown as TokenBucketRateLimiter, {
        includeHeaders: false,
      });

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should default to 'unknown' when req.ip is undefined", async () => {
      mockLimiter.consume.mockResolvedValue({
        allowed: true,
        remainingTokens: 9,
      });

      const reqWithoutIp = { ...mockReq, ip: undefined } as unknown as Request;
      const middleware = createRateLimitMiddleware(mockLimiter as unknown as TokenBucketRateLimiter);

      await middleware(reqWithoutIp, mockRes as Response, mockNext);

      expect(mockLimiter.consume).toHaveBeenCalledWith('unknown');
    });
  });

  describe("createRateLimitStatusMiddleware", () => {
    it("should set rate limit status headers", async () => {
      const resetTime = new Date(Date.now() + 5000);
      mockLimiter.getStatus.mockResolvedValue({
        remainingTokens: 5,
        capacity: 10,
        resetTime,
      });

      const middleware = createRateLimitStatusMiddleware(mockLimiter as unknown as TokenBucketRateLimiter);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockLimiter.getStatus).toHaveBeenCalledWith('127.0.0.1');
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '5');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Reset',
        Math.floor(resetTime.getTime() / 1000).toString()
      );
      expect(mockNext).toHaveBeenCalled();
    });

    it("should attach status to request object", async () => {
      mockLimiter.getStatus.mockResolvedValue({
        remainingTokens: 3,
        capacity: 10,
        resetTime: new Date(),
      });

      const middleware = createRateLimitStatusMiddleware(mockLimiter as unknown as TokenBucketRateLimiter);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect((mockReq as any).rateLimitStatus).toEqual(expect.objectContaining({
        remainingTokens: 3,
        capacity: 10,
      }));
    });

    it("should skip when skip function returns true", async () => {
      const middleware = createRateLimitStatusMiddleware(mockLimiter as unknown as TokenBucketRateLimiter, {
        skip: (req) => req.path === '/health',
      });

      const healthReq = { ...mockReq, path: '/health' } as Request;
      await middleware(healthReq, mockRes as Response, mockNext);

      expect(mockLimiter.getStatus).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should fail open on error", async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockLimiter.getStatus.mockRejectedValue(new Error('Redis error'));

      const middleware = createRateLimitStatusMiddleware(mockLimiter as unknown as TokenBucketRateLimiter);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });
  });
});
