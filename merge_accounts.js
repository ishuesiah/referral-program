/********************************************************************
 * merge_accounts.js
 * Merge two referral program accounts into one
 *
 * Usage: node merge_accounts.js <source_email> <target_email>
 *
 * This will:
 * - Transfer all points from source to target
 * - Move all user_actions history from source to target
 * - Merge active_rewards arrays
 * - Preserve the better data (name, birthday, tier, etc.)
 * - Delete the source account
 ********************************************************************/
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function mergeAccounts(sourceEmail, targetEmail) {
  const client = await pool.connect();

  try {
    console.log('\n=== MERGE ACCOUNTS ===');
    console.log(`Source (will be deleted): ${sourceEmail}`);
    console.log(`Target (will keep): ${targetEmail}`);
    console.log('');

    // Find both users (exact match to distinguish case-sensitive duplicates)
    const sourceResult = await client.query(
      'SELECT * FROM users WHERE email = $1',
      [sourceEmail]
    );
    const targetResult = await client.query(
      'SELECT * FROM users WHERE email = $1',
      [targetEmail]
    );

    if (sourceResult.rows.length === 0) {
      console.error(`ERROR: Source account not found: ${sourceEmail}`);
      return false;
    }
    if (targetResult.rows.length === 0) {
      console.error(`ERROR: Target account not found: ${targetEmail}`);
      return false;
    }

    const source = sourceResult.rows[0];
    const target = targetResult.rows[0];

    if (source.user_id === target.user_id) {
      console.error('ERROR: Source and target are the same account!');
      return false;
    }

    console.log('Source account:');
    console.log(`  ID: ${source.user_id}`);
    console.log(`  Name: ${source.first_name || 'Unknown'} ${source.last_name || ''}`);
    console.log(`  Email: ${source.email}`);
    console.log(`  Points: ${source.points}`);
    console.log(`  Referral Code: ${source.referral_code}`);
    console.log(`  Tier: ${source.tier || 'none'}`);
    console.log(`  Total Spent: $${source.total_spent || 0}`);
    console.log(`  Birthday: ${source.birthday || 'not set'}`);
    console.log('');

    console.log('Target account:');
    console.log(`  ID: ${target.user_id}`);
    console.log(`  Name: ${target.first_name || 'Unknown'} ${target.last_name || ''}`);
    console.log(`  Email: ${target.email}`);
    console.log(`  Points: ${target.points}`);
    console.log(`  Referral Code: ${target.referral_code}`);
    console.log(`  Tier: ${target.tier || 'none'}`);
    console.log(`  Total Spent: $${target.total_spent || 0}`);
    console.log(`  Birthday: ${target.birthday || 'not set'}`);
    console.log('');

    // Get action counts
    const sourceActions = await client.query(
      'SELECT COUNT(*) as count FROM user_actions WHERE user_id = $1',
      [source.user_id]
    );
    const targetActions = await client.query(
      'SELECT COUNT(*) as count FROM user_actions WHERE user_id = $1',
      [target.user_id]
    );

    console.log(`Source has ${sourceActions.rows[0].count} action records`);
    console.log(`Target has ${targetActions.rows[0].count} action records`);
    console.log('');

    // Calculate merged values
    const mergedPoints = (source.points || 0) + (target.points || 0);
    const mergedTotalSpent = Math.max(
      parseFloat(source.total_spent) || 0,
      parseFloat(target.total_spent) || 0
    );
    const mergedReferralCount = (source.referral_count || 0) + (target.referral_count || 0);

    // Use the better name (prefer non-empty/non-Unknown)
    const mergedFirstName = (target.first_name && target.first_name !== 'Unknown')
      ? target.first_name
      : (source.first_name || target.first_name);
    const mergedLastName = target.last_name || source.last_name;

    // Use the birthday if either has one (prefer target)
    const mergedBirthday = target.birthday || source.birthday;

    // Determine best tier based on total spent
    const tierOrder = { 'VIP': 4, 'Gold': 3, 'Silver': 2, 'Bronze': 1 };
    const sourceTierRank = tierOrder[source.tier] || 0;
    const targetTierRank = tierOrder[target.tier] || 0;
    const mergedTier = sourceTierRank > targetTierRank ? source.tier : (target.tier || source.tier);

    // Merge active_rewards arrays
    let sourceRewards = [];
    let targetRewards = [];
    try {
      sourceRewards = source.active_rewards ? JSON.parse(source.active_rewards) : [];
    } catch (e) { sourceRewards = []; }
    try {
      targetRewards = target.active_rewards ? JSON.parse(target.active_rewards) : [];
    } catch (e) { targetRewards = []; }
    const mergedRewards = [...targetRewards, ...sourceRewards];

    // Merge milestone discount codes
    let sourceMilestones = {};
    let targetMilestones = {};
    try {
      sourceMilestones = source.referal_discount_code ? JSON.parse(source.referal_discount_code) : {};
    } catch (e) { sourceMilestones = {}; }
    try {
      targetMilestones = target.referal_discount_code ? JSON.parse(target.referal_discount_code) : {};
    } catch (e) { targetMilestones = {}; }
    const mergedMilestones = { ...sourceMilestones, ...targetMilestones };

    console.log('Merged values:');
    console.log(`  Points: ${source.points} + ${target.points} = ${mergedPoints}`);
    console.log(`  Name: ${mergedFirstName} ${mergedLastName || ''}`);
    console.log(`  Tier: ${mergedTier}`);
    console.log(`  Total Spent: $${mergedTotalSpent}`);
    console.log(`  Referral Count: ${mergedReferralCount}`);
    console.log(`  Birthday: ${mergedBirthday || 'not set'}`);
    console.log(`  Active Rewards: ${mergedRewards.length} codes`);
    console.log('');

    // Start transaction
    await client.query('BEGIN');

    // 1. Transfer all user_actions from source to target
    const transferResult = await client.query(
      'UPDATE user_actions SET user_id = $1 WHERE user_id = $2',
      [target.user_id, source.user_id]
    );
    console.log(`Transferred ${transferResult.rowCount} action records to target account`);

    // 2. Update target account with merged data
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
      target.user_id
    ]);
    console.log('Updated target account with merged data');

    // 3. Update any users who were referred by the source's referral code
    //    to point to the target's referral code instead
    const referredUpdate = await client.query(
      'UPDATE users SET referred_by = $1 WHERE referred_by = $2',
      [target.referral_code, source.referral_code]
    );
    if (referredUpdate.rowCount > 0) {
      console.log(`Updated ${referredUpdate.rowCount} users who were referred by source's code`);
    }

    // 4. Delete the source account
    await client.query('DELETE FROM users WHERE user_id = $1', [source.user_id]);
    console.log('Deleted source account');

    // Commit transaction
    await client.query('COMMIT');

    console.log('\n=== MERGE COMPLETE ===');
    console.log(`Account ${sourceEmail} has been merged into ${targetEmail}`);
    console.log(`Final points balance: ${mergedPoints}`);
    console.log(`Referral code to use: ${target.referral_code}`);

    return true;

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR: Merge failed, rolled back all changes');
    console.error(err);
    return false;
  } finally {
    client.release();
    await pool.end();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: node merge_accounts.js <source_email> <target_email>');
  console.log('');
  console.log('This will merge the source account INTO the target account.');
  console.log('The source account will be deleted after merging.');
  console.log('');
  console.log('Example:');
  console.log('  node merge_accounts.js shannonEC@hotmail.com shannonec@hotmail.com');
  process.exit(1);
}

const sourceEmail = args[0];
const targetEmail = args[1];

mergeAccounts(sourceEmail, targetEmail)
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
