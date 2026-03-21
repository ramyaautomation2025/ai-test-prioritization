import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * PostgreSQL connection pool
 * Reuses connections instead of creating new ones each time
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Neon.tech SSL
  },
  max: 5,                // max 5 connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

/**
 * Test the database connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log(`[${new Date().toISOString()}] ✅ Database connected successfully`);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Database connection failed:`, error);
    return false;
  }
}

/**
 * Run the schema SQL to create tables if they don't exist
 */
export async function initializeSchema(): Promise<void> {
  const fs = await import('fs');
  const path = await import('path');

  const schemaPath = path.join(process.cwd(), 'src', 'database', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  try {
    await pool.query(schemaSql);
    console.log(`[${new Date().toISOString()}] ✅ Database schema initialized`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Schema initialization failed:`, error);
    throw error;
  }
}

export default pool;