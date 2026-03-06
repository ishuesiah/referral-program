/********************************************************************
 * klaviyo-gateway.js
 * Klaviyo API integration - email list subscriptions & events
 ********************************************************************/
const fetch = require('node-fetch');
const config = require('../config');

/********************************************************************
 * Subscribe to Email List
 ********************************************************************/
async function subscribeToList(email, firstName) {
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
 * Track Event (for flows/automations)
 ********************************************************************/
async function trackEvent(email, eventName, properties = {}) {
  const trackUrl = 'https://a.klaviyo.com/api/track';

  const payload = {
    token: config.KLAVIYO_PUBLIC_KEY,
    event: eventName,
    customer_properties: {
      $email: email
    },
    properties: properties
  };

  try {
    const response = await fetch(trackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Klaviyo track event error (${eventName}):`, errorText);
      return false;
    }

    console.log(`Klaviyo event tracked: ${eventName} for ${email}`);
    return true;
  } catch (err) {
    console.error(`Klaviyo track event failed (${eventName}):`, err.message);
    return false;
  }
}

/********************************************************************
 * Track Tier Upgrade Event
 ********************************************************************/
async function trackTierUpgrade(email, firstName, previousTier, newTier, totalSpent, currentPoints) {
  const tierBenefits = {
    Silver: {
      pointsPerDollar: 5,
      perks: ['Early access to new releases', 'Member-only promotions']
    },
    Gold: {
      pointsPerDollar: 7,
      perks: ['7 points per $1 spent', 'Early access to new releases', 'Exclusive Gold member discounts']
    },
    VIP: {
      pointsPerDollar: 10,
      perks: ['10 points per $1 spent', 'Free shipping on orders over $50', 'VIP-only products', 'Priority support']
    }
  };

  const benefits = tierBenefits[newTier] || {};

  return trackEvent(email, 'Tier Upgrade', {
    first_name: firstName,
    previous_tier: previousTier,
    new_tier: newTier,
    total_spent: totalSpent,
    current_points: currentPoints,
    points_per_dollar: benefits.pointsPerDollar || 5,
    tier_perks: benefits.perks || []
  });
}

/********************************************************************
 * Exports
 ********************************************************************/
module.exports = {
  subscribeToList,
  trackEvent,
  trackTierUpgrade
};
