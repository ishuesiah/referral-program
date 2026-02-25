/********************************************************************
 * klaviyo-gateway.js
 * Klaviyo API integration - email list subscriptions
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
 * Exports
 ********************************************************************/
module.exports = {
  subscribeToList
};
