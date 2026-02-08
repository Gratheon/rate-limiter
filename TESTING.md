# Testing Guide

This document describes the testing strategy for the rate-limiter library.

## Test Structure

The test suite is divided into two categories:

### 1. Unit Tests (`TokenBucketRateLimiter.test.ts`)

Unit tests use **mocked Redis clients** and run quickly without external dependencies.

**What they test:**
- Lua script loading behavior
- Correct argument parsing
- Response handling logic

**Run unit tests:**
```bash
npm run test:unit
```

### 2. Integration Tests (`TokenBucketRateLimiter.integration.test.ts`)

Integration tests use a **real Redis instance** to verify the rate limiter works correctly in a production-like environment.

**What they test:**

#### Basic Rate Limiting
- Burst capacity enforcement
- Denial of requests exceeding capacity
- Isolation between different users

#### Token Refill Over Time
- Token refill at configured rates
- Fractional refill rates (e.g., 0.5 tokens/second)
- Maximum capacity enforcement during refill

#### Concurrent Requests
- Atomic operations under concurrent load
- Multiple limiter instances sharing the same Redis client

#### Different Configurations
- High-throughput scenarios (100 tokens, 10/second refill)
- Low-rate scenarios (0.1 tokens/second)
- Different prefixes for service isolation

#### Script Loading and Reuse
- Lua script caching across requests
- Multiple limiter instances

#### Edge Cases
- Fresh key initialization
- Special characters in client IDs
- Rapid sequential requests

**Run integration tests:**
```bash
npm run test:integration
```

## Redis Setup for Integration Tests

### Option 1: Using Docker (Recommended)

Start a Redis container:

```bash
# Without password
docker run -d -p 6379:6379 --name test-redis redis:latest

# With password
docker run -d -p 6379:6379 --name test-redis redis:latest redis-server --requirepass mypassword
```

### Option 2: Using Existing Redis

If you have Redis already running in your environment (like the gratheon development setup), set the `REDIS_URL` environment variable:

```bash
# Without password
export REDIS_URL=redis://localhost:6379

# With password
export REDIS_URL=redis://:mypassword@localhost:6379
```

**Default Configuration:**
- URL: `redis://:pass@localhost:5200`
- This matches the gratheon development environment

### Option 3: Local Redis Installation

Install Redis locally and start it:

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis-server
```

Then set `REDIS_URL` to `redis://localhost:6379`.

## Running All Tests

To run both unit and integration tests together:

```bash
npm test
```

## Test Coverage

The integration tests cover:

- ✅ **16 integration test cases** covering all major scenarios
- ✅ **3 unit test cases** for isolated logic testing
- ✅ **Concurrent request handling** (atomicity verification)
- ✅ **Time-based token refill** (including sub-second precision)
- ✅ **Edge cases** (special characters, zero state, rapid requests)

## Continuous Integration

For CI/CD pipelines, you can use a service container:

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      redis:
        image: redis:6.2-alpine
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 6379:6379
    
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm install
      - run: npm test
        env:
          REDIS_URL: redis://localhost:6379
```

### GitLab CI Example

```yaml
test:
  image: node:18
  services:
    - redis:6.2-alpine
  variables:
    REDIS_URL: redis://redis:6379
  script:
    - npm install
    - npm test
```

## Test Maintenance

When adding new features:

1. **Add unit tests** for logic changes (mocked Redis)
2. **Add integration tests** for behavior changes (real Redis)
3. Ensure tests clean up their Redis keys in `afterEach` hooks
4. Use descriptive test names that explain the expected behavior
5. Group related tests using `describe` blocks

## Troubleshooting

### Tests fail with "ECONNREFUSED"

Redis is not running or not accessible. Check:
- Is Redis running? (`docker ps` or `redis-cli ping`)
- Is the port correct? (default: 6379)
- Is `REDIS_URL` set correctly?

### Tests fail with "NOAUTH Authentication required"

Redis requires a password. Set the correct password in `REDIS_URL`:
```bash
export REDIS_URL=redis://:yourpassword@localhost:6379
```

### Tests timeout

Some integration tests wait for token refill (up to 5 seconds). This is expected behavior. If tests consistently timeout:
- Check Redis performance
- Verify network latency to Redis
- Ensure Redis is not under heavy load

### Jest doesn't exit after tests

This can happen if the Redis connection isn't properly closed. The tests include proper cleanup in `afterAll`, but if you interrupt tests, you may need to manually kill the process.
