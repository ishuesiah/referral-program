/********************************************************************
 * referral-server.js
 ********************************************************************/
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch'); // Ensure you've installed node-fetch (or use Node 18+ built-in fetch)
require('dotenv').config(); // Load environment variables from .env
const app = express();

// Your private Klaviyo API key is now securely loaded from the environment
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
// The Klaviyo list ID you want to add users to
const KLAVIYO_LIST_ID = 'Vc2WdM';

/********************************************************************
 * Helper function to create a Klaviyo profile
 ********************************************************************/
async function createKlaviyoProfile(email, firstName) {
  const klaviyoCreateProfileUrl = 'https://a.klaviyo.com/api/profiles';
  const payload = {
    data: {
      type: "profile",
      attributes: { email, first_name: firstName }
    }
  };
  const revisionHeader = '2023-12-15';

  const response = await fetch(klaviyoCreateProfileUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'REVISION': revisionHeader
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    try {
      const errorJSON = JSON.parse(errorText);
      if (errorJSON.errors?.[0].code === "duplicate_profile" && errorJSON.errors[0].meta?.duplicate_profile_id) {
        console.log("Profile already exists. Using duplicate id: " + errorJSON.errors[0].meta.duplicate_profile_id);
        return errorJSON.errors[0].meta.duplicate_profile_id;
      }
    } catch {}
    throw new Error('Klaviyo create error: ' + errorText);
  }

  const result = await response.json();
  return result.data.id;
}

/********************************************************************
 * Helper function to add an existing Klaviyo profile to a list
 ********************************************************************/
async function addProfileToList(klaviyoProfileId, email) {
  const klaviyoUrl = `https://a.klaviyo.com/api/lists/${KLAVIYO_LIST_ID}/relationships/profiles`;
  const payload = { data: [{ type: "profile", id: klaviyoProfileId }] };
  const revisionHeader = '2023-12-15';

  const response = await fetch(klaviyoUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'REVISION': revisionHeader
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) console.error('Klaviyo add-to-list error:', await response.text());
}

/********************************************************************
 * Combined function to ensure the profile exists and is added to the list
 ********************************************************************/
async function subscribeToKlaviyoList(email, firstName) {
  try {
    const profileId = await createKlaviyoProfile(email, firstName);
    console.log(`Got Klaviyo profile id: ${profileId}`);
    await addProfileToList(profileId, email);
  } catch (err) {
    console.error('Klaviyo subscription error:', err);
  }
}

/********************************************************************
 * Referral code generator
 ********************************************************************/
function generateReferralCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

/********************************************************************
 * Express app setup
 ********************************************************************/
app.use(cors({
  origin: [
    'https://www.hemlockandoak.com',
    'https://hemlock-oak.myshopify.com',
    'http://localhost:3000',  // for local testing
    'http://127.0.0.1:9292'   // for Shopify theme dev
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));

// Set up the database connection pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE
});

/********************************************************************
 * Immediately test the connection and create the necessary tables if they don't exist
 ********************************************************************/
(async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Connected to referral_program_db');

    await connection.execute(
      `CREATE TABLE IF NOT EXISTS users (
  user_id                      INT AUTO_INCREMENT PRIMARY KEY,
  shopify_customer_id          VARCHAR(255)     DEFAULT NULL,
  first_name                   VARCHAR(255)     DEFAULT NULL,
  last_name                    VARCHAR(255)     DEFAULT NULL,
  email                        VARCHAR(255)     NOT NULL UNIQUE,
  date_of_birth                DATE             DEFAULT NULL,
  membership_status            VARCHAR(50)      DEFAULT NULL,
  vip_tier_name                VARCHAR(100)     DEFAULT NULL,
  points                       INT              DEFAULT 0,
  referral_count               INT              DEFAULT 0,
  referral_purchases_count     INT              DEFAULT 0,
  referral_code                VARCHAR(50)      UNIQUE,
  referral_discount_code       VARCHAR(50)      DEFAULT NULL,
  discount_code_id             INT              DEFAULT NULL,
  referred_by                  VARCHAR(50)      DEFAULT NULL,
  last_discount_code           VARCHAR(50)      DEFAULT NULL,
  created_at                   DATETIME         DEFAULT CURRENT_TIMESTAMP
);
`
    );

    await connection.execute(
      `CREATE TABLE IF NOT EXISTS user_actions (
        action_id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        action_type VARCHAR(50) NOT NULL,
        points_awarded INT DEFAULT 0,
        action_ref VARCHAR(255) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      );`
    );

    connection.release();
  } catch (err) {
    console.error('DB init error:', err);
    process.exit(1);
  }
})();

/********************************************************************
 * Simple root route
 ********************************************************************/
app.get('/', (req, res) => res.send('Referral Program API is up'));

/********************************************************************
 * POST /api/referral/signup
 ********************************************************************/
app.post('/api/referral/signup', async (req, res) => {
  try {
    const { email, firstName, referredBy, shopifyCustomerId } = req.body;
    if (!email || !firstName) return res.status(400).json({ error: 'Email & firstName required' });
    
    const referralCode = generateReferralCode();
    const initialPoints = 5;
    
    // Increment referrer's count if this user was referred
    if (referredBy) {
      await pool.execute(
        'UPDATE users SET referral_count = referral_count + 1 WHERE referral_code = ?',
        [referredBy]
      );
    } 

    const [result] = await pool.execute(
      `INSERT INTO users 
        (first_name,email,points,referral_code,referred_by,shopify_customer_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [firstName, email, initialPoints, referralCode, referredBy||null, shopifyCustomerId||null]
    );

    subscribeToKlaviyoList(email, firstName);

    return res.status(201).json({
      message: 'User signed up',
      userId: result.insertId,
      points: initialPoints,
      referralCode,
      referralUrl: `https://www.hemlockandoak.com/pages/email-signup/?ref=${referralCode}`
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'User exists' });
    console.error('Signup error:', err);
    return res.status(500).json({ error: err.message });
  }
});  // ← Removed extra brace

/********************************************************************
 * POST /api/referral/check-purchase (legacy)
 ********************************************************************/
app.post('/api/referral/check-purchase', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await rewardReferrerAfterPurchase(email);
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/********************************************************************
 * rewardReferrerAfterPurchase (legacy)
 ********************************************************************/
async function rewardReferrerAfterPurchase(email, orderId) {
  const shop = 'hemlock-oak.myshopify.com';
  const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;

  const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  if (!users.length) return { error: 'User not found' };
  const referredUser = users[0];

  const ordersRes = await fetch(
    `https://${shop}/admin/api/2023-07/orders.json?customer_id=${referredUser.shopify_customer_id}&status=any`,
    { headers: { 'X-Shopify-Access-Token': accessToken }}
  );
  const ordersData = await ordersRes.json();
  if (!ordersData.orders?.length) return { message: 'No purchase yet.' };

  // Legacy sums all orders — recommend using /award-purchase instead
  const totalSpent = ordersData.orders.reduce((sum, o) => sum + Number(o.total_price||0), 0);
  console.log('Legacy totalSpent:', totalSpent);
  const awardedPoints = Math.floor(totalSpent) * 5;

  const conn = await pool.getConnection();
  await conn.execute('UPDATE users SET points = points + ? WHERE user_id = ?', [awardedPoints, referredUser.user_id]);
  await conn.execute(
    'INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref) VALUES (?, ?, ?, ?)',
    [referredUser.user_id, 'purchase_points_award', awardedPoints, null]
  );
  conn.release();

  return { message: `Awarded ${awardedPoints} points to ${email}.`, referrerMessage: 'No referrer logic here' };
}

/********************************************************************
 * NEW: POST /api/referral/award-purchase
 * Handles a single order's reward
 ********************************************************************/
app.post('/api/referral/award-purchase', async (req, res) => {
  const { email, orderId, totalPrice } = req.body;
  if (!email || !orderId || totalPrice == null) {
    return res.status(400).json({ error: 'Email, orderId & totalPrice required' });
  }

  const conn = await pool.getConnection();
  try {
    const [users] = await conn.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!users.length) return res.status(404).json({ error: 'User not found' });
    const user = users[0];

    // Idempotency: skip if this order was already rewarded
    const [exists] = await conn.execute(
      `SELECT * FROM user_actions WHERE user_id = ? AND action_ref = ? AND action_type = 'purchase_points_award'`,
      [user.user_id, orderId]
    );
    if (exists.length) {
      return res.json({ message: 'Order already processed' });
    }

    const points = Math.floor(Number(totalPrice)) * 5;
    await conn.execute('UPDATE users SET points = points + ? WHERE user_id = ?', [points, user.user_id]);
    await conn.execute(
      `INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref)
       VALUES (?, 'purchase_points_award', ?, ?)`,
      [user.user_id, points, orderId]
    );

    // One-time referrer bonus
    let refMsg = 'No referrer';
    if (user.referred_by) {
      const [[referrer]] = await conn.execute(
        'SELECT * FROM users WHERE referral_code = ?', [user.referred_by]
      );
      if (referrer) {
        const [prior] = await conn.execute(
          `SELECT * FROM user_actions WHERE user_id = ? AND action_type = 'referral_purchase_award'`,
          [user.user_id]
        );
        if (!prior.length) {
          await conn.execute('UPDATE users SET points = points + 5 WHERE user_id = ?', [referrer.user_id]);
          await conn.execute(
            `INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref)
             VALUES (?, 'referral_purchase_award', 5, ?)`,
            [user.user_id, orderId]
          );
          refMsg = `Awarded 5 points to referrer ${referrer.email}`;
        } else {
          refMsg = 'Referrer already rewarded';
        }
      }
    }

    res.json({ message: `Awarded ${points} to purchaser ${email}`, referrerMessage: refMsg });
  } catch (err) {
    console.error('award-purchase error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
  }
});

/********************************************************************
 * POST /api/shopify/order-webhook
 * Unified webhook handler for order processing
 ********************************************************************/
app.post('/api/shopify/order-webhook', express.json(), async (req, res) => {
  const order = req.body;
  
  try {
    const email = order.email;
    const orderId = order.id;
    const totalPrice = order.total_price;
    const discountCodes = (order.discount_codes || []).map(dc => dc.code);
    const usedCode = discountCodes.find(code => code.startsWith('POINTS'));

    // 1. Award purchase points
    if (email && orderId != null && totalPrice != null) {
      console.log(`[Webhook] Processing order ${orderId} for ${email}`);
      
      await fetch('https://referral-program-448vr.kinsta.app/api/referral/award-purchase', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email, orderId, totalPrice })
      });
      
      // Also process referrer rewards (from the legacy code)
      const rewardResult = await rewardReferrerAfterPurchase(email, orderId);
      console.log('[Webhook] Reward response:', rewardResult);
    }

    // 2. Clean up used discount codes
    if (usedCode && email) {
      console.log(`[Webhook] Checking discount code: ${usedCode}`);
      
      const checkResponse = await fetch(`https://referral-program-448vr.kinsta.app/api/check-discount-used?code=${usedCode}`);
      const checkResult = await checkResponse.json();
      console.log(`[Webhook] Discount check result:`, checkResult);

      const shouldClear = checkResult.used || checkResult.error === 'Discount code not found in Shopify.';

      if (shouldClear) {
        const clearCodeRes = await fetch(`https://reviews-kettd.kinsta.app/api/referral/mark-discount-used`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email,
            usedCode: usedCode
          })
        });

        const clearResult = await clearCodeRes.json();
        console.log(`[Webhook] Code cleared:`, clearResult);
      }
    }

    res.status(200).send('OK');
    
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.status(500).send('Webhook failed');
  }
});

//TEST PURCHASE
app.post('/api/test-total-spent', async (req, res) => {
  const { orders } = req.body;

  if (!orders || !Array.isArray(orders)) {
    return res.status(400).json({ error: 'Missing or invalid orders array.' });
  }

  try {
    // Replicate your real logic
    const totalSpent = orders.reduce((sum, order) => {
      const price = parseFloat(order.total_price || 0);
      return sum + (isNaN(price) ? 0 : price);
    }, 0);

    const awardedPoints = Math.floor(totalSpent) * 5;

    return res.json({
      totalSpent,
      awardedPoints,
      message: `You would earn ${awardedPoints} points for $${totalSpent.toFixed(2)} spent.`
    });
  } catch (err) {
    console.error('Error testing totalSpent:', err);
    return res.status(500).json({ error: 'Server error during totalSpent calculation.' });
  }
});


//TEST IF CUSTOMER HAS ORDERS
app.post('/api/test-shopify-orders', async (req, res) => {
  const { shopifyCustomerId } = req.body;
  if (!shopifyCustomerId) return res.status(400).json({ error: 'Missing shopifyCustomerId' });

  const shop = 'hemlock-oak.myshopify.com';
  const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;

  try {
    const response = await fetch(`https://${shop}/admin/api/2023-07/orders.json?customer_id=${shopifyCustomerId}&status=any`, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    return res.json({
      totalOrders: data.orders?.length || 0,
      orders: data.orders
    });
  } catch (err) {
    console.error('Shopify order fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch Shopify orders' });
  }
});




/********************************************************************
 * POST /api/referral/award
 * Adds referral points for additional actions.
 * Expects { "email": "user@example.com", "action": "share" }
 * Currently, each action awards 5 points.
 ********************************************************************/
// Award once per action, idempotent, works for ALL actions
app.post('/api/referral/award', async (req, res) => {
  try {
    console.log('=== AWARD REFERRAL POINTS ===');
    const { email, action } = req.body;
    if (!email || !action) {
      return res.status(400).json({ error: 'Email and action are required.' });
    }
    
    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = users[0];

    // Duplicate check for ALL actions
    const [existingBonus] = await pool.execute(
      'SELECT * FROM user_actions WHERE user_id = ? AND action_type = ?',
      [user.user_id, action]
    );
    if (existingBonus.length > 0) {
      return res.status(400).json({ error: 'Points already claimed.' });
    }
    
    const pointsToAdd = 50;
    const newPoints = user.points + pointsToAdd;
    
    const updateSql = 'UPDATE users SET points = ? WHERE email = ?';
    await pool.execute(updateSql, [newPoints, email]);
    console.log('Award update result for', email);

    const insertActionSql =
      'INSERT INTO user_actions (user_id, action_type, points_awarded) VALUES (?, ?, ?)';
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




// POST /api/referral/shopify-id 
// Expects { "email": "user@example.com", "shopifyCustomerId": "gid://shopify/Customer/1234567890" }
app.post('/api/referral/shopify-id', async (req, res) => {
  try {
    const { email, shopifyCustomerId } = req.body;
    if (!email || !shopifyCustomerId) {
      return res.status(400).json({ error: 'Missing email or shopifyCustomerId.' });
    }

    // Update the shopify_customer_id in your users table
    const updateSql = `
      UPDATE users
      SET shopify_customer_id = ?
      WHERE email = ?
    `;
    const [result] = await pool.execute(updateSql, [shopifyCustomerId, email]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.json({ message: 'Shopify customer ID updated successfully.' });
  } catch (error) {
    console.error('Error updating Shopify customer ID:', error);
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
 * Endpoint using Shopify Admin API to remove discountcode from table if used.
 ********************************************************************/

app.get('/api/check-discount-used', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'Missing discount code.' });

  const shop = 'hemlock-oak.myshopify.com';
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  const query = `
    query codeDiscountNodeByCode($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        id
        codeDiscount {
          __typename
          ... on DiscountCodeBasic {
            shortSummary
            usageLimit
            usageCount
            codes(first: 5) {
              nodes {
                code
              }
            }
          }
        }
      }
    }
  `;

  const variables = { code };

  try {
    const response = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query, variables })
    });

    const result = await response.json();

    const node = result?.data?.codeDiscountNodeByCode;
    const discount = node?.codeDiscount;

    if (!discount) {
      return res.status(404).json({ error: 'Discount code not found in Shopify.' });
    }

    const usageCount = discount.usageCount || 0;
    const usageLimit = discount.usageLimit || 1;
    const used = usageCount >= usageLimit;

    // Always clear code from DB — find user first
    const connection = await pool.getConnection();
    
    const [users] = await connection.execute(
      'SELECT email FROM users WHERE last_discount_code = ?',
      [code]
    );
    
    if (users.length > 0) {
      const email = users[0].email;
    
      await connection.execute(
        'UPDATE users SET last_discount_code = NULL, discount_code_id = NULL WHERE email = ?',
        [email]
      );
    
      console.log(`[DB] Cleared discount fields for email: ${email}`);
    } else {
      console.warn(`[DB] No user found with code: ${code}`);
    }
    
    connection.release();



    return res.json({
      code,
      usageCount,
      usageLimit,
      used,
      action: used ? 'Code removed from DB' : 'Code still active'
    });

  } catch (err) {
    console.error('❌ Error checking discount code:', err);
    res.status(500).json({ error: 'Failed to check discount code.' });
  }
});


/********************************************************************
 * Start the server
 ********************************************************************/
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Referral Program API listening on port ${PORT}`);
  console.log(`Server started at: ${new Date().toISOString()}`);
});
