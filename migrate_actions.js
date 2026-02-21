const mysql = require('mysql2/promise');
const { Client } = require('pg');

async function migrateActions() {
  console.log('Migrating user_actions...');

  const mysqlConn = await mysql.createConnection({
    host: 'northamerica-northeast1-001.proxy.kinsta.app',
    port: 30387,
    user: 'hemlockandoak',
    password: 'jH3&wM0gH2a',
    database: 'referral_program_db'
  });
  console.log('Connected to MySQL');

  const pgClient = new Client({
    connectionString: 'postgresql://neondb_owner:npg_LvEsoAyW0g8i@ep-red-mud-ainvgicr-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require'
  });
  await pgClient.connect();
  console.log('Connected to PostgreSQL');

  const [actions] = await mysqlConn.execute('SELECT * FROM user_actions ORDER BY action_id');
  console.log('Found', actions.length, 'actions');

  let inserted = 0;
  for (const a of actions) {
    try {
      await pgClient.query(
        `INSERT INTO user_actions (action_id, user_id, action_type, points_awarded, created_at, action_ref)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [a.action_id, a.user_id, a.action_type, a.points_awarded || 0, a.created_at, a.action_ref]
      );
      inserted++;
      if (inserted % 500 === 0) console.log('Progress:', inserted, '/', actions.length);
    } catch (e) {
      console.log('Skip action', a.action_id, e.message);
    }
  }

  if (actions.length > 0) {
    const maxId = Math.max(...actions.map(a => a.action_id));
    await pgClient.query(`SELECT setval('user_actions_action_id_seq', $1, true)`, [maxId]);
  }

  console.log('Done! Inserted', inserted, 'actions');
  await mysqlConn.end();
  await pgClient.end();
}

migrateActions().catch(console.error);
