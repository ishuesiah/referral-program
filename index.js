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
// console.log('KLAVIYO_API_KEY:', process.env.KLAVIYO_API_KEY);

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
      attributes: {
        email: email,
        first_name: firstName
      }
    }
  };

  // Use a fixed revision date per Klaviyo documentation
  const revisionHeader = '2023-12-15'; // Update this as required by Klaviyo's docs

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
      // If the profile already exists, Klaviyo returns a 409 with duplicate_profile error code.
      if (errorJSON.errors &&
          errorJSON.errors[0].code === "duplicate_profile" &&
          errorJSON.errors[0].meta &&
          errorJSON.errors[0].meta.duplicate_profile_id) {
        console.log("Profile already exists. Using duplicate profile id: " + errorJSON.errors[0].meta.duplicate_profile_id);
        return errorJSON.errors[0].meta.duplicate_profile_id;
      }
    } catch (e) {
      // If parsing fails, fall through.
    }
    throw new Error('Klaviyo create profile error: ' + errorText);
  }
  const result = await response.json();
  return result.data.id;
}

/********************************************************************
 * Helper function to add an existing Klaviyo profile to a list
 ********************************************************************/
async function addProfileToList(klaviyoProfileId, email) {
  const klaviyoUrl = `https://a.klaviyo.com/api/lists/${KLAVIYO_LIST_ID}/relationships/profiles`;
  const payload = {
    data: [
      {
        type: "profile",
        id: klaviyoProfileId
      }
    ]
  };

  const revisionHeader = '2023-12-15'; // Use the valid revision date per documentation

  const response = await fetch(klaviyoUrl, {
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
    console.error('Klaviyo add-to-list error:', errorText);
  } else {
    console.log(`Successfully added ${email} (profile id: ${klaviyoProfileId}) to Klaviyo list ${KLAVIYO_LIST_ID}.`);
  }
}

/********************************************************************
 * Combined function to ensure the profile exists and is added to the list
 ********************************************************************/
async function subscribeToKlaviyoList(email, firstName) {
  let klaviyoProfileId;
  try {
    // Try to create the profile first. If it already exists, the duplicate id is returned.
    klaviyoProfileId = await createKlaviyoProfile(email, firstName);
    console.log(`Created or retrieved Klaviyo profile with id: ${klaviyoProfileId}`);
  } catch (error) {
    console.error('Error creating Klaviyo profile:', error);
    return;
  }
  // Now add the profile to the list using the obtained profile id
  await addProfileToList(klaviyoProfileId, email);
}

/********************************************************************
 * Referral code generator
 ********************************************************************/
function generateReferralCode() {
  // Generates a 6-character referral code
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

    // Create the "users" table with a new column for Shopify customer ID
    const createUsersTableQuery = 
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
      );`;
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
 * Expects { "email": "user@example.com", "firstName": "John", "referredBy": "ABC123", "shopifyCustomerId": "12345" }
 * Awards 5 points on signup and (optionally) 5 points to the referrer if referredBy is valid.
 * Also subscribes the new user to Klaviyo.
 ********************************************************************/
app.post('/api/referral/signup', async (req, res) => {
  try {
    console.log('=== REFERRAL SIGNUP ===');
    const { email, firstName, referredBy, shopifyCustomerId } = req.body;
    
    if (!email || !firstName) {
      return res.status(400).json({ error: 'First name and email are required.' });
    }
    
    // Generate a unique referral code for the new user
    const referralCode = generateReferralCode();
    const initialPoints = 5;
    
    // If a referral code was provided, try to find the original user and award them 5 points
if (referredBy) {
  console.log(`Referred by ${referredBy}, will track purchase-based reward.`);
}

    
    // Insert the new user including the shopify_customer_id (if provided)
    const sql = `
      INSERT INTO users (first_name, email, points, referral_code, referred_by, shopify_customer_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const [result] = await pool.execute(sql, [firstName, email, initialPoints, referralCode, referredBy || null, shopifyCustomerId || null]);
    console.log('Signup insert result:', result);
    
    // Subscribe the new user to Klaviyo (create profile & add to list)
    subscribeToKlaviyoList(email, firstName)
      .catch(err => {
        console.error('Klaviyo subscription error:', err);
      });
    
    // Construct the referral URL for the new user
    const referralUrl = `https://www.hemlockandoak.com/pages/email-signup/?ref=${referralCode}`;
    
    return res.status(201).json({
      message: 'User signed up successfully!',
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

app.post('/api/referral/check-purchase', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  try {
    const result = await rewardReferrerAfterPurchase(email);
    return res.json(result);
  } catch (err) {
    console.error('Error checking referral purchase:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});


async function rewardReferrerAfterPurchase(email) {
  const shop = 'hemlock-oak.myshopify.com';
  const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;

  // Step 1: Lookup referred user
  const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  if (users.length === 0) return { error: 'User not found.' };

  const referredUser = users[0];

  if (!referredUser.referred_by) {
    return { message: 'User was not referred.' };
  }

  // Step 2: Check if this referral was already rewarded (you could track this in user_actions)
  const [existingActions] = await pool.execute(`
    SELECT * FROM user_actions
    WHERE user_id = ? AND action_type = 'referral_purchase_award'
  `, [referredUser.user_id]);

  if (existingActions.length > 0) {
    return { message: 'Referral already rewarded.' };
  }

  // Step 3: Query Shopify orders using stored shopify_customer_id
  const customerId = referredUser.shopify_customer_id;
  const ordersRes = await fetch(`https://${shop}/admin/api/2023-07/orders.json?customer_id=${customerId}&status=any`, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json'
    }
  });
  const ordersData = await ordersRes.json();
  if (!ordersData.orders || ordersData.orders.length === 0) {
    return { message: 'No purchase yet.' };
  }

  // Step 4: Award the referrer points
  const [referrerRows] = await pool.execute('SELECT * FROM users WHERE referral_code = ?', [referredUser.referred_by]);
  if (referrerRows.length === 0) return { error: 'Referrer not found.' };
  const referrer = referrerRows[0];

  const newPoints = referrer.points + 5;
  await pool.execute('UPDATE users SET points = ? WHERE user_id = ?', [newPoints, referrer.user_id]);

  // Step 5: Log the action
  await pool.execute(`INSERT INTO user_actions (user_id, action_type, points_awarded) VALUES (?, 'referral_purchase_award', 5)`, [referredUser.user_id]);

  return { message: `Awarded 5 points to referrer ${referrer.email}.` };
  console.log(`✅ Awarded referrer ${referrer.email} 5 points for purchase by ${email}`);

}


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
    
    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = users[0];

    if (action === 'social_media_follow') {
      const [existingBonus] = await pool.execute(
        'SELECT * FROM user_actions WHERE user_id = ? AND action_type = ?',
        [user.user_id, action]
      );
      if (existingBonus.length > 0) {
        return res.status(400).json({ error: 'Points already claimed.' });
      }
    }
    
    const pointsToAdd = 5;
    const newPoints = user.points + pointsToAdd;
    
    const updateSql = `UPDATE users SET points = ? WHERE email = ?`;
    await pool.execute(updateSql, [newPoints, email]);
    console.log('Award update result for', email);

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
 * Check if discount code used
 ********************************************************************/

app.post('/api/shopify/order-webhook', express.json(), async (req, res) => {
  const order = req.body;

  try {
    const email = order.email;
    const discountCodes = (order.discount_codes || []).map(dc => dc.code);
    const usedCode = discountCodes.find(code => code.startsWith('POINTS'));

    // ✅ Always trigger reward logic based on email
    if (email) {
      console.log(`[Webhook] Checking purchase for ${email}`);

      const rewardRes = await fetch('https://referral-program-448vr.kinsta.app/api/referral/check-purchase', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email })
      });

      const rewardResult = await rewardRes.json();
      console.log(`[Webhook] Reward response:`, rewardResult);
    }

    // ✅ Optional: still check & clean up discount code
    if (usedCode) {
      const checkResponse = await fetch(`https://referral-program-448vr.kinsta.app/api/check-discount-used?code=${usedCode}`);
      const checkResult = await checkResponse.json();
      console.log(`[Webhook] Discount check result:`, checkResult);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.status(500).send('Webhook failed');
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

    // Optionally remove from DB
    if (used) {
      const connection = await pool.getConnection();
      await connection.execute(
        'UPDATE users SET last_discount_code = NULL WHERE last_discount_code = ?',
        [code]
      );
      connection.release();
    }

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
