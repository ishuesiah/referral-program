/********************************************************************
 * referral-server.js
 ********************************************************************/
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');

// Load environment variables
require('dotenv').config();

const app = express();

// Environment variables
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const TEST_ENDPOINT_SECRET = process.env.TEST_ENDPOINT_SECRET;

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

// Custom JSON parser that preserves raw body for webhook verification
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

/********************************************************************
 * Shopify webhook signature verification
 ********************************************************************/
function verifyShopifyWebhook(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) {
    console.warn('WARNING: SHOPIFY_WEBHOOK_SECRET not set - webhook verification disabled');
    return true; // Allow in development if secret not configured
  }

  const hmacHeader = req.get('X-Shopify-Hmac-SHA256');
  if (!hmacHeader) {
    console.log('No HMAC header present');
    return false;
  }

  const hash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

// Set up the database connection pool (credentials from environment variables)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
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
 * PROTECTED: Only whitelisted actions allowed, each can only be claimed once.
 ********************************************************************/
// Whitelist of allowed actions and their point values
const ALLOWED_ACTIONS = {
  'social_media_follow': 50,
  'community_join': 50,
  'facebook_like': 50,
  'youtube_subscribe': 50,
  'share': 5,
  'instagram': 5,
  'fb': 5,
  'bonus': 5
};

app.post('/api/referral/award', async (req, res) => {
  try {
    console.log('=== AWARD REFERRAL POINTS ===');
    const { email, action } = req.body;
    if (!email || !action) {
      return res.status(400).json({ error: 'Email and action are required.' });
    }

    // Validate action is in whitelist
    if (!ALLOWED_ACTIONS.hasOwnProperty(action)) {
      console.log(`Rejected unknown action type: ${action}`);
      return res.status(400).json({ error: 'Invalid action type.' });
    }

    // Retrieve the user
    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = users[0];

    // Check if this action has already been claimed (prevent duplicates for ALL actions)
    const [existingAction] = await pool.execute(
      'SELECT * FROM user_actions WHERE user_id = ? AND action_type = ?',
      [user.user_id, action]
    );
    if (existingAction.length > 0) {
      return res.status(400).json({ error: 'Points already claimed for this action.' });
    }

    // Get points from whitelist
    const pointsToAdd = ALLOWED_ACTIONS[action];
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
 * POST /api/shopify/order-paid
 * Shopify webhook endpoint for order completion.
 * Shopify sends order data when a customer completes a purchase.
 * Awards 5 points per $1 spent.
 * If first purchase and referred, awards 1500 points to referrer.
 ********************************************************************/
app.post('/api/shopify/order-paid', async (req, res) => {
  try {
    console.log('=== SHOPIFY ORDER WEBHOOK ===');

    // Verify the webhook is actually from Shopify
    if (!verifyShopifyWebhook(req)) {
      console.log('Webhook verification failed - rejecting request');
      return res.status(401).json({ error: 'Unauthorized - invalid webhook signature' });
    }

    const order = req.body;

    // Extract customer email and order total from Shopify payload
    const email = order.customer?.email || order.email;
    const orderTotal = parseFloat(order.total_price || order.subtotal_price || 0);
    const orderId = order.id || order.order_number;

    console.log(`Order ${orderId}: ${email} spent $${orderTotal}`);

    if (!email) {
      console.log('No customer email in order, skipping points award');
      return res.status(200).json({ message: 'No customer email, skipped' });
    }

    if (orderTotal <= 0) {
      console.log('Order total is zero or negative, skipping');
      return res.status(200).json({ message: 'Zero order total, skipped' });
    }

    // Look up the user in our referral database
    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);

    if (users.length === 0) {
      console.log(`User ${email} not in referral program, skipping`);
      return res.status(200).json({ message: 'User not in referral program' });
    }

    const user = users[0];

    // Check if we've already processed this order (prevent duplicates)
    const [existingOrder] = await pool.execute(
      'SELECT * FROM user_actions WHERE user_id = ? AND action_ref = ?',
      [user.user_id, `order_${orderId}`]
    );

    if (existingOrder.length > 0) {
      console.log(`Order ${orderId} already processed, skipping`);
      return res.status(200).json({ message: 'Order already processed' });
    }

    // Check if this is the user's first purchase
    const [existingPurchases] = await pool.execute(
      'SELECT * FROM user_actions WHERE user_id = ? AND action_type IN (?, ?, ?)',
      [user.user_id, 'purchase', 'test_purchase', 'shopify_purchase']
    );
    const isFirstPurchase = existingPurchases.length === 0;

    // Calculate points: 5 points per $1 spent
    const pointsToAdd = Math.floor(orderTotal * 5);
    const newPoints = user.points + pointsToAdd;

    // Update the user's points
    await pool.execute('UPDATE users SET points = ? WHERE email = ?', [newPoints, email]);

    // Record the purchase action with order reference to prevent duplicates
    await pool.execute(
      'INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref) VALUES (?, ?, ?, ?)',
      [user.user_id, 'shopify_purchase', pointsToAdd, `order_${orderId}`]
    );

    console.log(`Awarded ${pointsToAdd} points to ${email}. New total: ${newPoints}`);

    // If first purchase and user was referred, award bonus to referrer
    let referrerBonus = null;
    if (isFirstPurchase && user.referred_by) {
      const referralBonusPoints = 1500; // $15 worth of points

      const [referrers] = await pool.execute(
        'SELECT * FROM users WHERE referral_code = ?',
        [user.referred_by]
      );

      if (referrers.length > 0) {
        const referrer = referrers[0];
        const referrerNewPoints = referrer.points + referralBonusPoints;

        // Update referrer's points
        await pool.execute('UPDATE users SET points = ? WHERE user_id = ?', [referrerNewPoints, referrer.user_id]);

        // Update referrer's referral_count
        await pool.execute('UPDATE users SET referral_count = COALESCE(referral_count, 0) + 1 WHERE user_id = ?', [referrer.user_id]);

        // Record the referral bonus
        await pool.execute(
          'INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref) VALUES (?, ?, ?, ?)',
          [referrer.user_id, 'referral_first_purchase_bonus', referralBonusPoints, `referral_${user.user_id}_order_${orderId}`]
        );

        console.log(`Referral bonus: ${referrer.email} awarded ${referralBonusPoints} points for referring ${email}`);

        referrerBonus = {
          referrerEmail: referrer.email,
          bonusPoints: referralBonusPoints
        };
      }
    }

    return res.status(200).json({
      success: true,
      email: email,
      orderId: orderId,
      pointsAwarded: pointsToAdd,
      newPoints: newPoints,
      isFirstPurchase: isFirstPurchase,
      referrerBonus: referrerBonus
    });

  } catch (error) {
    console.error('Error processing Shopify webhook:', error);
    // Return 200 to prevent Shopify from retrying (log the error for debugging)
    return res.status(200).json({ error: 'Processing error', message: error.message });
  }
});

/********************************************************************
 * POST /api/referral/test-purchase
 * Simulates a purchase for testing the rewards system.
 * PROTECTED: Requires secret key in header or body.
 * Expects { "email": "user@example.com", "orderTotal": 50.00, "secret": "..." }
 * Awards 5 points per $1 spent.
 * If this is the user's FIRST purchase and they were referred,
 * awards 1500 points ($15 worth) to the referrer.
 ********************************************************************/
app.post('/api/referral/test-purchase', async (req, res) => {
  try {
    console.log('=== TEST PURCHASE ===');

    // Verify secret key
    const providedSecret = req.body.secret || req.get('X-Test-Secret');
    if (!TEST_ENDPOINT_SECRET || providedSecret !== TEST_ENDPOINT_SECRET) {
      console.log('Test purchase rejected - invalid or missing secret');
      return res.status(401).json({ error: 'Unauthorized - invalid secret key' });
    }

    const { email, orderTotal } = req.body;

    if (!email || orderTotal === undefined) {
      return res.status(400).json({ error: 'Email and orderTotal are required.' });
    }

    const amount = parseFloat(orderTotal);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'orderTotal must be a positive number.' });
    }

    // Retrieve the user
    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found. Please sign up first.' });
    }
    const user = users[0];

    // Check if this is the user's first purchase
    const [existingPurchases] = await pool.execute(
      'SELECT * FROM user_actions WHERE user_id = ? AND action_type IN (?, ?)',
      [user.user_id, 'test_purchase', 'purchase']
    );
    const isFirstPurchase = existingPurchases.length === 0;

    // Calculate points: 5 points per $1 spent
    const pointsToAdd = Math.floor(amount * 5);
    const newPoints = user.points + pointsToAdd;

    // Update the user's points
    await pool.execute('UPDATE users SET points = ? WHERE email = ?', [newPoints, email]);

    // Record the action in the user_actions table
    await pool.execute(
      'INSERT INTO user_actions (user_id, action_type, points_awarded) VALUES (?, ?, ?)',
      [user.user_id, 'test_purchase', pointsToAdd]
    );

    console.log(`Test purchase: ${email} spent $${amount}, awarded ${pointsToAdd} points. New total: ${newPoints}`);

    // If first purchase and user was referred, award bonus to referrer
    let referrerBonus = null;
    if (isFirstPurchase && user.referred_by) {
      const referralBonusPoints = 1500; // $15 worth of points (100 points = $1)

      // Find the referrer by their referral code
      const [referrers] = await pool.execute(
        'SELECT * FROM users WHERE referral_code = ?',
        [user.referred_by]
      );

      if (referrers.length > 0) {
        const referrer = referrers[0];
        const referrerNewPoints = referrer.points + referralBonusPoints;

        // Update referrer's points
        await pool.execute('UPDATE users SET points = ? WHERE user_id = ?', [referrerNewPoints, referrer.user_id]);

        // Update referrer's referral_count
        await pool.execute('UPDATE users SET referral_count = COALESCE(referral_count, 0) + 1 WHERE user_id = ?', [referrer.user_id]);

        // Record the referral bonus action
        await pool.execute(
          'INSERT INTO user_actions (user_id, action_type, points_awarded) VALUES (?, ?, ?)',
          [referrer.user_id, 'referral_first_purchase_bonus', referralBonusPoints]
        );

        console.log(`Referral bonus: ${referrer.email} awarded ${referralBonusPoints} points for referring ${email}`);

        referrerBonus = {
          referrerEmail: referrer.email,
          bonusPoints: referralBonusPoints,
          referrerNewPoints: referrerNewPoints
        };
      }
    }

    return res.json({
      message: `Test purchase successful! Awarded ${pointsToAdd} points for $${amount.toFixed(2)} order.`,
      email: email,
      orderTotal: amount,
      pointsAwarded: pointsToAdd,
      newPoints: newPoints,
      isFirstPurchase: isFirstPurchase,
      referrerBonus: referrerBonus
    });
  } catch (error) {
    console.error('Error in test-purchase endpoint:', error);
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
