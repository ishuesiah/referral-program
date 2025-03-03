// referral-server.js

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

// Create the Express app
const app = express();

// Increase the JSON payload size limit (if needed)
app.use(express.json({ limit: '2mb' }));

// Allow cross-origin requests (e.g., from your Shopify store domain)
app.use(cors());

// Set up the database connection pool using your Kinsta credentials for the referral_program database
const pool = mysql.createPool({
  host: 'northamerica-northeast1-001.proxy.kinsta.app',
  port: 30387,
  user: 'hemlockandoak',
  password: 'jH3&wM0gH2a',
  database: 'referral_program'
});

// Immediately test the connection and create the referral_users table if it doesn't exist
(async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Successfully connected to referral_program database!');
    
    // Debug: list available tables
    const [tables] = await connection.query('SHOW TABLES');
    console.log('Available tables:', tables.map(t => Object.values(t)[0]));
    
    // Create the referral_users table to store referral program data
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS referral_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        points INT DEFAULT 0,
        reward_level INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `;
    await connection.execute(createTableQuery);
    console.log('Referral users table is set up.');
    
    // Debug: show the table structure
    const [columns] = await connection.query('DESCRIBE referral_users');
    console.log('Referral_users table structure:');
    columns.forEach(col => {
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
    
    // Insert the new user with an initial 5 points and a starting reward level of 1
    const sql = `
      INSERT INTO referral_users (email, points, reward_level)
      VALUES (?, ?, ?)
    `;
    const initialPoints = 5;
    const initialRewardLevel = 1;
    
    try {
      const [result] = await pool.execute(sql, [email, initialPoints, initialRewardLevel]);
      console.log('Signup insert result:', result);
      return res.status(201).json({
        message: 'User signed up successfully and awarded 5 points!',
        userId: result.insertId,
        points: initialPoints,
        reward_level: initialRewardLevel
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
    const [users] = await pool.execute('SELECT * FROM referral_users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = users[0];
    const newPoints = user.points + pointsToAdd;
    
    // For this example, assume every 5 points increases the reward level by 1
    const newRewardLevel = Math.floor(newPoints / 5);
    
    const updateSql = `
      UPDATE referral_users
      SET points = ?, reward_level = ?
      WHERE email = ?
    `;
    const [updateResult] = await pool.execute(updateSql, [newPoints, newRewardLevel, email]);
    console.log('Award update result:', updateResult);
    
    return res.json({
      message: `Awarded ${pointsToAdd} points for action "${action}".`,
      email: email,
      newPoints: newPoints,
      reward_level: newRewardLevel
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
    const [rows] = await pool.execute('SELECT * FROM referral_users WHERE email = ?', [email]);
    
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
 * Special debug endpoint to verify referral user handling
 * Example: /api/debug/referral-user/user@example.com
 ********************************************************************/
app.get('/api/debug/referral-user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    console.log('Debug endpoint called for email:', email);
    
    const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM referral_users WHERE email = ?', [email]);
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
