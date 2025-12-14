#!/bin/bash

# Comprehensive cleanup script for SQLite and BullMQ
# This script:
# 1. Deletes all data from SQLite database (not just the file)
# 2. Clears all BullMQ jobs from all Redis instances (master, replica, and current master after failover)
# 3. Works with Docker containers running

set -e  # Exit on error

echo "🧹 Starting comprehensive data cleanup..."
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================================================
# STEP 1: Stop seeder-service to avoid database locks
# ============================================================================
echo "📦 Step 1: Stopping seeder-service to avoid database locks..."
if docker ps | grep -q seeder-service; then
    echo "   ⏹️  Stopping seeder-service..."
    docker-compose stop seeder-service
    sleep 2
    echo "   ✅ Seeder-service stopped"
else
    echo "   ℹ️  Seeder-service is not running, skipping..."
fi
echo ""

# ============================================================================
# STEP 2: Clean SQLite Database (delete all data, not just the file)
# ============================================================================
echo "🗄️  Step 2: Cleaning SQLite database..."

DB_PATH="./data/cars.db"

# Check if database file exists
if [ ! -f "$DB_PATH" ]; then
    echo "   ⚠️  Database file not found at $DB_PATH"
    echo "   ℹ️  Database will be created automatically when service starts"
else
    # Use sqlite3 to delete all data from the table
    # This preserves the schema but removes all rows
    if command -v sqlite3 &> /dev/null; then
        echo "   🗑️  Deleting all data from pending_cars table..."
        sqlite3 "$DB_PATH" "DELETE FROM pending_cars;" 2>/dev/null || {
            echo "   ⚠️  Could not delete data using sqlite3, deleting file instead..."
            rm -f "$DB_PATH"
        }
        echo "   ✅ SQLite data deleted"
    else
        echo "   ⚠️  sqlite3 command not found, deleting database file instead..."
        rm -f "$DB_PATH"
        echo "   ✅ Database file deleted (will be recreated with schema on next start)"
    fi
fi

echo "   ✅ SQLite cleanup complete"
echo ""

# ============================================================================
# STEP 3: Ensure Redis containers are running
# ============================================================================
echo "📦 Step 3: Ensuring Redis containers are running..."
if ! docker ps | grep -q redis-master; then
    echo "   ⚠️  Redis containers are not running. Starting them..."
    docker-compose up -d redis-master redis-replica redis-sentinel-1 redis-sentinel-2 redis-sentinel-3
    echo "   ⏳ Waiting for Redis to be ready..."
    sleep 5
    echo "   ✅ Redis containers started"
else
    echo "   ✅ Redis containers are running"
fi
echo ""

# ============================================================================
# STEP 4: Clean BullMQ from Redis Master
# ============================================================================
echo "🔴 Step 4: Cleaning BullMQ from Redis Master (port 6379)..."
if docker ps | grep -q redis-master; then
    # Get all BullMQ keys for car-seeder-queue
    BULLMQ_KEYS=$(docker exec redis-master redis-cli --scan --pattern "bull:car-seeder-queue:*" 2>/dev/null || echo "")
    
    if [ -n "$BULLMQ_KEYS" ]; then
        KEY_COUNT=$(echo "$BULLMQ_KEYS" | wc -l | tr -d ' ')
        echo "   🗑️  Found $KEY_COUNT BullMQ keys, deleting..."
        echo "$BULLMQ_KEYS" | while read -r key; do
            if [ -n "$key" ]; then
                docker exec redis-master redis-cli DEL "$key" >/dev/null 2>&1 || true
            fi
        done
        echo "   ✅ BullMQ keys deleted from master"
    else
        echo "   ℹ️  No BullMQ keys found on master"
    fi
    
    # Also flush all data to be thorough (optional, but ensures complete cleanup)
    echo "   🗑️  Flushing all Redis data from master..."
    docker exec redis-master redis-cli FLUSHALL >/dev/null 2>&1 || true
    echo "   ✅ Redis master flushed"
else
    echo "   ⚠️  Redis Master is not running, skipping..."
fi
echo ""

# ============================================================================
# STEP 5: Clean BullMQ from Redis Replica
# ============================================================================
echo "🔵 Step 5: Cleaning BullMQ from Redis Replica (port 6380)..."
if docker ps | grep -q redis-replica; then
    # Get all BullMQ keys for car-seeder-queue
    BULLMQ_KEYS=$(docker exec redis-replica redis-cli -p 6380 --scan --pattern "bull:car-seeder-queue:*" 2>/dev/null || echo "")
    
    if [ -n "$BULLMQ_KEYS" ]; then
        KEY_COUNT=$(echo "$BULLMQ_KEYS" | wc -l | tr -d ' ')
        echo "   🗑️  Found $KEY_COUNT BullMQ keys, deleting..."
        echo "$BULLMQ_KEYS" | while read -r key; do
            if [ -n "$key" ]; then
                docker exec redis-replica redis-cli -p 6380 DEL "$key" >/dev/null 2>&1 || true
            fi
        done
        echo "   ✅ BullMQ keys deleted from replica"
    else
        echo "   ℹ️  No BullMQ keys found on replica"
    fi
    
    # Also flush all data to be thorough
    echo "   🗑️  Flushing all Redis data from replica..."
    docker exec redis-replica redis-cli -p 6380 FLUSHALL >/dev/null 2>&1 || true
    echo "   ✅ Redis replica flushed"
else
    echo "   ⚠️  Redis Replica is not running, skipping..."
fi
echo ""

# ============================================================================
# STEP 6: Verify cleanup
# ============================================================================
echo "🔍 Step 6: Verifying cleanup..."
echo ""

# Check SQLite
if [ -f "$DB_PATH" ]; then
    if command -v sqlite3 &> /dev/null; then
        SQLITE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pending_cars;" 2>/dev/null || echo "0")
        echo "   SQLite pending_cars count: $SQLITE_COUNT"
    else
        echo "   SQLite: Database file exists (sqlite3 not available to verify)"
    fi
else
    echo "   SQLite: Database file does not exist ✅"
fi

# Check Redis Master
if docker ps | grep -q redis-master; then
    MASTER_KEYS=$(docker exec redis-master redis-cli DBSIZE 2>/dev/null || echo "0")
    MASTER_BULLMQ=$(docker exec redis-master redis-cli --scan --pattern "bull:car-seeder-queue:*" 2>/dev/null | wc -l | tr -d ' ')
    echo "   Redis Master: $MASTER_KEYS total keys, $MASTER_BULLMQ BullMQ keys"
fi

# Check Redis Replica
if docker ps | grep -q redis-replica; then
    REPLICA_KEYS=$(docker exec redis-replica redis-cli -p 6380 DBSIZE 2>/dev/null || echo "0")
    REPLICA_BULLMQ=$(docker exec redis-replica redis-cli -p 6380 --scan --pattern "bull:car-seeder-queue:*" 2>/dev/null | wc -l | tr -d ' ')
    echo "   Redis Replica: $REPLICA_KEYS total keys, $REPLICA_BULLMQ BullMQ keys"
fi

echo ""

# ============================================================================
# SUMMARY
# ============================================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Cleanup complete!"
echo ""
echo "📋 Summary:"
echo "   • SQLite: All data deleted from pending_cars table"
echo "   • BullMQ: All jobs cleared from Redis master and replica"
echo "   • Redis: All data flushed from both instances"
echo ""
echo "🚀 Next steps:"
echo "   1. Start seeder-service: docker-compose up -d seeder-service"
echo "   2. Or restart all services: docker-compose up -d"
echo ""
echo "💡 Note: Docker containers remain running. Only data was cleared."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

