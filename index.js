/********************************************************************
 * referral-server.js
 ********************************************************************/
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch'); // <-- Ensure you've installed node-fetch
const app = express();

// Load environment variables (if using a .env file)
// require('dotenv').config();

// Your private Klaviyo API key should be stored securely in an environment variable
// const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_API_KEY = pk_e933763531c3a4f3a9a5b6419e44c6d9a3;

// The Klaviyo list ID you want to add users to
const KLAVIYO_LIST_ID = 'Vc2WdM';

/********************************************************************
 * Helper function to subscribe a user to your Klaviyo list
 ********************************************************************/
async function subscribeToKlaviyoList(email, firstName) {
  // Construct the Klaviyo API endpoint using your list ID
  const klaviyoUrl = `https://a.klaviyo.com/api/v2/list/${KLAVIYO_LIST_ID}/subscribe?api_key=${KLAVIYO_API_KEY}`;
  
  // Build the payload for Klaviyo
  const payload = {
    profiles: [
      {
        email: email,
        first_name: firstName
      }
    ]
  };

  // Make the POST request to Klaviyo
  const response = await fetch(klaviyoUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Klaviyo subscription error:', errorText);
    // We won't throw an error here unless you want to prevent signups 
    // from succeeding if Klaviyo fails. For now, just log it.
  } else {
    console.log(`Successfully subscribed ${email} to Klaviyo list ${KLAVIYO_LIST_ID}.`);
  }
}

/********************************************************************
 * Referral code generator
 ********************************************************************/
function generateReferralCode() {
  // Generates a 6-character referral code (you can adjust the byte length as needed)
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

/********************************************************************
 * Express app setup
 ********************************************************************/
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));

// Set up the database connection pool
const pool = mysql.createPool({
  host: 'northamerica-northeast1-001.proxy.kinsta.app',
  port: 30387,
  user: 'hemlockandoak',
  password: 'jH3&wM0gH2a',
  database: 'referral_program_db'
});

/********************************************************************
 * Immediately test the connection and create the necessary tables if they don't exist
 ********************************************************************/
(async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Successfully connected to referral_program database!');
    
    // Debug: list available tables
    const [tables] = await connection.query('SHOW TABLES');
    console.log('Available tables:', tables.map(t => Object.values(t)[0]));

    // Create the "users" table
    const createUsersTableQuery = `
      CREATE TABLE IF NOT EXISTS users (
        user_id INT AUTO_INCREMENT PRIMARY KEY,
        first_name VARCHAR(255) DEFAULT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        points INT DEFAULT 0,
        referral_code VARCHAR(50) UNIQUE,
        referred_by VARCHAR(50) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await connection.execute(createUsersTableQuery);
    console.log('Users table is set up.');

    // Create the "user_actions" table
    const createUserActionsTableQuery = `
      CREATE TABLE IF NOT EXISTS user_actions (
        action_id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        action_type VARCHAR(50) NOT NULL,
        points_awarded INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      );
    `;
    await connection.execute(createUserActionsTableQuery);
    console.log('User actions table is set up.');

    // Debug: show the "users" table structure
    const [userColumns] = await connection.query('DESCRIBE users');
    console.log('Users table structure:');
    userColumns.forEach(col => {
      console.log(`  ${col.Field}: ${col.Type} ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'} ${col.Key}`);
    });

    // Debug: show the "user_actions" table structure
    const [actionColumns] = await connection.query('DESCRIBE user_actions');
    console.log('User actions table structure:');
    actionColumns.forEach(col => {
      console.log(`  ${col.Field}: ${col.Type} ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'} ${col.Key}`);
    });
    
    connection.release();
  } catch (err) {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  }
})();

/********************************************************************
 * Simple root route to confirm the server is running
 ********************************************************************/
app.get('/', (req, res) => {
  res.send('Referral Program API is up and running!');
});

/********************************************************************
 * POST /api/referral/signup
 * Registers a new referral user.
 * Expects { "email": "user@example.com", "firstName": "John", "referredBy": "ABC123" }
 * Awards 5 points on signup and (optionally) 5 points to the referrer if referredBy is valid.
 * Also subscribes the new user to Klaviyo.
 ********************************************************************/
app.post('/api/referral/signup', async (req, res) => {
  try {
    console.log('=== REFERRAL SIGNUP ===');
    const { email, firstName, referredBy } = req.body;
    
    if (!email || !firstName) {
      return res.status(400).json({ error: 'First name and email are required.' });
    }
    
    // Generate a unique referral code for the new user
    const referralCode = generateReferralCode();
    const initialPoints = 5;
    
    // If a referral code was provided, try to find the original user and award them 5 points
    if (referredBy) {
      const [referrerRows] = await pool.execute('SELECT * FROM users WHERE referral_code = ?', [referredBy]);
      if (referrerRows.length > 0) {
        // Update the original user's points by adding 5
        await pool.execute('UPDATE users SET points = points + 5 WHERE referral_code = ?', [referredBy]);
        console.log(`Awarded 5 bonus points to the user with referral code ${referredBy}`);
      } else {
        console.log('Referral code provided does not match any existing user.');
      }
    }
    
    // Insert the new user including the referred_by field (if provided)
    const sql = `
      INSERT INTO users (first_name, email, points, referral_code, referred_by)
      VALUES (?, ?, ?, ?, ?)
    `;
    const [result] = await pool.execute(sql, [firstName, email, initialPoints, referralCode, referredBy || null]);
    console.log('Signup insert result:', result);
    
    // After successfully creating the user in your DB, subscribe them to Klaviyo
    // We do this in a separate function for clarity
    subscribeToKlaviyoList(email, firstName)
      .catch(err => {
        console.error('Klaviyo subscription error:', err);
        // We won't fail the entire request if Klaviyo subscription fails,
        // but we do log the error for debugging.
      });
    
    // Construct the referral URL for the new user (adjust as needed)
    const referralUrl = `https://www.hemlockandoak.com/pages/email-signup/?ref=${referralCode}`;
    
    return res.status(201).json({
      message: 'User signed up successfully and awarded 5 points!',
      userId: result.insertId,
      points: initialPoints,
      referralCode: referralCode,
      referralUrl: referralUrl
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'User already exists.' });
    }
    console.error('Database error during signup:', err);
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

/********************************************************************
 * POST /api/referral/award
 * Adds referral points for additional actions.
 * Expects { "email": "user@example.com", "action": "share" }
 * Currently, each action awards 5 points.
 ********************************************************************/
app.post('/api/referral/award', async (req, res) => {
  try {
    console.log('=== AWARD REFERRAL POINTS ===');
    const { email, action } = req.body;
    if (!email || !action) {
      return res.status(400).json({ error: 'Email and action are required.' });
    }
    
    // Retrieve the user
    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = users[0];

    // For the "bonus" action, check if points have already been awarded
    if (action === 'social_media_follow') {
      const [existingBonus] = await pool.execute(
        'SELECT * FROM user_actions WHERE user_id = ? AND action_type = ?',
        [user.user_id, action]
      );
      if (existingBonus.length > 0) {
        return res.status(400).json({ error: 'Points already claimed.' });
      }
    }
    
    // For simplicity, award 5 points per action (e.g., share, ig, fb, bonus)
    const pointsToAdd = 5;
    const newPoints = user.points + pointsToAdd;
    
    // Update the user's points
    const updateSql = `UPDATE users SET points = ? WHERE email = ?`;
    await pool.execute(updateSql, [newPoints, email]);
    console.log('Award update result for', email);

    // Record the action in the user_actions table
    const insertActionSql = `
      INSERT INTO user_actions (user_id, action_type, points_awarded)
      VALUES (?, ?, ?)
    `;
    await pool.execute(insertActionSql, [user.user_id, action, pointsToAdd]);
    
    return res.json({
      message: `Awarded ${pointsToAdd} points for action "${action}".`,
      email: email,
      newPoints: newPoints
    });
  } catch (error) {
    console.error('Error in award endpoint:', error);
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

/********************************************************************
 * GET /api/referral/user/:email
 * Retrieves referral program details for a specific user.
 * Example: /api/referral/user/user@example.com
 ********************************************************************/
app.get('/api/referral/user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) {
      return res.status(400).json({ error: 'Missing email parameter.' });
    }
    
    console.log('Fetching referral info for email:', email);
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    return res.json({ user: rows[0] });
  } catch (error) {
    console.error('Error fetching referral info:', error);
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

/********************************************************************
 * Special debug endpoint to verify user handling
 * Example: /api/debug/referral-user/user@example.com
 ********************************************************************/
app.get('/api/debug/referral-user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    console.log('Debug endpoint called for email:', email);
    
    const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM users WHERE email = ?', [email]);
    return res.json({
      received_email: email,
      timestamp: new Date().toISOString(),
      user_count: rows[0].count
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

/********************************************************************
 * Start the server
 ********************************************************************/
const PORT = process.env.PORT || 3001; // Use a different port if needed
app.listen(PORT, () => {
  console.log(`Referral Program API listening on port ${PORT}`);
  console.log(`Server started at: ${new Date().toISOString()}`);
});
