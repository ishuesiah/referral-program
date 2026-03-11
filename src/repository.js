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
 * Birthday Functions
 ********************************************************************/
async function updateUserBirthday(userId, birthday) {
  await pool.query(
    'UPDATE users SET birthday = $1 WHERE user_id = $2',
    [birthday, userId]
  );
}

async function getUsersWithBirthdayToday() {
  // Find users whose birthday month and day match today
  const result = await pool.query(`
    SELECT * FROM users
    WHERE birthday IS NOT NULL
    AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
    AND EXTRACT(DAY FROM birthday) = EXTRACT(DAY FROM CURRENT_DATE)
  `);
  return result.rows;
}

async function hasBirthdayPointsThisYear(userId) {
  const result = await pool.query(`
    SELECT * FROM user_actions
    WHERE user_id = $1
    AND action_type = 'birthday_bonus'
    AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)
  `, [userId]);
  return result.rows.length > 0;
}

/********************************************************************
 * Active Rewards (Multiple Discount Codes Support)
 ********************************************************************/
async function getActiveRewards(userId) {
  const result = await pool.query(
    'SELECT active_rewards FROM users WHERE user_id = $1',
    [userId]
  );
  const row = result.rows[0];
  if (!row || !row.active_rewards) return [];
  try {
    return JSON.parse(row.active_rewards);
  } catch (e) {
    return [];
  }
}

async function addActiveReward(userId, reward) {
  // reward: { code, discountId, points, redeemedAt }
  const current = await getActiveRewards(userId);
  current.push(reward);
  await pool.query(
    'UPDATE users SET active_rewards = $1 WHERE user_id = $2',
    [JSON.stringify(current), userId]
  );
}

async function removeActiveReward(userId, discountCode) {
  const current = await getActiveRewards(userId);
  const reward = current.find(r => r.code === discountCode);
  const updated = current.filter(r => r.code !== discountCode);
  await pool.query(
    'UPDATE users SET active_rewards = $1 WHERE user_id = $2',
    [JSON.stringify(updated), userId]
  );
  return reward; // Return the removed reward for getting discountId
}

async function findActiveRewardByCode(userId, discountCode) {
  const current = await getActiveRewards(userId);
  return current.find(r => r.code === discountCode) || null;
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

async function createAction({ userId, actionType, pointsAwarded, actionRef = null, expiresAt = null }) {
  // If no expiresAt provided and points are positive, default to 6 months from now
  let expiration = expiresAt;
  if (!expiration && pointsAwarded > 0) {
    const sixMonthsFromNow = new Date();
    sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
    expiration = sixMonthsFromNow.toISOString();
  }

  await pool.query(
    'INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [userId, actionType, pointsAwarded, actionRef, expiration]
  );
}

/********************************************************************
 * Points Expiration Functions
 ********************************************************************/

// Calculate total non-expired points for a user
async function calculateActivePoints(userId) {
  const result = await pool.query(`
    SELECT COALESCE(SUM(points_awarded), 0) as active_points
    FROM user_actions
    WHERE user_id = $1
    AND (is_expired = FALSE OR is_expired IS NULL)
    AND (expires_at IS NULL OR expires_at > NOW())
  `, [userId]);
  return parseInt(result.rows[0].active_points) || 0;
}

// Get actions that have expired but not yet processed
async function getExpiredActions() {
  const result = await pool.query(`
    SELECT ua.*, u.email, u.first_name
    FROM user_actions ua
    JOIN users u ON ua.user_id = u.user_id
    WHERE ua.expires_at IS NOT NULL
    AND ua.expires_at <= NOW()
    AND (ua.is_expired = FALSE OR ua.is_expired IS NULL)
    AND ua.points_awarded > 0
  `);
  return result.rows;
}

// Mark actions as expired
async function markActionsAsExpired(actionIds) {
  if (!actionIds.length) return;
  await pool.query(`
    UPDATE user_actions
    SET is_expired = TRUE
    WHERE action_id = ANY($1)
  `, [actionIds]);
}

// Get summary of expiring points for a user (for notifications)
async function getExpiringPointsSummary(userId, daysAhead = 30) {
  const result = await pool.query(`
    SELECT
      COALESCE(SUM(points_awarded), 0) as expiring_points,
      MIN(expires_at) as earliest_expiration
    FROM user_actions
    WHERE user_id = $1
    AND expires_at IS NOT NULL
    AND expires_at <= NOW() + INTERVAL '${daysAhead} days'
    AND expires_at > NOW()
    AND (is_expired = FALSE OR is_expired IS NULL)
    AND points_awarded > 0
  `, [userId]);
  return {
    expiringPoints: parseInt(result.rows[0].expiring_points) || 0,
    earliestExpiration: result.rows[0].earliest_expiration
  };
}

// Set expiration date for all existing actions (for launch)
async function setExpirationForExistingActions(expirationDate) {
  const result = await pool.query(`
    UPDATE user_actions
    SET expires_at = $1
    WHERE expires_at IS NULL
    AND points_awarded > 0
  `, [expirationDate]);
  return result.rowCount;
}

// Recalculate and sync user's points based on non-expired actions
async function syncUserPointsFromActions(userId) {
  const activePoints = await calculateActivePoints(userId);
  await pool.query(
    'UPDATE users SET points = $1 WHERE user_id = $2',
    [activePoints, userId]
  );
  return activePoints;
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
  createAction,

  // Active Rewards (Multiple Discount Codes)
  getActiveRewards,
  addActiveReward,
  removeActiveReward,
  findActiveRewardByCode,

  // Birthday
  updateUserBirthday,
  getUsersWithBirthdayToday,
  hasBirthdayPointsThisYear,

  // Points Expiration
  calculateActivePoints,
  getExpiredActions,
  markActionsAsExpired,
  getExpiringPointsSummary,
  setExpirationForExistingActions,
  syncUserPointsFromActions
};
