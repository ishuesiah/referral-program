// referral-server.js

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

// Define your referral code generator function here
function generateReferralCode() {
  // Generates a 6-character referral code (you can adjust the byte length as needed)
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));

// Set up the database connection pool using your Kinsta credentials for the referral_program database
const pool = mysql.createPool({
  host: 'northamerica-northeast1-001.proxy.kinsta.app',
  port: 30387,
  user: 'hemlockandoak',
  password: 'jH3&wM0gH2a',
  database: 'referral_program_db'
});

// Immediately test the connection and create the necessary tables if they don't exist
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
 * Expects a JSON body with at least { "email": "user@example.com" }
 * Awards 5 points (initial sign-up bonus) and sets reward_level to 1.
 ********************************************************************/
app.post('/api/referral/signup', async (req, res) => {
  try {
    console.log('=== REFERRAL SIGNUP ===');
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    
    // Generate a unique referral code
    const referralCode = generateReferralCode();
    const initialPoints = 5;
    
    // Insert the new user with email, initial points, and the referral code
    const sql = `
      INSERT INTO users (email, points, referral_code)
      VALUES (?, ?, ?)
    `;
    
    try {
      const [result] = await pool.execute(sql, [email, initialPoints, referralCode]);
      console.log('Signup insert result:', result);
      
      // Construct the referral URL (adjust the base URL as needed)
      const referralUrl = `https://hemlockandoak.com/?ref=${referralCode}`;
      
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
  } catch (error) {
    console.error('Error in signup endpoint:', error);
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
});


/********************************************************************
 * POST /api/referral/award
 * Adds referral points for additional actions.
 * Expects a JSON body with { "email": "user@example.com", "action": "share" }
 * Currently, each action awards 5 points.
 ********************************************************************/
app.post('/api/referral/award', async (req, res) => {
  try {
    console.log('=== AWARD REFERRAL POINTS ===');
    const { email, action } = req.body;
    if (!email || !action) {
      return res.status(400).json({ error: 'Email and action are required.' });
    }
    
    // For simplicity, award 5 points per action (e.g., share, ig, fb)
    const pointsToAdd = 5;
    
    // Retrieve the user
    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = users[0];
    const newPoints = user.points + pointsToAdd;
    
    // For this example, every action simply adds points; adjust reward logic as needed.
    const updateSql = `
      UPDATE users
      SET points = ?
      WHERE email = ?
    `;
    const [updateResult] = await pool.execute(updateSql, [newPoints, email]);
    console.log('Award update result:', updateResult);
    
    // Optionally, record the action in the user_actions table
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
