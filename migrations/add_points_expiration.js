#!/usr/bin/env node
/********************************************************************
 * Migration: Add points expiration support
 *
 * Adds expires_at column to user_actions table for tracking
 * when each batch of points expires (6 months after earning)
 *
 * Usage: node migrations/add_points_expiration.js
 ********************************************************************/
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  console.log('Starting points expiration migration...');

  try {
    // Add expires_at column to user_actions
    console.log('Adding expires_at column to user_actions...');
    await pool.query(`
      ALTER TABLE user_actions
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP
    `);
    console.log('  Done.');

    // Add index for efficient expiration queries
    console.log('Adding index on expires_at...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_actions_expires_at
      ON user_actions(expires_at)
      WHERE expires_at IS NOT NULL
    `);
    console.log('  Done.');

    // Add is_expired column to mark expired actions (instead of deleting)
    console.log('Adding is_expired column...');
    await pool.query(`
      ALTER TABLE user_actions
      ADD COLUMN IF NOT EXISTS is_expired BOOLEAN DEFAULT FALSE
    `);
    console.log('  Done.');

    console.log('\nMigration complete!');
  } catch (err) {
    console.error('Migration failed:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
