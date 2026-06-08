/********************************************************************
 * fix_all_duplicates.js
 *
 * This script:
 * 1. Finds all duplicate accounts (same email, different case)
 * 2. Merges them automatically (keeping the one with more points/data)
 * 3. Adds a case-insensitive unique index to prevent future duplicates
 *
 * Usage: node fix_all_duplicates.js
 ********************************************************************/
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function mergeAccounts(client, sourceId, targetId) {
  // Get both users
  const sourceResult = await client.query('SELECT * FROM users WHERE user_id = $1', [sourceId]);
  const targetResult = await client.query('SELECT * FROM users WHERE user_id = $1', [targetId]);

  const source = sourceResult.rows[0];
  const target = targetResult.rows[0];

  if (!source || !target) {
    console.log(`  Skipping: one of the accounts no longer exists`);
    return false;
  }

  // Calculate merged values
  const mergedPoints = (source.points || 0) + (target.points || 0);
  const mergedTotalSpent = Math.max(
    parseFloat(source.total_spent) || 0,
    parseFloat(target.total_spent) || 0
  );
  const mergedReferralCount = (source.referral_count || 0) + (target.referral_count || 0);

  // Use the better name
  const mergedFirstName = (target.first_name && target.first_name.length > 0)
    ? target.first_name
    : (source.first_name || target.first_name);
  const mergedLastName = target.last_name || source.last_name;

  // Use birthday if either has one
  const mergedBirthday = target.birthday || source.birthday;

  // Determine best tier
  const tierOrder = { 'VIP': 4, 'Gold': 3, 'Silver': 2, 'Bronze': 1 };
  const sourceTierRank = tierOrder[source.tier] || 0;
  const targetTierRank = tierOrder[target.tier] || 0;
  const mergedTier = sourceTierRank > targetTierRank ? source.tier : (target.tier || source.tier);

  // Merge active_rewards arrays
  let sourceRewards = [];
  let targetRewards = [];
  try { sourceRewards = source.active_rewards ? JSON.parse(source.active_rewards) : []; } catch (e) {}
  try { targetRewards = target.active_rewards ? JSON.parse(target.active_rewards) : []; } catch (e) {}
  const mergedRewards = [...targetRewards, ...sourceRewards];

  // Merge milestone codes
  let sourceMilestones = {};
  let targetMilestones = {};
  try { sourceMilestones = source.referal_discount_code ? JSON.parse(source.referal_discount_code) : {}; } catch (e) {}
  try { targetMilestones = target.referal_discount_code ? JSON.parse(target.referal_discount_code) : {}; } catch (e) {}
  const mergedMilestones = { ...sourceMilestones, ...targetMilestones };

  // Transfer user_actions
  await client.query(
    'UPDATE user_actions SET user_id = $1 WHERE user_id = $2',
    [targetId, sourceId]
  );

  // Update target with merged data
  await client.query(`
    UPDATE users SET
      points = $1,
      first_name = $2,
      last_name = $3,
      tier = $4,
      total_spent = $5,
      referral_count = $6,
      birthday = $7,
      active_rewards = $8,
      referal_discount_code = $9
    WHERE user_id = $10
  `, [
    mergedPoints,
    mergedFirstName,
    mergedLastName,
    mergedTier,
    mergedTotalSpent,
    mergedReferralCount,
    mergedBirthday,
    JSON.stringify(mergedRewards),
    JSON.stringify(mergedMilestones),
    targetId
  ]);

  // Update referrals pointing to source
  await client.query(
    'UPDATE users SET referred_by = $1 WHERE referred_by = $2',
    [target.referral_code, source.referral_code]
  );

  // Delete source account
  await client.query('DELETE FROM users WHERE user_id = $1', [sourceId]);

  return true;
}

async function fixAllDuplicates() {
  const client = await pool.connect();

  try {
    console.log('=== FIXING ALL DUPLICATE ACCOUNTS ===\n');

    // Find all duplicates
    const duplicates = await client.query(`
      SELECT LOWER(email) as email_lower,
             array_agg(user_id ORDER BY points DESC, created_at ASC) as user_ids,
             array_agg(email ORDER BY points DESC, created_at ASC) as emails,
             array_agg(points ORDER BY points DESC, created_at ASC) as points
      FROM users
      GROUP BY LOWER(email)
      HAVING COUNT(*) > 1
    `);

    if (duplicates.rows.length === 0) {
      console.log('No duplicates found!\n');
    } else {
      console.log(`Found ${duplicates.rows.length} duplicate groups to merge\n`);

      await client.query('BEGIN');

      for (const dup of duplicates.rows) {
        console.log(`Merging: ${dup.email_lower}`);
        console.log(`  Accounts: ${dup.emails.join(' + ')}`);
        console.log(`  Points: ${dup.points.join(' + ')} = ${dup.points.reduce((a, b) => a + b, 0)}`);

        // Keep the first one (highest points), merge others into it
        const targetId = dup.user_ids[0];

        for (let i = 1; i < dup.user_ids.length; i++) {
          const sourceId = dup.user_ids[i];
          await mergeAccounts(client, sourceId, targetId);
        }

        console.log(`  ✓ Merged into user_id ${targetId}\n`);
      }

      await client.query('COMMIT');
      console.log(`Successfully merged ${duplicates.rows.length} duplicate groups\n`);
    }

    // Now add the case-insensitive unique index
    console.log('Adding case-insensitive unique index on email...');

    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
        ON users (LOWER(email))
      `);
      console.log('✓ Index created successfully!\n');
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log('✓ Index already exists\n');
      } else {
        throw err;
      }
    }

    // Verify no duplicates remain
    const remaining = await client.query(`
      SELECT LOWER(email), COUNT(*)
      FROM users
      GROUP BY LOWER(email)
      HAVING COUNT(*) > 1
    `);

    if (remaining.rows.length === 0) {
      console.log('=== ALL DUPLICATES FIXED ===');
      console.log('Future signups with different email case will be prevented.\n');
    } else {
      console.log(`WARNING: ${remaining.rows.length} duplicates still remain!`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

fixAllDuplicates()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
