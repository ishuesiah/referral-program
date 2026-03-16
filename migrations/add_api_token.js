#!/usr/bin/env node
/********************************************************************
 * Migration: Add API Token Column
 *
 * This migration adds the api_token column to the users table for
 * API authentication.
 *
 * Usage: node migrations/add_api_token.js
 ********************************************************************/
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log('Starting API token migration...');
  console.log('Time:', new Date().toISOString());

  const client = await pool.connect();

  try {
    // Check if column already exists
    const checkResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'api_token'
    `);

    if (checkResult.rows.length > 0) {
      console.log('Column api_token already exists. Skipping migration.');
      return;
    }

    // Add the api_token column
    console.log('Adding api_token column to users table...');
    await client.query(`
      ALTER TABLE users
      ADD COLUMN api_token VARCHAR(64) UNIQUE
    `);

    // Create index for fast lookups
    console.log('Creating index on api_token...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_api_token ON users(api_token)
    `);

    console.log('Migration completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
