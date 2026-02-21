/********************************************************************
 * referral-server.js
 ********************************************************************/
const express = require('express');
const { Pool } = require('pg');
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
/********************************************************************
 * Helper function to create a $15 discount code for referred users
 * Calls the reviews API to create the welcome discount
 ********************************************************************/
const REVIEWS_API_URL = 'https://reviews-kettd.kinsta.app';

async function createReferralDiscountCode(email) {
  try {
    const response = await fetch(`${REVIEWS_API_URL}/api/referral/create-welcome-discount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Failed to create referral discount code:', errorData);
      return null;
    }

    const data = await response.json();
    console.log(`Created $15 referral welcome discount code: ${data.discountCode} for ${email}`);
    return data.discountCode;

  } catch (error) {
    console.error('Error creating referral discount code:', error);
    return null;
  }
}

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

// Set up the database connection pool (PostgreSQL - Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/********************************************************************
 * Test the database connection
 ********************************************************************/
(async function testConnection() {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Successfully connected to Neon PostgreSQL database!');
    console.log('Server time:', result.rows[0].now);

    // Check tables exist
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    console.log('Available tables:', tables.rows.map(t => t.table_name));
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
      const referrerResult = await pool.query('SELECT * FROM users WHERE referral_code = $1', [referredBy]);
      if (referrerResult.rows.length > 0) {
        // Update the original user's points by adding 5
        await pool.query('UPDATE users SET points = points + 5 WHERE referral_code = $1', [referredBy]);
        console.log(`Awarded 5 bonus points to the user with referral code ${referredBy}`);
      } else {
        console.log('Referral code provided does not match any existing user.');
      }
    }

    // Insert the new user including the referred_by field (if provided)
    const sql = `
      INSERT INTO users (first_name, email, points, referral_code, referred_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING user_id
    `;
    const result = await pool.query(sql, [firstName, email, initialPoints, referralCode, referredBy || null]);
    console.log('Signup insert result:', result.rows[0]);
    
    // After successfully creating the user in your DB, subscribe them to Klaviyo
    // We do this in a separate function for clarity
    subscribeToKlaviyoList(email, firstName)
      .catch(err => {
        console.error('Klaviyo subscription error:', err);
        // We won't fail the entire request if Klaviyo subscription fails,
        // but we do log the error for debugging.
      });

    // If user was referred, create a $15 discount code for their first purchase
    let welcomeDiscountCode = null;
    if (referredBy) {
      welcomeDiscountCode = await createReferralDiscountCode(email);
    }

    // Construct the referral URL for the new user (adjust as needed)
    const referralUrl = `https://www.hemlockandoak.com/pages/email-signup/?ref=${referralCode}`;

    return res.status(201).json({
      message: referredBy
        ? 'User signed up successfully! Use your $15 discount code on your first purchase!'
        : 'User signed up successfully and awarded 5 points!',
      userId: result.rows[0].user_id,
      points: initialPoints,
      referralCode: referralCode,
      referralUrl: referralUrl,
      welcomeDiscountCode: welcomeDiscountCode
    });
  } catch (err) {
    if (err.code === '23505') { // PostgreSQL unique violation
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
    const usersResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (usersResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = usersResult.rows[0];

    // Check if this action has already been claimed (prevent duplicates for ALL actions)
    const existingActionResult = await pool.query(
      'SELECT * FROM user_actions WHERE user_id = $1 AND action_type = $2',
      [user.user_id, action]
    );
    if (existingActionResult.rows.length > 0) {
      return res.status(400).json({ error: 'Points already claimed for this action.' });
    }

    // Get points from whitelist
    const pointsToAdd = ALLOWED_ACTIONS[action];
    const newPoints = user.points + pointsToAdd;

    // Update the user's points
    await pool.query('UPDATE users SET points = $1 WHERE email = $2', [newPoints, email]);
    console.log('Award update result for', email);

    // Record the action in the user_actions table
    await pool.query(
      'INSERT INTO user_actions (user_id, action_type, points_awarded) VALUES ($1, $2, $3)',
      [user.user_id, action, pointsToAdd]
    );
    
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
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.json({ user: result.rows[0] });
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
    const usersResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (usersResult.rows.length === 0) {
      console.log(`User ${email} not in referral program, skipping`);
      return res.status(200).json({ message: 'User not in referral program' });
    }

    const user = usersResult.rows[0];

    // Check if we've already processed this order (prevent duplicates)
    const existingOrderResult = await pool.query(
      'SELECT * FROM user_actions WHERE user_id = $1 AND action_ref = $2',
      [user.user_id, `order_${orderId}`]
    );

    if (existingOrderResult.rows.length > 0) {
      console.log(`Order ${orderId} already processed, skipping`);
      return res.status(200).json({ message: 'Order already processed' });
    }

    // Check if this is the user's first purchase
    const existingPurchasesResult = await pool.query(
      "SELECT * FROM user_actions WHERE user_id = $1 AND action_type IN ('purchase', 'test_purchase', 'shopify_purchase')",
      [user.user_id]
    );
    const isFirstPurchase = existingPurchasesResult.rows.length === 0;

    // Calculate points: 5 points per $1 spent
    const pointsToAdd = Math.floor(orderTotal * 5);
    const newPoints = user.points + pointsToAdd;

    // Update the user's points
    await pool.query('UPDATE users SET points = $1 WHERE email = $2', [newPoints, email]);

    // Record the purchase action with order reference to prevent duplicates
    await pool.query(
      'INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref) VALUES ($1, $2, $3, $4)',
      [user.user_id, 'shopify_purchase', pointsToAdd, `order_${orderId}`]
    );

    console.log(`Awarded ${pointsToAdd} points to ${email}. New total: ${newPoints}`);

    // Check if order used any of our reward discount codes
    // If so, mark them as used so they can't be cancelled for a refund
    const discountCodes = order.discount_codes || [];
    for (const discount of discountCodes) {
      const code = discount.code;
      // Check if this is one of our reward codes (POINTS*CAD_* or MILESTONEFREE_*)
      if (code && (code.startsWith('POINTS') || code.startsWith('MILESTONEFREE_'))) {
        console.log(`Order used reward discount code: ${code}`);

        // Extract the tier (points value) from the discount code
        let usedTier = null;
        const tierMatch = code.match(/POINTS(\d+(?:\.\d+)?)CAD_/);
        if (tierMatch) {
          const dollarValue = parseFloat(tierMatch[1]);
          usedTier = dollarValue * 100; // Convert to points (e.g., $5 = 500 points)
        }

        // Find user who has this discount code and clear it
        const discountUserResult = await pool.query(
          'SELECT * FROM users WHERE last_discount_code = $1',
          [code]
        );

        if (discountUserResult.rows.length > 0) {
          const discountUser = discountUserResult.rows[0];
          await pool.query(
            'UPDATE users SET last_discount_code = NULL, discount_code_id = NULL WHERE user_id = $1',
            [discountUser.user_id]
          );
          console.log(`Marked discount code ${code} as used for user ${discountUser.email}`);

          // Record the used tier to lock it until next purchase
          if (usedTier) {
            await pool.query(
              'INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref) VALUES ($1, $2, $3, $4)',
              [discountUser.user_id, 'discount_tier_used', 0, `tier_${usedTier}`]
            );
            console.log(`Locked tier ${usedTier} for user ${discountUser.email}`);
          }
        }
      }
    }

    // If first purchase and user was referred, award bonus to referrer
    let referrerBonus = null;
    if (isFirstPurchase && user.referred_by) {
      const referralBonusPoints = 1500; // $15 worth of points

      const referrersResult = await pool.query(
        'SELECT * FROM users WHERE referral_code = $1',
        [user.referred_by]
      );

      if (referrersResult.rows.length > 0) {
        const referrer = referrersResult.rows[0];
        const referrerNewPoints = referrer.points + referralBonusPoints;

        // Update referrer's points
        await pool.query('UPDATE users SET points = $1 WHERE user_id = $2', [referrerNewPoints, referrer.user_id]);

        // Update referrer's referral_count
        await pool.query('UPDATE users SET referral_count = COALESCE(referral_count, 0) + 1 WHERE user_id = $1', [referrer.user_id]);

        // Record the referral bonus
        await pool.query(
          'INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref) VALUES ($1, $2, $3, $4)',
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
    const usersResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (usersResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found. Please sign up first.' });
    }
    const user = usersResult.rows[0];

    // Check if this is the user's first purchase
    const existingPurchasesResult = await pool.query(
      "SELECT * FROM user_actions WHERE user_id = $1 AND action_type IN ('test_purchase', 'purchase')",
      [user.user_id]
    );
    const isFirstPurchase = existingPurchasesResult.rows.length === 0;

    // Calculate points: 5 points per $1 spent
    const pointsToAdd = Math.floor(amount * 5);
    const newPoints = user.points + pointsToAdd;

    // Update the user's points
    await pool.query('UPDATE users SET points = $1 WHERE email = $2', [newPoints, email]);

    // Record the action in the user_actions table
    await pool.query(
      'INSERT INTO user_actions (user_id, action_type, points_awarded) VALUES ($1, $2, $3)',
      [user.user_id, 'test_purchase', pointsToAdd]
    );

    console.log(`Test purchase: ${email} spent $${amount}, awarded ${pointsToAdd} points. New total: ${newPoints}`);

    // If first purchase and user was referred, award bonus to referrer
    let referrerBonus = null;
    if (isFirstPurchase && user.referred_by) {
      const referralBonusPoints = 1500; // $15 worth of points (100 points = $1)

      // Find the referrer by their referral code
      const referrersResult = await pool.query(
        'SELECT * FROM users WHERE referral_code = $1',
        [user.referred_by]
      );

      if (referrersResult.rows.length > 0) {
        const referrer = referrersResult.rows[0];
        const referrerNewPoints = referrer.points + referralBonusPoints;

        // Update referrer's points
        await pool.query('UPDATE users SET points = $1 WHERE user_id = $2', [referrerNewPoints, referrer.user_id]);

        // Update referrer's referral_count
        await pool.query('UPDATE users SET referral_count = COALESCE(referral_count, 0) + 1 WHERE user_id = $1', [referrer.user_id]);

        // Record the referral bonus action
        await pool.query(
          'INSERT INTO user_actions (user_id, action_type, points_awarded) VALUES ($1, $2, $3)',
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

    const result = await pool.query('SELECT COUNT(*) AS count FROM users WHERE email = $1', [email]);
    return res.json({
      received_email: email,
      timestamp: new Date().toISOString(),
      user_count: result.rows[0].count
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
