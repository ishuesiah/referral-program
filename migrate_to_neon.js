/**
 * Migration script: MySQL (Sevalla) → PostgreSQL (Neon)
 * Run with: node migrate_to_neon.js
 */

const mysql = require('mysql2/promise');
const { Client } = require('pg');

// MySQL (source) - Sevalla
const MYSQL_CONFIG = {
  host: 'northamerica-northeast1-001.proxy.kinsta.app',
  port: 30387,
  user: 'hemlockandoak',
  password: 'jH3&wM0gH2a',
  database: 'referral_program_db'
};

// PostgreSQL (destination) - Neon
const NEON_CONNECTION_STRING = 'postgresql://neondb_owner:npg_LvEsoAyW0g8i@ep-red-mud-ainvgicr-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require';

async function migrate() {
  console.log('Starting migration...\n');

  // Connect to MySQL
  console.log('Connecting to MySQL (Sevalla)...');
  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG);
  console.log('✅ Connected to MySQL\n');

  // Connect to PostgreSQL
  console.log('Connecting to PostgreSQL (Neon)...');
  const pgClient = new Client({ connectionString: NEON_CONNECTION_STRING });
  await pgClient.connect();
  console.log('✅ Connected to PostgreSQL\n');

  try {
    // --- Migrate Users ---
    console.log('Fetching users from MySQL...');
    const [users] = await mysqlConn.execute('SELECT * FROM users ORDER BY user_id');
    console.log(`Found ${users.length} users\n`);

    console.log('Inserting users into PostgreSQL...');
    let usersInserted = 0;

    for (const user of users) {
      try {
        await pgClient.query(`
          INSERT INTO users (
            user_id, shopify_customer_id, first_name, last_name, email, points,
            referral_code, referred_by, last_discount_code, created_at,
            membership_status, vip_tier_name, date_of_birth,
            referral_purchases_count, discount_code_id, referral_count, referal_discount_code
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
          ON CONFLICT (email) DO NOTHING
        `, [
          user.user_id,
          user.shopify_customer_id,
          user.first_name,
          user.last_name,
          user.email,
          user.points || 0,
          user.referral_code,
          user.referred_by,
          user.last_discount_code,
          user.created_at,
          user.membership_status,
          user.vip_tier_name,
          user.date_of_birth,
          user.referral_purchases_count || 0,
          user.discount_code_id,
          user.referral_count || 0,
          user.referal_discount_code
        ]);
        usersInserted++;
      } catch (err) {
        console.log(`  Skipped user ${user.email}: ${err.message}`);
      }
    }
    console.log(`✅ Inserted ${usersInserted} users\n`);

    // Reset sequence to max user_id
    const maxUserId = Math.max(...users.map(u => u.user_id), 0);
    await pgClient.query(`SELECT setval('users_user_id_seq', $1, true)`, [maxUserId]);
    console.log(`✅ Reset user_id sequence to ${maxUserId}\n`);

    // --- Migrate User Actions ---
    console.log('Fetching user_actions from MySQL...');
    const [actions] = await mysqlConn.execute('SELECT * FROM user_actions ORDER BY action_id');
    console.log(`Found ${actions.length} actions\n`);

    console.log('Inserting user_actions into PostgreSQL...');
    let actionsInserted = 0;

    for (const action of actions) {
      try {
        await pgClient.query(`
          INSERT INTO user_actions (action_id, user_id, action_type, points_awarded, created_at, action_ref)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
        `, [
          action.action_id,
          action.user_id,
          action.action_type,
          action.points_awarded || 0,
          action.created_at,
          action.action_ref
        ]);
        actionsInserted++;
      } catch (err) {
        console.log(`  Skipped action ${action.action_id}: ${err.message}`);
      }
    }
    console.log(`✅ Inserted ${actionsInserted} actions\n`);

    // Reset sequence to max action_id
    if (actions.length > 0) {
      const maxActionId = Math.max(...actions.map(a => a.action_id), 0);
      await pgClient.query(`SELECT setval('user_actions_action_id_seq', $1, true)`, [maxActionId]);
      console.log(`✅ Reset action_id sequence to ${maxActionId}\n`);
    }

    console.log('========================================');
    console.log('Migration completed successfully!');
    console.log(`  Users migrated: ${usersInserted}`);
    console.log(`  Actions migrated: ${actionsInserted}`);
    console.log('========================================');

  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    await mysqlConn.end();
    await pgClient.end();
  }
}

migrate();
