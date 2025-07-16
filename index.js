/********************************************************************
 * referral-server.js
 ********************************************************************/
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch'); // Ensure you've installed node-fetch (or use Node 18+ built-in fetch)
require('dotenv').config();   // Load environment variables from .env

const app = express();

/********************************************************************
 * Shopify Webhook Signature Verification
 ********************************************************************/
function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  const rawBody    = req.body.toString('utf8');
  const digest     = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  if (digest !== hmacHeader) {
    return res.status(401).send('🚫 Invalid Shopify webhook signature');
  }
  next();
}

/********************************************************************
 * Helper function to create a Klaviyo profile
 ********************************************************************/
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_LIST_ID = 'Vc2WdM';
async function createKlaviyoProfile(email, firstName) {
  const url = 'https://a.klaviyo.com/api/profiles';
  const payload = {
    data: { type: 'profile', attributes: { email, first_name: firstName } }
  };
  const revision = '2023-12-15';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'REVISION': revision
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errText = await res.text();
    try {
      const errJSON = JSON.parse(errText);
      if (errJSON.errors?.[0].code === 'duplicate_profile' && errJSON.errors[0].meta?.duplicate_profile_id) {
        return errJSON.errors[0].meta.duplicate_profile_id;
      }
    } catch {}
    throw new Error('Klaviyo create error: ' + errText);
  }
  return (await res.json()).data.id;
}

/********************************************************************
 * Helper function to add a Klaviyo profile to a list
 ********************************************************************/
async function addProfileToList(profileId) {
  const url = `https://a.klaviyo.com/api/lists/${KLAVIYO_LIST_ID}/relationships/profiles`;
  const payload = { data: [{ type: 'profile', id: profileId }] };
  const revision = '2023-12-15';
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'REVISION': revision
    },
    body: JSON.stringify(payload)
  });
}

async function subscribeToKlaviyoList(email, firstName) {
  try {
    const profileId = await createKlaviyoProfile(email, firstName);
    await addProfileToList(profileId);
    console.log(`Klaviyo profile ${profileId} added for ${email}`);
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
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));

/********************************************************************
 * Database connection pool
 ********************************************************************/
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

/********************************************************************
 * Helper to sync Smile.io points
 ********************************************************************/
async function updateLocalPoints(shopifyCustomerId, points) {
  const conn = await pool.getConnection();
  try {
    // Update the user's points
    await conn.execute(
      'UPDATE users SET points = ? WHERE shopify_customer_id = ?',
      [points, shopifyCustomerId]
    );
    // Log the sync action
    await conn.execute(
      `INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref)
       SELECT user_id, ?, ?, NULL FROM users WHERE shopify_customer_id = ?`,
      ['smile_points_sync', points, shopifyCustomerId]
    );
  } finally {
    conn.release();
  }
}

/********************************************************************
 * Initialize DB & tables
 ********************************************************************/
(async function initDb() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Connected to referral_program_db');
    await conn.execute(
      `CREATE TABLE IF NOT EXISTS users (
        user_id INT AUTO_INCREMENT PRIMARY KEY,
        shopify_customer_id VARCHAR(255) DEFAULT NULL,
        first_name VARCHAR(255) DEFAULT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        points INT DEFAULT 0,
        referral_code VARCHAR(50) UNIQUE,
        referred_by VARCHAR(50) DEFAULT NULL,
        last_discount_code VARCHAR(50) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );`
    );
    await conn.execute(
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
    conn.release();
  } catch (err) {
    console.error('DB init error:', err);
    process.exit(1);
  }
})();

/********************************************************************
 * Root route
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

    const [result] = await pool.execute(
      `INSERT INTO users 
        (first_name, email, points, referral_code, referred_by, shopify_customer_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [firstName, email, initialPoints, referralCode, referredBy || null, shopifyCustomerId || null]
    );

    subscribeToKlaviyoList(email, firstName);

    res.status(201).json({
      message: 'User signed up',
      userId: result.insertId,
      points: initialPoints,
      referralCode,
      referralUrl: `https://www.hemlockandoak.com/pages/email-signup/?ref=${referralCode}`
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'User exists' });
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

/********************************************************************
 * POST /api/referral/check-purchase (legacy)
 ********************************************************************/
app.post('/api/referral/check-purchase', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await rewardReferrerAfterPurchase(email);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/********************************************************************
 * rewardReferrerAfterPurchase (legacy)
 ********************************************************************/
async function rewardReferrerAfterPurchase(email) {
  const shop = 'hemlock-oak.myshopify.com';
  const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;

  const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  if (!users.length) return { error: 'User not found' };
  const user = users[0];

  const ordersRes = await fetch(
    `https://${shop}/admin/api/2023-07/orders.json?customer_id=${user.shopify_customer_id}&status=any`,
    { headers: { 'X-Shopify-Access-Token': accessToken } }
  );
  const ordersData = await ordersRes.json();
  if (!ordersData.orders?.length) return { message: 'No purchase yet.' };

  const totalSpent = ordersData.orders.reduce((sum, o) => sum + Number(o.total_price || 0), 0);
  const awardedPoints = Math.floor(totalSpent) * 5;

  const conn = await pool.getConnection();
  await conn.execute('UPDATE users SET points = points + ? WHERE user_id = ?', [awardedPoints, user.user_id]);
  await conn.execute(
    'INSERT INTO user_actions (user_id, action_type, points_awarded, action_ref) VALUES (?, ?, ?, ?)',
    [user.user_id, 'purchase_points_award', awardedPoints, null]
  );
  conn.release();

  return { message: `Awarded ${awardedPoints} points to ${email}.`, referrerMessage: 'No referrer logic here' };
}

/****************************************************************************
 * POST /api/referral/award-purchase (new)
 ****************************************************************************/
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

    // Idempotency
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
 * POST /api/shopify/order-webhook (purchase trigger)
 ********************************************************************/
app.post('/api/shopify/order-webhook', express.json(), async (req, res) => {
  const order = req.body;
  try {
    const email     = order.email;
    const orderId   = order.id;
    const totalPrice = order.total_price;
    if (email && orderId != null && totalPrice != null) {
      await fetch(
        `${process.env.APP_URL}/api/referral/award-purchase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, orderId, totalPrice })
        }
      );
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Order-webhook error:', err);
    res.sendStatus(500);
  }
});

/********************************************************************
 * POST /api/shopify/customers-update (Smile.io points sync)
 ********************************************************************/
app.post(
  '/api/shopify/customers-update',
  express.raw({ type: 'application/json' }),
  verifyShopifyWebhook,
  async (req, res) => {
    try {
      const customer = JSON.parse(req.body.toString('utf8'));
      const query = `
        query getSmilePoints($id: ID!) {
          customer(id: $id) {
            metafield(namespace: \"smile.io\", key: \"points\") {
              value
            }
          }
        }
      `;
      const response = await fetch(
        `https://${process.env.SHOPIFY_SHOP}/admin/api/2025-07/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
          },
          body: JSON.stringify({ query, variables: { id: customer.id } })
        }
      );
      const { data } = await response.json();
      const points = parseInt(data.customer.metafield.value, 10) || 0;
      await updateLocalPoints(customer.id, points);
      res.status(200).send('✅ Customer points synced');
    } catch (err) {
      console.error('customers-update webhook error:', err);
      res.status(500).send('❌ Internal error');
    }
  }
);

/********************************************************************
 * POST /api/referral/award
 ********************************************************************/
app.post('/api/referral/award', async (req, res) => {
  try {
    const { email, action } = req.body;
    if (!email || !action) return res.status(400).json({ error: 'Email and action are required.' });
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    const user = rows[0];
    if (action === 'social_media_follow') {
      const [exists] = await pool.execute(
        'SELECT * FROM user_actions WHERE user_id = ? AND action_type = ?',
        [user.user_id, action]
      );
      if (exists.length) return res.status(400).json({ error: 'Points already claimed.' });
    }
    const pointsToAdd = 5;
    await pool.execute('UPDATE users SET points = ? WHERE email = ?', [user.points + pointsToAdd, email]);
    await pool.execute(
      'INSERT INTO user_actions (user_id, action_type, points_awarded) VALUES (?, ?, ?)',
      [user.user_id, action, pointsToAdd]
    );
    res.json({ message: `Awarded ${pointsToAdd} points for action \"${action}\".`, newPoints: user.points + pointsToAdd });
  } catch (error) {
    console.error('Error in award endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

/********************************************************************
 * POST /api/referral/shopify-id
 ********************************************************************/
app.post('/api/referral/shopify-id', async (req, res) => {
  try {
    const { email, shopifyCustomerId } = req.body;
    if (!email || !shopifyCustomerId) return res.status(400).json({ error: 'Missing email or shopifyCustomerId.' });

    const [result] = await pool.execute(
      'UPDATE users SET shopify_customer_id = ? WHERE email = ?',
      [shopifyCustomerId, email]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ message: 'Shopify customer ID updated successfully.' });
  } catch (error) {
    console.error('Error updating Shopify customer ID:', error);
    res.status(500).json({ error: error.message });
  }
});

/********************************************************************
 * GET /api/referral/user/:email
 ********************************************************************/
app.get('/api/referral/user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) return res.status(400).json({ error: 'Missing email parameter.' });
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: rows[0] });
  } catch (error) {
    console.error('Error fetching referral info:', error);
    res.status(500).json({ error: error.message });
  }
});

/********************************************************************
 * Special debug endpoint
 ********************************************************************/
app.get('/api/debug/referral-user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const [[countRow]] = await pool.execute('SELECT COUNT(*) AS count FROM users WHERE email = ?', [email]);
    res.json({ received_email: email, timestamp: new Date().toISOString(), user_count: countRow.count });
  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

/********************************************************************
 * Endpoint: Check & clear discount code usage
 ********************************************************************/
app.get('/api/check-discount-used', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'Missing discount code.' });

    const shop = 'hemlock-oak.myshopify.com';
    const token = process.env.SHOPIFY_ADMIN_TOKEN;
    const query = `
      query codeDiscountNodeByCode($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          codeDiscount {
            __typename
            ... on DiscountCodeBasic {
              usageCount
              usageLimit
            }
          }
        }
      }
    `;
    const graphqlRes = await fetch(`https://$ {shop}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables: { code } })
    });
    const result = await graphqlRes.json();
    const usageCount = result.data.codeDiscountNodeByCode.codeDiscount.usageCount;
    const usageLimit = result.data.codeDiscountNodeByCode.codeDiscount.usageLimit;
    const used = usageCount >= usageLimit;

    const conn = await pool.getConnection();
    const [users] = await conn.execute('SELECT email FROM users WHERE last_discount_code = ?', [code]);
    if (users.length) {
      await conn.execute(
        'UPDATE users SET last_discount_code = NULL WHERE email = ?',
        [users[0].email]
      );
    }
    conn.release();

    res.json({ code, usageCount, usageLimit, used, action: used ? 'Code removed from DB' : 'Code still active' });
  } catch (err) {
    console.error('Error checking discount code:', err);
    res.status(500).json({ error: err.message });
  }
});

/********************************************************************
 * Start the server
 ********************************************************************/
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Referral Program API listening on port ${PORT}`);
});
