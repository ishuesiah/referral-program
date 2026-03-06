/********************************************************************
 * Migration: Add birthday column to users table
 * Run with: node migrations/add_birthday_column.js
 ********************************************************************/
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  try {
    console.log('Adding birthday column to users table...');

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS birthday DATE
    `);

    console.log('Migration completed successfully!');
    console.log('Birthday column added to users table.');
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();
