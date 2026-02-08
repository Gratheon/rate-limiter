# gratheon/rate-limiter

A high-performance, distributed rate limiting library for TypeScript/Node.js applications, utilizing the **Token Bucket** algorithm and Redis Lua scripts for atomic operations.

This library is designed to be integrated into various services within the `gratheon` ecosystem (e.g., `graphql-router`, `telemetry-api`, etc.) to control traffic flow and prevent abuse.

## Algorithm: Token Bucket

- **Allows Bursts:** Tokens accumulate during low-traffic periods, enabling high burst capacity when needed.
- **Atomic Operation:** Uses Redis Lua scripts to ensure read, calculation, and write-back occur in a single atomic step, which is essential for accuracy in horizontally scaled (distributed) applications.

## Architecture & Flow

### Sequence Diagram

The following diagram shows how the rate limiter integrates into a typical API service flow:

```mermaid
sequenceDiagram
    participant Client
    participant API as API Service<br/>(Express/Fastify)
    participant RL as TokenBucketRateLimiter
    participant Redis

    Note over Client,Redis: First Request (Script Loading)
    Client->>API: HTTP Request<br/>POST /api/data<br/>Header: user-id: 123
    API->>RL: consume("user:123")
    RL->>Redis: SCRIPT LOAD<br/>(Lua token bucket script)
    Redis-->>RL: sha1 hash
    RL->>Redis: EVALSHA sha1<br/>key: "rate:user:123"<br/>capacity: 10<br/>refillRate: 0.166<br/>timestamp: 1678886400
    Redis->>Redis: Atomically check &<br/>decrement token
    Redis-->>RL: [1, 9]<br/>(allowed, remaining)
    RL-->>API: true
    API->>API: Process business logic
    API-->>Client: 200 OK<br/>X-RateLimit-Remaining: 9

    Note over Client,Redis: Subsequent Requests
    Client->>API: HTTP Request #2<br/>same user
    API->>RL: consume("user:123")
    RL->>Redis: EVALSHA sha1<br/>(script already cached)
    Redis-->>RL: [1, 8]
    RL-->>API: true
    API-->>Client: 200 OK

    Note over Client,Redis: Rate Limit Exceeded
    loop 8 more requests
        Client->>API: Requests #3-10
        API->>RL: consume()
        RL->>Redis: EVALSHA
        Redis-->>RL: [1, remaining]
        RL-->>API: true
    end
    Client->>API: Request #11<br/>(bucket empty)
    API->>RL: consume("user:123")
    RL->>Redis: EVALSHA sha1
    Redis-->>RL: [0, 0]<br/>(denied, 0 remaining)
    RL-->>API: false
    API-->>Client: 429 Too Many Requests<br/>Retry-After: 6
```

### Token Bucket State Flow

```mermaid
stateDiagram-v2
    [*] --> CheckToken: consume(userId)
    
    CheckToken --> LoadScript: First call?
    LoadScript --> ExecuteScript: Cache SHA
    CheckToken --> ExecuteScript: Script cached
    
    ExecuteScript --> Allowed: tokens > 0
    ExecuteScript --> Denied: tokens = 0
    
    Allowed --> [*]: return true
    Denied --> [*]: return false
    
    note right of LoadScript
        Lua script loaded once
        per Redis connection
    end note
    
    note right of ExecuteScript
        Atomic operation:
        1. Get current tokens
        2. Calculate refills
        3. Check availability
        4. Decrement if allowed
    end note
```

## Installation

```bash
npm install @gratheon/rate-limiter redis
```

*(Note: The actual package name may need to be scoped to `@gratheon/rate-limiter` upon publishing.)*

## Running Tests

First, install development dependencies:

```bash
npm install
```

Then, run the tests using Jest:

```bash
npm test
```

## Usage

### Initialization

First, you need a connected Redis client.

```typescript
import { createClient } from 'redis';
import { TokenBucketRateLimiter } from './src/TokenBucketRateLimiter'; // or '@gratheon/rate-limiter'

const redisClient = createClient({
  url: 'redis://localhost:6379'
});

await redisClient.connect();

const rateLimiter = new TokenBucketRateLimiter({
  redisClient: redisClient,
  // 5 requests per minute, with a burst capacity of 10
  capacity: 10,
  refillRate: 10 / 60, // 0.166 tokens per second (10 tokens / 60 seconds)
  prefix: 'api:user' // Prefix for Redis keys (e.g., api:user:123)
});
```

### Consuming a Token

Use the `consume` method inside your middleware or route handler.

```typescript
async function handleRequest(userId: string): Promise<Response> {
  const allowed = await rateLimiter.consume(userId);

  if (!allowed) {
    return new Response('Rate Limit Exceeded', { 
      status: 429,
      headers: { 'Retry-After': '5' } // Inform client when to retry (in seconds)
    });
  }

  // Proceed with request logic
  // ...
  return new Response('OK');
}
```