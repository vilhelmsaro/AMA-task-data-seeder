# AMA Task -- Data Seeder (NestJS)

This NestJS project generates \~2000 car entities per minute.\
Interviewees must **fork this repository** and complete the required
implementation.

------------------------------------------------------------------------

## 🚀 Getting Started

### Strongly recommended to start up using docker compose:)


------------------------------------------------------------------------

## 🐳 Docker Compose Infrastructure

When running `docker-compose up`, the following infrastructure is created:

### Services (Containers)

The Docker Compose setup includes **6 services**:

1. **redis-master** - Redis master instance (port 6379)
   - Handles all write operations
   - Configured with AOF (Append Only File) persistence
   - Health checks enabled

2. **redis-replica** - Redis replica instance (port 6380)
   - Replicates data from master
   - Configured with AOF persistence
   - Health checks enabled

3. **redis-sentinel-1** - First Redis Sentinel instance (port 26379)
   - Monitors Redis master/replica health
   - Handles automatic failover detection

4. **redis-sentinel-2** - Second Redis Sentinel instance (port 26380)
   - Part of Sentinel quorum (requires 2/3 for decisions)

5. **redis-sentinel-3** - Third Redis Sentinel instance (port 26381)
   - Part of Sentinel quorum for high availability

6. **seeder-service** - Main NestJS application (port 3000)
   - Generates car entities continuously
   - Connects to Redis via Sentinel
   - Falls back to SQLite when Redis is unavailable

### Networks

- **seeder-network** (bridge driver)
  - All services communicate through this isolated network
  - Services can reach each other by container name (e.g., `redis-master`, `seeder-service`)

### Volumes (Bind Mounts)

The setup uses **bind mounts** (not named volumes) for direct host access:

1. **Data Volume**: `${DATA_VOLUME_PATH:-./data}` → `/app/data` (inside container)
   - Contains SQLite database file (`cars.db`)
   - Accessible from host for database tools (DataGrip, etc.)
   - Persists data across container restarts

2. **Logs Volume**: `${LOGS_VOLUME_PATH:-./logs}` → `/app/logs` (inside container)
   - Contains application logs and metrics files
   - Metrics files: `failover-metrics-YYYY-MM-DD.log`
   - Accessible from host for log analysis

### Ports Exposed

| Service | Host Port | Container Port | Purpose |
|---------|-----------|----------------|---------|
| redis-master | 6379 | 6379 | Redis master access |
| redis-replica | 6380 | 6380 | Redis replica access |
| redis-sentinel-1 | 26379 | 26379 | Sentinel monitoring |
| redis-sentinel-2 | 26380 | 26379 | Sentinel monitoring |
| redis-sentinel-3 | 26381 | 26379 | Sentinel monitoring |
| seeder-service | 3000 | 3000 | Application API |

### Files Created on Host

When running Docker Compose, the following files/directories are created or used:

- **`./data/cars.db`** - SQLite database file (created automatically if missing)
- **`./logs/`** - Directory for application logs and metrics
  - `failover-metrics-YYYY-MM-DD.log` - Daily metrics logs

### What to Expect

When you run `docker-compose up`:

1. **Startup Order**:
   - Redis master and replica start first (with health checks)
   - Sentinels wait for Redis to be healthy before starting
   - Seeder service waits for Redis to be healthy before starting

2. **Container Names**:
   - All containers have explicit names (e.g., `redis-master`, `seeder-service`)
   - Easy to reference in scripts and commands

3. **Restart Policy**:
   - All services use `restart: unless-stopped`
   - Containers automatically restart on failure or system reboot

4. **Health Checks**:
   - Redis instances have health checks
   - Other services depend on Redis being healthy before starting

5. **Data Persistence**:
   - SQLite database persists in `./data/` directory
   - Redis data persists via AOF files (inside containers)
   - Logs persist in `./logs/` directory

### Environment Variables

All services can be configured via environment variables (with defaults):
- Redis ports, Sentinel ports, quorum settings
- Application ports, circuit breaker thresholds
- Recovery settings, data/log paths

See `docker-compose.yml` for all available configuration options.

------------------------------------------------------------------------

## 🧩 Task solution approach

My approach is basically writing all the generated car entities into a bull mq service, and from the other service, consume it. In this project, there is also implemented a failover mechanism, it is basically a simple sqlite db that will handle all the generated cars, if the redis/bullmq is down for some time. There is also a sentinel service, that will monitor and look for failures in bullmq/redis, and as of now, there are three instances of the sentinel services. There is also one master and one slave of redis services always in sync, and when a failure is detected by at least two sentinel services for the current master, the sentinel will make the current slave a new master, and the seeder application is automatically detecting the changes via "+switch-master" event from sentinels, and will connect to the newly elected master. 

The application has two states, sqlite and redis, straight forward I think, right? Whenever the redis is not accepting any writes, the cars are going into sqlite with max 50-60 batch writes.

Also, there is a circuit breaker technique used with open, closed, and half-open states. It is used in order to not make bold decisions while the redis is down, and test a write first and then switch the overall application's state back to the redis. The half-open is used for test writes, close means that the redis is up and we are happy, and the open stands for we have got ourselves into trouble. There are also a few seconds cooldown after which the service will set the circuit breaker state to half-open in order to test if the redis is up yet or not.

I believe that is basically it. The more detailed paragraphs are down below, enjoy.

------------------------------------------------------------------------

## 🔄 Circuit Breaker Behavior

The system implements a circuit breaker pattern to handle Redis connection failures gracefully. The circuit breaker has three states:

### States

- **CLOSED**: Normal operation. Requests flow to Redis. Failures are counted.
- **OPEN**: Circuit is open. All requests are rejected and fallback to SQLite. No requests reach Redis.
- **HALF_OPEN**: Testing state. One request is allowed through to test if Redis has recovered.

### State Transitions

1. **CLOSED → OPEN**: 
   - Triggered by `recordFailure()` when failure count reaches threshold (default: 5 failures)
   - All subsequent requests fallback to SQLite

2. **OPEN → HALF_OPEN**:
   - **Automatic**: After cooldown period expires (default: 2000ms)
   - **Manual**: When Sentinel detects failover (`+switch-master` event) via `forceReconnection()`
   - **Manual**: When ioredis automatically reconnects and health check passes

3. **HALF_OPEN → CLOSED**:
   - Triggered by `recordSuccess()` when test request succeeds
   - System returns to normal Redis operation

4. **HALF_OPEN → OPEN**:
   - Triggered by `recordFailure()` if test request fails
   - Cooldown timer restarts automatically

### Key Behaviors

- **Cooldown Timer**: Automatically transitions OPEN → HALF_OPEN after a fixed delay, preventing immediate retries
- **Sentinel Integration**: Detects Redis master failover events and immediately attempts reconnection
- **Graceful Degradation**: When circuit is OPEN, all data is persisted to SQLite and recovered when Redis becomes available

------------------------------------------------------------------------

## 🔀 Application State Management

The system operates in two modes that determine where new data is written:

### Application States

- **REDIS_MODE**: Default mode. All writes go directly to Redis/BullMQ queue
- **SQLITE_MODE**: Fallback mode. All writes go to SQLite database for later recovery

### State Transitions

The application state is managed by `StateManagerService.setState()` and changes based on circuit breaker behavior:

#### REDIS_MODE → SQLITE_MODE

Triggered when:
- Circuit breaker opens (CLOSED → OPEN) due to failure threshold
- Redis write fails and circuit breaker transitions to OPEN
- All subsequent writes automatically go to SQLite

#### SQLITE_MODE → REDIS_MODE

Triggered when:
- Circuit breaker is in HALF_OPEN state (testing recovery)
- A test write to Redis succeeds
- Circuit breaker closes (HALF_OPEN → CLOSED) and `setState(REDIS_MODE)` is called
- System returns to normal Redis operation

### Relationship with Circuit Breaker

- **Circuit OPEN** → Application switches to **SQLITE_MODE** (writes blocked from Redis)
- **Circuit HALF_OPEN** → Test write attempted (even if in SQLITE_MODE)
- **Circuit CLOSED** → Application in **REDIS_MODE** (normal operation)

### Recovery Process

- Recovery manager continuously processes SQLite entries regardless of current state
- When Redis becomes available, circuit breaker transitions to HALF_OPEN
- Next write tests Redis connection
- If successful, state switches back to REDIS_MODE and recovery continues

------------------------------------------------------------------------

## 🧹 Data Cleanup

### Quick Cleanup Script

Use the `clean-all-data.sh` script to delete all data from SQLite and all BullMQ jobs from Redis:

```bash
./clean-all-data.sh
```

This script will:
- ✅ Delete all data from SQLite `pending_cars` table (preserves schema)
- ✅ Clear all BullMQ jobs from Redis master and replica
- ✅ Flush all Redis data from both instances
- ✅ Work with Docker containers running (temporarily stops seeder-service to avoid DB locks)

### Docker Containers During Cleanup

**Should Docker keep running?** **Yes, keep Docker running!**

The cleanup script is designed to work with Docker containers running:

1. **Redis containers must be running** - The script needs Redis containers to be up to flush data and clear BullMQ jobs. If they're not running, the script will start them automatically.

2. **Seeder-service is temporarily stopped** - The script automatically stops the `seeder-service` container before cleaning SQLite to avoid database locks. This is safe and the service can be restarted after cleanup.

3. **No need to stop Docker** - You don't need to stop Docker or `docker-compose down`. The script handles everything safely while containers are running.

### What Gets Cleaned

- **SQLite**: All rows from `pending_cars` table (schema preserved)
- **BullMQ**: All jobs from `car-seeder-queue` (waiting, active, completed, failed)
- **Redis**: All data flushed from master (port 6379) and replica (port 6380)

### After Cleanup

After running the cleanup script:
1. Restart seeder-service: `docker-compose up -d seeder-service`
2. Or restart all services: `docker-compose up -d`
3. The database schema will be automatically recreated if needed
