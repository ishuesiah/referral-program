/**
 * Migration script to add active_rewards column to users table
 * Run with: node add_active_rewards_column.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  try {
    console.log('Connecting to database...');

    // Check if column already exists
    const checkResult = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'active_rewards'
    `);

    if (checkResult.rows.length > 0) {
      console.log('Column "active_rewards" already exists. No migration needed.');
      return;
    }

    // Add the column
    console.log('Adding "active_rewards" column to users table...');
    await pool.query(`
      ALTER TABLE users ADD COLUMN active_rewards TEXT
    `);

    console.log('Migration successful! Column "active_rewards" has been added.');

  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
