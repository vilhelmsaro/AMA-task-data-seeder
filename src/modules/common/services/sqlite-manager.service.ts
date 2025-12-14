import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { Car } from '../../car-seeder/car-seeder.interface';
import { RecoveryStatus } from '../enums/recovery-status.enum';
import * as fs from 'fs';
import * as path from 'path';

interface PendingCar {
  id: string;
  normalized_make: string;
  normalized_model: string;
  year: number;
  price: number;
  location: string;
  created_at: number;
  status: RecoveryStatus;
  retry_count: number;
  recovery_instance: string | null;
  recovery_started_at: number | null;
  redis_job_id: string | null;
}

@Injectable()
export class SqliteManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(SqliteManagerService.name);
  private db: sqlite3.Database | null = null;
  private writeBuffer: Car[] = [];
  private readonly batchSize: number = 50;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs = 1000; // Flush every 1 second if buffer not full
  private isShuttingDown = false;
  // Instance ID for multi-instance support and unique ID generation
  private readonly instanceId: string;

  constructor() {
    // Generate unique instance ID: process.pid-timestamp
    // This ensures uniqueness across multiple instances running simultaneously
    this.instanceId = `instance-${process.pid}-${Date.now()}`;
  }

  /**
   * Promisified version of db.run() that returns an object with the changes property.
   * The standard promisify doesn't work because sqlite3.run() callback doesn't receive
   * a result object - the changes are available via this.changes in the callback context.
   */
  private promisifyRun(): (
    sql: string,
    ...params: any[]
  ) => Promise<{ changes: number; lastID: number }> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return (
      sql: string,
      ...params: any[]
    ): Promise<{ changes: number; lastID: number }> => {
      return new Promise((resolve, reject) => {
        this.db!.run(sql, ...params, function (err: Error | null) {
          if (err) {
            reject(err);
          } else {
            // 'this' refers to the Statement object which has 'changes' and 'lastID'
            resolve({
              changes: this.changes,
              lastID: this.lastID,
            });
          }
        });
      });
    };
  }

  async initialize(): Promise<void> {
    const dbPath = process.env.SQLITE_DB_PATH || './data/cars.db';

    // Ensure directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      this.logger.log(`Created directory: ${dbDir}`);
    }

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          this.logger.error(`Failed to open SQLite database: ${err.message}`);
          reject(err);
          return;
        }
        this.logger.log(`SQLite database opened: ${dbPath}`);
        this.setupDatabase()
          .then(() => resolve())
          .catch(reject);
      });
    });
  }

  private async setupDatabase(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const run = this.promisifyRun();

    // Configure SQLite for optimal performance
    // FULL synchronous: Syncs to disk after every write operation for maximum safety
    await run('PRAGMA synchronous = FULL');
    // Cache size: 40MB (10000 pages × 4KB) for faster reads
    await run('PRAGMA cache_size = 10000');

    // Create table
    await run(`
      CREATE TABLE IF NOT EXISTS pending_cars (
        id TEXT PRIMARY KEY,
        normalized_make TEXT NOT NULL,
        normalized_model TEXT NOT NULL,
        year INTEGER NOT NULL,
        price REAL NOT NULL,
        location TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        recovery_instance TEXT,
        recovery_started_at INTEGER,
        redis_job_id TEXT
      )
    `);

    // Create indexes
    await run(`
      CREATE INDEX IF NOT EXISTS idx_status_created 
      ON pending_cars(status, created_at)
    `);

    await run(`
      CREATE INDEX IF NOT EXISTS idx_recovery_instance 
      ON pending_cars(recovery_instance)
    `);

    this.logger.log('SQLite database schema initialized');
  }

  async saveCar(car: Car, retryCount = 0): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Service is shutting down, skipping car save');
      return;
    }

    this.writeBuffer.push(car);

    // Flush if buffer is full
    if (this.writeBuffer.length >= this.batchSize) {
      await this.flushBuffer();
    } else {
      // Schedule flush if not already scheduled
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushBuffer().catch((err) => {
            this.logger.error(`Error flushing buffer: ${err.message}`);
          });
        }, this.flushIntervalMs);
      }
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const carsToWrite = [...this.writeBuffer];
    this.writeBuffer = [];

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const run = this.promisifyRun();
    const exec = promisify(this.db.exec.bind(this.db));

    try {
      // Use transaction for better performance and atomicity
      await run('BEGIN TRANSACTION');

      const stmt = this.db.prepare(`
        INSERT INTO pending_cars (
          id, normalized_make, normalized_model, year, price, location,
          created_at, status, retry_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const runStmt = promisify(stmt.run.bind(stmt));
      const finalize = promisify(stmt.finalize.bind(stmt));

      const baseTime = Date.now();
      for (let i = 0; i < carsToWrite.length; i++) {
        const car = carsToWrite[i];
        // Generate unique ID with instance ID, timestamp, index, and random component
        // Instance ID ensures uniqueness across multiple instances
        const id = `${this.instanceId}-${baseTime}-${i}-${Math.random().toString(36).substr(2, 9)}`;
        const createdAt = baseTime + i; // Slightly offset to maintain order

        await runStmt(
          id,
          car.normalizedMake,
          car.normalizedModel,
          car.year,
          car.price,
          car.location,
          createdAt,
          RecoveryStatus.PENDING,
          0,
        );
      }

      await finalize();
      await run('COMMIT');

      this.logger.debug(`Flushed ${carsToWrite.length} cars to SQLite`);
    } catch (error: any) {
      // Rollback on error
      try {
        await run('ROLLBACK');
      } catch (rollbackError: any) {
        this.logger.error(`Rollback failed: ${rollbackError.message}`);
      }

      this.logger.error(`Failed to write cars to SQLite: ${error.message}`);
      // Put cars back in buffer for retry
      this.writeBuffer.unshift(...carsToWrite);
      throw error;
    }
  }

  /**
   * Atomically reads and marks pending cars as recovering.
   * This method uses BEGIN IMMEDIATE TRANSACTION to prevent race conditions
   * when multiple instances try to recover the same entries.
   *
   * Uses a single SQL statement with CTE and RETURNING clause to:
   * 1. Select pending cars to claim (via CTE)
   * 2. Update them to RECOVERING status
   * 3. Return the full row data in one atomic operation
   *
   * @param limit Maximum number of cars to claim
   * @param instanceId Unique identifier for this recovery instance
   * @returns Array of cars that were successfully marked as recovering
   */
  async getAndMarkPendingCars(
    limit: number,
    instanceId: string,
  ): Promise<PendingCar[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const run = this.promisifyRun();
    const all = promisify(this.db.all.bind(this.db));

    try {
      // BEGIN IMMEDIATE acquires a RESERVED lock immediately
      // This blocks other writers (other recovery instances) from starting
      // their transactions until this one commits
      await run('BEGIN IMMEDIATE TRANSACTION');

      // Single atomic operation: Select, Update, and Return in one statement
      // The CTE selects pending cars, the UPDATE marks them as recovering,
      // and RETURNING gives us the full row data for successfully updated rows
      const claimedCars = (await all(
        `
        WITH selected_cars AS (
          SELECT id FROM pending_cars
          WHERE status = ?
          ORDER BY created_at ASC
          LIMIT ?
        )
        UPDATE pending_cars
        SET status = ?, recovery_instance = ?, recovery_started_at = ?
        WHERE id IN (SELECT id FROM selected_cars) AND status = ?
        RETURNING *
      `,
        [
          RecoveryStatus.PENDING,
          limit,
          RecoveryStatus.RECOVERING,
          instanceId,
          Date.now(),
          RecoveryStatus.PENDING,
        ],
      )) as PendingCar[];

      // Commit the transaction
      // This releases the lock and makes changes visible to other connections
      await run('COMMIT');

      this.logger.debug(
        `Atomically claimed ${claimedCars.length} cars for instance ${instanceId}`,
      );

      return claimedCars;
    } catch (error: any) {
      // Rollback on any error to release the lock
      try {
        await run('ROLLBACK');
      } catch (rollbackError: any) {
        this.logger.error(`Rollback failed: ${rollbackError.message}`);
      }
      this.logger.error(
        `Failed to atomically get and mark pending cars: ${error.message}`,
      );
      throw error;
    }
  }

  async markCarsAsRecovering(
    carIds: string[],
    instanceId: string,
  ): Promise<number> {
    if (!this.db || carIds.length === 0) {
      return 0;
    }

    const run = this.promisifyRun();
    const placeholders = carIds.map(() => '?').join(',');

    const result = await run(
      `
      UPDATE pending_cars
      SET status = ?, recovery_instance = ?, recovery_started_at = ?
      WHERE id IN (${placeholders}) AND status = ?
    `,
      [
        RecoveryStatus.RECOVERING,
        instanceId,
        Date.now(),
        ...carIds,
        RecoveryStatus.PENDING,
      ],
    );

    return result.changes || 0;
  }

  async getCarsByInstance(instanceId: string): Promise<PendingCar[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const all = promisify(this.db.all.bind(this.db));

    const cars = (await all(
      `
      SELECT * FROM pending_cars
      WHERE recovery_instance = ? AND status = ?
      ORDER BY created_at ASC
    `,
      [instanceId, RecoveryStatus.RECOVERING],
    )) as PendingCar[];

    return cars;
  }

  async markCarsAsSent(carIds: string[], redisJobIds: string[]): Promise<void> {
    if (!this.db || carIds.length === 0) {
      return;
    }

    const run = this.promisifyRun();

    for (let i = 0; i < carIds.length; i++) {
      await run(
        `
        UPDATE pending_cars
        SET status = ?, redis_job_id = ?
        WHERE id = ?
      `,
        [RecoveryStatus.SENT, redisJobIds[i] || null, carIds[i]],
      );
    }
  }

  async markCarsAsPending(carIds: string[]): Promise<void> {
    if (!this.db || carIds.length === 0) {
      return;
    }

    const run = this.promisifyRun();

    for (const carId of carIds) {
      await run(
        `
        UPDATE pending_cars
        SET status = ?, retry_count = retry_count + 1
        WHERE id = ?
      `,
        [RecoveryStatus.PENDING, carId],
      );
    }
  }

  async getPendingCount(): Promise<number> {
    if (!this.db) {
      return 0;
    }

    const get = promisify(this.db.get.bind(this.db));

    const result = (await get(
      `
      SELECT COUNT(*) as count FROM pending_cars WHERE status = ?
    `,
      [RecoveryStatus.PENDING],
    )) as { count: number };

    return result?.count || 0;
  }

  async cleanupStaleRecoveries(
    maxAgeMs: number = 5 * 60 * 1000,
  ): Promise<number> {
    if (!this.db) {
      return 0;
    }

    const run = this.promisifyRun();
    const cutoffTime = Date.now() - maxAgeMs;

    const result = await run(
      `
      UPDATE pending_cars
      SET status = ?, recovery_instance = NULL, recovery_started_at = NULL
      WHERE status = ? AND recovery_started_at < ?
    `,
      [RecoveryStatus.PENDING, RecoveryStatus.RECOVERING, cutoffTime],
    );

    return result.changes || 0;
  }

  async flushPendingWrites(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.writeBuffer.length > 0) {
      await this.flushBuffer();
    }
  }

  async close(): Promise<void> {
    this.isShuttingDown = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush any pending writes
    await this.flushPendingWrites();

    if (this.db) {
      return new Promise((resolve, reject) => {
        this.db!.close((err) => {
          if (err) {
            this.logger.error(`Error closing SQLite: ${err.message}`);
            reject(err);
          } else {
            this.logger.log('SQLite database closed');
            resolve();
          }
        });
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
