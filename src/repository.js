/********************************************************************
 * repository.js
 * Database access layer - all SQL queries in one place
 ********************************************************************/
const { Pool } = require('pg');
require('dotenv').config();

// Initialize PostgreSQL pool (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

/********************************************************************
 * Connection Management
 ********************************************************************/
async function testConnection() {
  const result = await pool.query('SELECT NOW()');
  return result.rows[0].now;
}

async function getTableList() {
  const result = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  return result.rows.map(t => t.table_name);
}

/********************************************************************
 * User Queries
 ********************************************************************/
async function findUserByEmail(email) {
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );
  return result.rows[0] || null;
}

async function findUserByReferralCode(referralCode) {
  const result = await pool.query(
    'SELECT * FROM users WHERE referral_code = $1',
    [referralCode]
  );
  return result.rows[0] || null;
}

async function findUserByDiscountCode(discountCode) {
  const result = await pool.query(
    'SELECT * FROM users WHERE last_discount_code = $1',
    [discountCode]
  );
  return result.rows[0] || null;
}

async function findUserByEmailAndDiscountCode(email, discountCode) {
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1 AND last_discount_code = $2',
    [email, discountCode]
  );
  return result.rows[0] || null;
}

async function createUser({ firstName, email, points, referralCode, referredBy }) {
  const result = await pool.query(
    `INSERT INTO users (first_name, email, points, referral_code, referred_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING user_id`,
    [firstName, email, points, referralCode, referredBy || null]
  );
  return result.rows[0];
}

async function updateUserPoints(email, newPoints) {
  await pool.query(
    'UPDATE users SET points = $1 WHERE email = $2',
    [newPoints, email]
  );
}

async function updateUserPointsById(userId, newPoints) {
  await pool.query(
    'UPDATE users SET points = $1 WHERE user_id = $2',
    [newPoints, userId]
  );
}

async function addPointsByReferralCode(referralCode, pointsToAdd) {
  await pool.query(
    'UPDATE users SET points = points + $1 WHERE referral_code = $2',
    [pointsToAdd, referralCode]
  );
}

async function updateUserDiscountCode(userId, discountCode, discountId, newPoints) {
  await pool.query(
    'UPDATE users SET last_discount_code = $1, discount_code_id = $2, points = $3 WHERE user_id = $4',
    [discountCode, discountId, newPoints, userId]
  );
}

async function clearUserDiscountCode(email) {
  await pool.query(
    'UPDATE users SET last_discount_code = NULL, discount_code_id = NULL WHERE email = $1',
    [email]
  );
}

async function clearUserDiscountCodeById(userId) {
  await pool.query(
    'UPDATE users SET last_discount_code = NULL, discount_code_id = NULL WHERE user_id = $1',
    [userId]
  );
}

async function incrementReferralCount(userId) {
  await pool.query(
    'UPDATE users SET referral_count = COALESCE(referral_count, 0) + 1 WHERE user_id = $1',
    [userId]
  );
}

async function updateMilestoneDiscountCodes(userId, redeemedMilestonesJson) {
  await pool.query(
    'UPDATE users SET referal_discount_code = $1 WHERE user_id = $2',
    [redeemedMilestonesJson, userId]
  );
}

async function updateUserTier(userId, tier, totalSpent) {
  await pool.query(
    'UPDATE users SET tier = $1, total_spent = $2 WHERE user_id = $3',
    [tier, totalSpent, userId]
  );
}

/********************************************************************
 * User Actions Queries
 ********************************************************************/
async function findActionByUserAndType(userId, actionType) {
  const result = await pool.query(
    'SELECT * FROM user_actions WHERE user_id = $1 AND action_type = $2',
    [userId, actionType]
  );
  return result.rows[0] || null;
}

async function findActionByUserAndRef(userId, actionRef) {
  const result = await pool.query(
    'SELECT * FROM user_actions WHERE user_id = $1 AND action_ref = $2',
    [userId, actionRef]
  );
  return result.rows[0] || null;
}

async function findPurchaseActions(userId) {
  const result = await pool.query(
    `SELECT * FROM user_actions
     WHERE user_id = $1
     AND action_type IN ('purchase', 'test_purchase', 'shopify_purchase')`,
    [userId]
  );
  return result.rows;
}

async function createAction({ userId, actionType, pointsAwarded, actionRef = null }) {
  await pool.query(
    'INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref) VALUES ($1, $2, $3, $4)',
    [userId, actionType, pointsAwarded, actionRef]
  );
}

/********************************************************************
 * Exports
 ********************************************************************/
module.exports = {
  // Connection
  pool,
  testConnection,
  getTableList,

  // Users
  findUserByEmail,
  findUserByReferralCode,
  findUserByDiscountCode,
  findUserByEmailAndDiscountCode,
  createUser,
  updateUserPoints,
  updateUserPointsById,
  addPointsByReferralCode,
  updateUserDiscountCode,
  clearUserDiscountCode,
  clearUserDiscountCodeById,
  incrementReferralCount,
  updateMilestoneDiscountCodes,
  updateUserTier,

  // Actions
  findActionByUserAndType,
  findActionByUserAndRef,
  findPurchaseActions,
  createAction
};
