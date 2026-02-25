/********************************************************************
 * rewards.js
 * Business logic layer - all referral program functions
 ********************************************************************/
const crypto = require('crypto');
const fetch = require('node-fetch');
const axios = require('axios');
const repo = require('./repository');
const config = require('./config');

/********************************************************************
 * Utility Functions
 ********************************************************************/
function generateReferralCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function calculatePointsForPurchase(orderTotal) {
  return Math.floor(orderTotal * config.POINTS_PER_DOLLAR);
}

function buildReferralUrl(referralCode) {
  return `${config.STORE_URL}/pages/email-signup/?ref=${referralCode}`;
}

function parseDiscountTierFromCode(code) {
  const tierMatch = code.match(/POINTS(\d+(?:\.\d+)?)CAD_/);
  if (tierMatch) {
    const dollarValue = parseFloat(tierMatch[1]);
    return dollarValue * 100; // Convert to points
  }
  return null;
}

/********************************************************************
 * Shopify Webhook Verification
 ********************************************************************/
function verifyShopifyWebhook(req) {
  if (!config.SHOPIFY_WEBHOOK_SECRET) {
    console.warn('WARNING: SHOPIFY_WEBHOOK_SECRET not set - webhook verification disabled');
    return true;
  }

  const hmacHeader = req.get('X-Shopify-Hmac-SHA256');
  if (!hmacHeader) {
    return false;
  }

  const hash = crypto
    .createHmac('sha256', config.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

/********************************************************************
 * Klaviyo Integration
 ********************************************************************/
async function subscribeToKlaviyo(email, firstName) {
  const klaviyoUrl = `https://a.klaviyo.com/api/v2/list/${config.KLAVIYO_LIST_ID}/subscribe?api_key=${config.KLAVIYO_API_KEY}`;

  const payload = {
    profiles: [{ email, first_name: firstName }]
  };

  const response = await fetch(klaviyoUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Klaviyo subscription error:', errorText);
    return false;
  }

  console.log(`Successfully subscribed ${email} to Klaviyo list.`);
  return true;
}

/********************************************************************
 * Shopify Discount Code Functions
 ********************************************************************/
async function createShopifyDiscountCode(amountOff, pointsToRedeem, options = {}) {
  const rewardType = options.rewardType || 'fixed_amount';
  let generatedCode = '';
  let variables = {};
  let title = '';

  if (rewardType === 'free_product') {
    if (!options.collectionId) {
      throw new Error('Missing collectionId for free collection reward');
    }

    generatedCode = `MILESTONEFREE_${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    title = `Free Collection Reward (${generatedCode})`;

    variables = {
      basicCodeDiscount: {
        title,
        code: generatedCode,
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: {
          value: { percentage: 1.0 },
          items: {
            collections: { add: [options.collectionId] }
          }
        },
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: false,
          shippingDiscounts: true
        },
        usageLimit: 1,
        appliesOncePerCustomer: true
      }
    };
  } else {
    const numericValue = amountOff === 'dynamic'
      ? (pointsToRedeem / 100).toFixed(2)
      : parseFloat(String(amountOff).replace(/\D/g, '')) || 5;

    generatedCode = `POINTS${numericValue}CAD_${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    title = `$${numericValue} Off Points Reward`;

    variables = {
      basicCodeDiscount: {
        title,
        code: generatedCode,
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: {
          value: {
            discountAmount: {
              amount: numericValue,
              appliesOnEachItem: false
            }
          },
          items: { all: true }
        },
        combinesWith: {
          orderDiscounts: true,
          productDiscounts: true,
          shippingDiscounts: true
        },
        usageLimit: 1,
        appliesOncePerCustomer: true
      }
    };
  }

  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const response = await fetch(config.SHOPIFY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query: mutation, variables })
  });

  const result = await response.json();

  if (result.errors || result.data?.discountCodeBasicCreate?.userErrors?.length > 0) {
    console.error('Discount creation error:', JSON.stringify(result, null, 2));
    throw new Error('Failed to create discount code');
  }

  const discountData = result.data.discountCodeBasicCreate.codeDiscountNode;
  return {
    code: discountData.codeDiscount.codes.nodes[0].code,
    discountId: discountData.id.replace('DiscountCodeNode', 'DiscountCodeBasic')
  };
}

async function deactivateShopifyDiscount(discountId) {
  // Step 1: Get the discount's startsAt
  const query = `
    query getDiscount($id: ID!) {
      codeDiscountNode(id: $id) {
        codeDiscount {
          ... on DiscountCodeBasic { startsAt }
        }
      }
    }
  `;

  const queryResponse = await fetch(config.SHOPIFY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables: { id: discountId } })
  });

  const queryResult = await queryResponse.json();
  const startsAt = queryResult.data?.codeDiscountNode?.codeDiscount?.startsAt;

  if (!startsAt) {
    throw new Error('Could not retrieve startsAt for discount');
  }

  // Step 2: Set endsAt to expire the discount
  const endsAt = new Date(new Date(startsAt).getTime() + 60 * 1000).toISOString();

  const mutation = `
    mutation discountCodeBasicUpdate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }
  `;

  const response = await fetch(config.SHOPIFY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({
      query: mutation,
      variables: { id: discountId, basicCodeDiscount: { endsAt } }
    })
  });

  const result = await response.json();
  const userErrors = result.data?.discountCodeBasicUpdate?.userErrors || [];

  if (userErrors.length > 0) {
    throw new Error(userErrors[0].message || 'Failed to deactivate discount');
  }

  console.log('Successfully deactivated discount code');
  return true;
}

/********************************************************************
 * Judge.me Review Functions
 ********************************************************************/
async function submitReview(reviewData) {
  const payload = {
    ...reviewData,
    api_token: config.JUDGEME_API_TOKEN,
    shop_domain: config.SHOP_DOMAIN,
    platform: 'shopify'
  };

  const response = await axios.post('https://judge.me/api/v1/reviews', payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  return response.data;
}

async function fetchCustomerReviews(email) {
  const response = await axios.get('https://judge.me/api/v1/reviews', {
    params: {
      api_token: config.JUDGEME_API_TOKEN,
      shop_domain: config.SHOP_DOMAIN,
      platform: 'shopify',
      reviewer_email: email
    }
  });

  return response.data;
}

/********************************************************************
 * Core Business Logic Functions
 ********************************************************************/
async function processSignup({ email, firstName, referredBy }) {
  const referralCode = generateReferralCode();

  // Award referrer bonus if referred
  if (referredBy) {
    const referrer = await repo.findUserByReferralCode(referredBy);
    if (referrer) {
      await repo.addPointsByReferralCode(referredBy, config.REFERRER_SIGNUP_BONUS);
      console.log(`Awarded ${config.REFERRER_SIGNUP_BONUS} bonus points to referrer ${referredBy}`);
    }
  }

  // Create the new user
  const result = await repo.createUser({
    firstName,
    email,
    points: config.SIGNUP_POINTS,
    referralCode,
    referredBy
  });

  // Subscribe to Klaviyo (non-blocking)
  subscribeToKlaviyo(email, firstName).catch(err => {
    console.error('Klaviyo subscription error:', err);
  });

  // Create welcome discount if referred
  let welcomeDiscountCode = null;
  if (referredBy) {
    try {
      const discount = await createShopifyDiscountCode('15', 0);
      welcomeDiscountCode = discount.code;
    } catch (err) {
      console.error('Failed to create welcome discount:', err);
    }
  }

  return {
    userId: result.user_id,
    points: config.SIGNUP_POINTS,
    referralCode,
    referralUrl: buildReferralUrl(referralCode),
    welcomeDiscountCode
  };
}

async function processAwardPoints({ email, action }) {
  if (!config.ALLOWED_ACTIONS[action]) {
    throw new Error('Invalid action type');
  }

  const user = await repo.findUserByEmail(email);
  if (!user) {
    throw new Error('User not found');
  }

  // Check if action already claimed
  const existingAction = await repo.findActionByUserAndType(user.user_id, action);
  if (existingAction) {
    throw new Error('Points already claimed for this action');
  }

  const pointsToAdd = config.ALLOWED_ACTIONS[action];
  const newPoints = user.points + pointsToAdd;

  await repo.updateUserPoints(email, newPoints);
  await repo.createAction({
    userId: user.user_id,
    actionType: action,
    pointsAwarded: pointsToAdd
  });

  return { pointsAwarded: pointsToAdd, newPoints };
}

async function processRedeem({ email, pointsToRedeem, redeemType, redeemValue }) {
  const user = await repo.findUserByEmail(email);
  if (!user) {
    throw new Error('User not found');
  }

  if (user.points < pointsToRedeem) {
    throw new Error('Not enough points to redeem');
  }

  const newPoints = user.points - pointsToRedeem;

  // Deduct points first
  await repo.updateUserPointsById(user.user_id, newPoints);

  // Log the redemption
  await repo.createAction({
    userId: user.user_id,
    actionType: `redeem-${redeemType || 'discount'}`,
    pointsAwarded: -pointsToRedeem
  });

  // Create discount code
  const { code, discountId } = await createShopifyDiscountCode(redeemValue, pointsToRedeem);

  // Save discount code to user
  await repo.updateUserDiscountCode(user.user_id, code, discountId, newPoints);

  return { discountCode: code, newPoints };
}

async function processCancelRedeem({ email, pointsToRefund }) {
  const user = await repo.findUserByEmail(email);
  if (!user) {
    throw new Error('User not found');
  }

  if (!user.last_discount_code) {
    throw new Error('No active discount to cancel');
  }

  // Deactivate discount in Shopify
  if (user.discount_code_id) {
    try {
      await deactivateShopifyDiscount(user.discount_code_id);
    } catch (err) {
      console.error('Failed to deactivate Shopify discount:', err.message);
    }
  }

  // Refund points
  const newPoints = user.points + parseInt(pointsToRefund, 10);
  await repo.updateUserPoints(email, newPoints);
  await repo.clearUserDiscountCode(email);

  return { newPoints };
}

async function processMarkDiscountUsed({ email, usedCode }) {
  const user = await repo.findUserByEmailAndDiscountCode(email, usedCode);
  if (!user) {
    throw new Error('User with that code not found');
  }

  // Clear discount from DB
  await repo.clearUserDiscountCode(email);

  // Deactivate in Shopify
  if (user.discount_code_id) {
    try {
      await deactivateShopifyDiscount(user.discount_code_id);
    } catch (err) {
      console.error('Failed to deactivate Shopify discount:', err.message);
    }
  }

  return { success: true };
}

async function processFirstPurchaseReferralBonus(user, orderId) {
  if (!user.referred_by) {
    return null;
  }

  const referrer = await repo.findUserByReferralCode(user.referred_by);
  if (!referrer) {
    return null;
  }

  const referrerNewPoints = referrer.points + config.REFERRAL_BONUS_POINTS;

  // Update referrer points
  await repo.updateUserPointsById(referrer.user_id, referrerNewPoints);

  // Increment referral count
  await repo.incrementReferralCount(referrer.user_id);

  // Record the bonus action
  await repo.createAction({
    userId: referrer.user_id,
    actionType: 'referral_first_purchase_bonus',
    pointsAwarded: config.REFERRAL_BONUS_POINTS,
    actionRef: `referral_${user.user_id}_order_${orderId}`
  });

  console.log(`Referral bonus: ${referrer.email} awarded ${config.REFERRAL_BONUS_POINTS} points`);

  return {
    referrerEmail: referrer.email,
    bonusPoints: config.REFERRAL_BONUS_POINTS,
    referrerNewPoints
  };
}

async function processPurchase({ email, orderTotal, orderId, discountCodes = [] }) {
  const user = await repo.findUserByEmail(email);
  if (!user) {
    return { skipped: true, reason: 'User not in referral program' };
  }

  // Check for duplicate order
  const existingOrder = await repo.findActionByUserAndRef(user.user_id, `order_${orderId}`);
  if (existingOrder) {
    return { skipped: true, reason: 'Order already processed' };
  }

  // Check if first purchase
  const existingPurchases = await repo.findPurchaseActions(user.user_id);
  const isFirstPurchase = existingPurchases.length === 0;

  // Calculate and award points
  const pointsToAdd = calculatePointsForPurchase(orderTotal);
  const newPoints = user.points + pointsToAdd;

  await repo.updateUserPoints(email, newPoints);
  await repo.createAction({
    userId: user.user_id,
    actionType: 'shopify_purchase',
    pointsAwarded: pointsToAdd,
    actionRef: `order_${orderId}`
  });

  // Process used discount codes
  for (const discount of discountCodes) {
    const code = discount.code;
    if (code && (code.startsWith('POINTS') || code.startsWith('MILESTONEFREE_'))) {
      await processUsedDiscountCode(code);
    }
  }

  // Process referral bonus if first purchase
  let referrerBonus = null;
  if (isFirstPurchase) {
    referrerBonus = await processFirstPurchaseReferralBonus(user, orderId);
  }

  return {
    pointsAwarded: pointsToAdd,
    newPoints,
    isFirstPurchase,
    referrerBonus
  };
}

async function processUsedDiscountCode(code) {
  const usedTier = parseDiscountTierFromCode(code);
  const discountUser = await repo.findUserByDiscountCode(code);

  if (discountUser) {
    await repo.clearUserDiscountCodeById(discountUser.user_id);
    console.log(`Marked discount code ${code} as used for user ${discountUser.email}`);

    if (usedTier) {
      await repo.createAction({
        userId: discountUser.user_id,
        actionType: 'discount_tier_used',
        pointsAwarded: 0,
        actionRef: `tier_${usedTier}`
      });
    }
  }
}

async function processMilestoneRedeem({ email, milestonePoints }) {
  const reward = config.MILESTONE_REWARDS[milestonePoints];
  if (!reward) {
    throw new Error('Invalid milestone');
  }

  const user = await repo.findUserByEmail(email);
  if (!user) {
    throw new Error('User not found');
  }

  // Check referral count
  if ((user.referral_count || 0) < milestonePoints) {
    throw new Error(`You need ${milestonePoints} referrals to unlock this reward`);
  }

  // Parse previously redeemed milestones
  let redeemedMilestones = {};
  if (user.referal_discount_code) {
    try {
      redeemedMilestones = JSON.parse(user.referal_discount_code);
    } catch (err) {
      console.warn('Could not parse referal_discount_code:', err.message);
    }
  }

  if (redeemedMilestones[milestonePoints]) {
    throw new Error('Milestone already redeemed');
  }

  // Create discount code
  const { code: discountCode } = await createShopifyDiscountCode('100', 0, {
    rewardType: 'free_product',
    collectionId: reward.collectionId
  });

  // Save redeemed milestone
  redeemedMilestones[milestonePoints] = discountCode;
  await repo.updateMilestoneDiscountCodes(user.user_id, JSON.stringify(redeemedMilestones));

  return {
    rewardName: reward.name,
    discountCode
  };
}

async function createWelcomeDiscount(email) {
  const { code, discountId } = await createShopifyDiscountCode('15', 0);

  // Log action if user exists
  const user = await repo.findUserByEmail(email);
  if (user) {
    await repo.createAction({
      userId: user.user_id,
      actionType: 'referral_welcome_discount',
      pointsAwarded: 0
    });
  }

  return { discountCode: code, discountValue: '$15 off' };
}

/********************************************************************
 * Exports
 ********************************************************************/
module.exports = {
  // Utilities
  generateReferralCode,
  calculatePointsForPurchase,
  buildReferralUrl,
  verifyShopifyWebhook,

  // External Services
  subscribeToKlaviyo,
  createShopifyDiscountCode,
  deactivateShopifyDiscount,
  submitReview,
  fetchCustomerReviews,

  // Core Business Logic
  processSignup,
  processAwardPoints,
  processRedeem,
  processCancelRedeem,
  processMarkDiscountUsed,
  processPurchase,
  processFirstPurchaseReferralBonus,
  processMilestoneRedeem,
  createWelcomeDiscount
};
