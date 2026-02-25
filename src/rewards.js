/********************************************************************
 * rewards.js
 * Business logic layer - all referral program functions
 ********************************************************************/
const crypto = require('crypto');
const repo = require('./repository');
const config = require('./config');

// Import gateways
const shopify = require('./gateways/shopify');
const klaviyo = require('./gateways/klaviyo');
const judgeme = require('./gateways/judgeme');

/********************************************************************
 * Utility Functions
 ********************************************************************/
function generateReferralCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function getTierForSpent(totalSpent) {
  const tiers = config.TIERS;
  // Find the highest tier the customer qualifies for
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (totalSpent >= tiers[i].minSpent) {
      return tiers[i];
    }
  }
  return tiers[0]; // Default to Bronze
}

function calculatePointsForPurchase(orderTotal, totalSpent = 0) {
  const tier = getTierForSpent(totalSpent);
  return Math.floor(orderTotal * tier.pointsPerDollar);
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
  klaviyo.subscribeToList(email, firstName).catch(err => {
    console.error('Klaviyo subscription error:', err);
  });

  // Create welcome discount if referred
  let welcomeDiscountCode = null;
  if (referredBy) {
    try {
      const discount = await shopify.createDiscountCode('15', 0);
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
  const { code, discountId } = await shopify.createDiscountCode(redeemValue, pointsToRedeem);

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
      await shopify.deactivateDiscount(user.discount_code_id);
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
      await shopify.deactivateDiscount(user.discount_code_id);
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

  // Get customer's total spent from Shopify for tier calculation
  const totalSpent = await shopify.getCustomerTotalSpent(email);
  const tier = getTierForSpent(totalSpent);

  // Calculate and award points based on tier
  const pointsToAdd = calculatePointsForPurchase(orderTotal, totalSpent);
  const newPoints = user.points + pointsToAdd;

  console.log(`Purchase: ${email} | Tier: ${tier.name} | Spent: $${totalSpent} | Order: $${orderTotal} | Points: ${pointsToAdd}`);

  // Update user's tier and total_spent in database
  await repo.updateUserTier(user.user_id, tier.name, totalSpent);

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
    referrerBonus,
    tier: tier.name,
    totalSpent,
    pointsPerDollar: tier.pointsPerDollar
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
  const { code: discountCode } = await shopify.createDiscountCode('100', 0, {
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
  const { code, discountId } = await shopify.createDiscountCode('15', 0);

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
  getTierForSpent,
  buildReferralUrl,

  // Gateway re-exports (for backwards compatibility)
  verifyShopifyWebhook: shopify.verifyWebhook,
  getShopifyCustomerTotalSpent: shopify.getCustomerTotalSpent,
  createShopifyDiscountCode: shopify.createDiscountCode,
  deactivateShopifyDiscount: shopify.deactivateDiscount,
  subscribeToKlaviyo: klaviyo.subscribeToList,
  submitReview: judgeme.submitReview,
  fetchCustomerReviews: judgeme.fetchCustomerReviews,

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
