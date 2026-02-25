/********************************************************************
 * judgeme-gateway.js
 * Judge.me API integration - product reviews
 ********************************************************************/
const axios = require('axios');
const config = require('./config');

/********************************************************************
 * Submit a Review
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

/********************************************************************
 * Fetch Customer Reviews
 ********************************************************************/
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
 * Exports
 ********************************************************************/
module.exports = {
  submitReview,
  fetchCustomerReviews
};
