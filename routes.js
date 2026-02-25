/********************************************************************
 * routes.js
 * Express server and route handlers
 ********************************************************************/
const express = require('express');
const cors = require('cors');
const config = require('./config');
const repo = require('./repository');
const rewards = require('./rewards');

const app = express();

/********************************************************************
 * Middleware Setup
 ********************************************************************/
app.use(cors({
  origin(origin, cb) {
    if (!origin || config.CORS_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.urlencoded({ extended: true }));

// JSON parser with raw body preservation for webhook verification
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

/********************************************************************
 * Health Check Routes
 ********************************************************************/
app.get('/', (req, res) => {
  res.send('Referral Program API is up and running!');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
});

/********************************************************************
 * Referral Routes
 ********************************************************************/

// POST /api/referral/signup
app.post('/api/referral/signup', async (req, res) => {
  try {
    const { email, firstName, referredBy } = req.body;

    if (!email || !firstName) {
      return res.status(400).json({ error: 'First name and email are required.' });
    }

    const result = await rewards.processSignup({ email, firstName, referredBy });

    return res.status(201).json({
      message: referredBy
        ? 'User signed up successfully! Use your $15 discount code on your first purchase!'
        : 'User signed up successfully and awarded 5 points!',
      userId: result.userId,
      points: result.points,
      referralCode: result.referralCode,
      referralUrl: result.referralUrl,
      welcomeDiscountCode: result.welcomeDiscountCode
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'User already exists.' });
    }
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// POST /api/referral/award
app.post('/api/referral/award', async (req, res) => {
  try {
    const { email, action } = req.body;

    if (!email || !action) {
      return res.status(400).json({ error: 'Email and action are required.' });
    }

    const result = await rewards.processAwardPoints({ email, action });

    return res.json({
      message: `Awarded ${result.pointsAwarded} points for action "${action}".`,
      email,
      newPoints: result.newPoints
    });
  } catch (err) {
    if (err.message === 'Invalid action type') {
      return res.status(400).json({ error: err.message });
    }
    if (err.message === 'User not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message === 'Points already claimed for this action') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Award error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// GET /api/referral/user/:email
app.get('/api/referral/user/:email', async (req, res) => {
  try {
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({ error: 'Missing email parameter.' });
    }

    const user = await repo.findUserByEmail(email);

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.json({ user });
  } catch (err) {
    console.error('Fetch user error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// POST /api/referral/redeem
app.post('/api/referral/redeem', async (req, res) => {
  try {
    const { email, pointsToRedeem, redeemType, redeemValue } = req.body;

    if (!email || !pointsToRedeem) {
      return res.status(400).json({ error: 'Missing email or pointsToRedeem.' });
    }

    const result = await rewards.processRedeem({
      email,
      pointsToRedeem,
      redeemType,
      redeemValue
    });

    return res.json({
      message: 'Redeemed points successfully.',
      discountCode: result.discountCode,
      newPoints: result.newPoints
    });
  } catch (err) {
    if (err.message === 'User not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message === 'Not enough points to redeem') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Redeem error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/referral/cancel-redeem
app.post('/api/referral/cancel-redeem', async (req, res) => {
  try {
    const { email, pointsToRefund } = req.body;

    if (!email || !pointsToRefund) {
      return res.status(400).json({ error: 'Missing email or points to refund.' });
    }

    const result = await rewards.processCancelRedeem({ email, pointsToRefund });

    return res.json({ message: 'Points refunded.', newPoints: result.newPoints });
  } catch (err) {
    if (err.message === 'User not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message === 'No active discount to cancel') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Cancel redeem error:', err);
    return res.status(500).json({ error: 'Failed to refund points.' });
  }
});

// POST /api/referral/mark-discount-used
app.post('/api/referral/mark-discount-used', async (req, res) => {
  try {
    const { email, usedCode } = req.body;

    if (!email || !usedCode) {
      return res.status(400).json({ error: 'Missing email or usedCode.' });
    }

    await rewards.processMarkDiscountUsed({ email, usedCode });

    return res.json({ message: 'Discount removed from DB and deactivated in Shopify.' });
  } catch (err) {
    if (err.message === 'User with that code not found') {
      return res.status(404).json({ error: 'User with that code not found or code does not match.' });
    }
    console.error('Mark discount used error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/referral/create-welcome-discount
app.post('/api/referral/create-welcome-discount', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Missing email.' });
    }

    const result = await rewards.createWelcomeDiscount(email);

    return res.json({
      message: 'Welcome discount created successfully.',
      discountCode: result.discountCode,
      discountValue: result.discountValue
    });
  } catch (err) {
    console.error('Create welcome discount error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/referral/redeem-milestone
app.post('/api/referral/redeem-milestone', async (req, res) => {
  try {
    const { email, milestonePoints } = req.body;

    if (!email || !milestonePoints) {
      return res.status(400).json({ error: 'Invalid request.' });
    }

    const result = await rewards.processMilestoneRedeem({ email, milestonePoints });

    return res.json({
      message: 'Milestone redeemed!',
      rewardName: result.rewardName,
      discountCode: result.discountCode
    });
  } catch (err) {
    if (err.message === 'User not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('need') || err.message === 'Milestone already redeemed' || err.message === 'Invalid milestone') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Milestone redeem error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/********************************************************************
 * Shopify Webhook Routes
 ********************************************************************/

// POST /api/shopify/order-paid
app.post('/api/shopify/order-paid', async (req, res) => {
  try {
    // Verify webhook signature
    if (!rewards.verifyShopifyWebhook(req)) {
      console.log('Webhook verification failed');
      return res.status(401).json({ error: 'Unauthorized - invalid webhook signature' });
    }

    const order = req.body;
    const email = order.customer?.email || order.email;
    const orderTotal = parseFloat(order.total_price || order.subtotal_price || 0);
    const orderId = order.id || order.order_number;
    const discountCodes = order.discount_codes || [];

    console.log(`Order ${orderId}: ${email} spent $${orderTotal}`);

    if (!email) {
      return res.status(200).json({ message: 'No customer email, skipped' });
    }

    if (orderTotal <= 0) {
      return res.status(200).json({ message: 'Zero order total, skipped' });
    }

    const result = await rewards.processPurchase({
      email,
      orderTotal,
      orderId,
      discountCodes
    });

    if (result.skipped) {
      return res.status(200).json({ message: result.reason });
    }

    return res.status(200).json({
      success: true,
      email,
      orderId,
      pointsAwarded: result.pointsAwarded,
      newPoints: result.newPoints,
      isFirstPurchase: result.isFirstPurchase,
      referrerBonus: result.referrerBonus
    });
  } catch (err) {
    console.error('Webhook processing error:', err);
    // Return 200 to prevent Shopify retries
    return res.status(200).json({ error: 'Processing error', message: err.message });
  }
});

/********************************************************************
 * Test Routes (Protected)
 ********************************************************************/

// POST /api/referral/test-purchase
app.post('/api/referral/test-purchase', async (req, res) => {
  try {
    const providedSecret = req.body.secret || req.get('X-Test-Secret');

    if (!config.TEST_ENDPOINT_SECRET || providedSecret !== config.TEST_ENDPOINT_SECRET) {
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

    const user = await repo.findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: 'User not found. Please sign up first.' });
    }

    // Check if first purchase
    const existingPurchases = await repo.findPurchaseActions(user.user_id);
    const isFirstPurchase = existingPurchases.length === 0;

    // Calculate points
    const pointsToAdd = rewards.calculatePointsForPurchase(amount);
    const newPoints = user.points + pointsToAdd;

    // Update points
    await repo.updateUserPoints(email, newPoints);

    // Record action
    await repo.createAction({
      userId: user.user_id,
      actionType: 'test_purchase',
      pointsAwarded: pointsToAdd
    });

    // Process referral bonus if first purchase
    let referrerBonus = null;
    if (isFirstPurchase && user.referred_by) {
      referrerBonus = await rewards.processFirstPurchaseReferralBonus(user, 'test');
    }

    return res.json({
      message: `Test purchase successful! Awarded ${pointsToAdd} points for $${amount.toFixed(2)} order.`,
      email,
      orderTotal: amount,
      pointsAwarded: pointsToAdd,
      newPoints,
      isFirstPurchase,
      referrerBonus
    });
  } catch (err) {
    console.error('Test purchase error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// GET /api/debug/referral-user/:email
app.get('/api/debug/referral-user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const user = await repo.findUserByEmail(email);

    return res.json({
      received_email: email,
      timestamp: new Date().toISOString(),
      user_exists: !!user
    });
  } catch (err) {
    console.error('Debug endpoint error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

/********************************************************************
 * Review Routes (Judge.me Proxy)
 ********************************************************************/

// POST /api/submit-review
app.post('/api/submit-review', async (req, res) => {
  try {
    const result = await rewards.submitReview(req.body);
    return res.json(result);
  } catch (err) {
    console.error('Submit review error:', err.message);
    return res.status(500).json({ error: 'Failed to submit review', details: err.message });
  }
});

// GET /api/customer-reviews
app.get('/api/customer-reviews', async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: 'Customer email is required' });
    }

    const result = await rewards.fetchCustomerReviews(email);
    return res.json(result);
  } catch (err) {
    console.error('Fetch reviews error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch reviews', details: err.message });
  }
});

/********************************************************************
 * Server Initialization
 ********************************************************************/
async function startServer() {
  try {
    // Test database connection
    const serverTime = await repo.testConnection();
    console.log('Connected to Neon PostgreSQL database!');
    console.log('Server time:', serverTime);

    const tables = await repo.getTableList();
    console.log('Available tables:', tables);

    // Start Express server
    app.listen(config.PORT, () => {
      console.log(`Referral Program API listening on port ${config.PORT}`);
      console.log(`Server started at: ${new Date().toISOString()}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Start the server
startServer();

module.exports = app;
