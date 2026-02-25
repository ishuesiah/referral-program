/********************************************************************
 * config.js
 * Centralized configuration and constants
 ********************************************************************/
require('dotenv').config();

module.exports = {
  /********************************************************************
   * Server Configuration
   ********************************************************************/
  PORT: process.env.PORT || 3001,

  /********************************************************************
   * Store Configuration
   ********************************************************************/
  STORE_URL: 'https://www.hemlockandoak.com',
  SHOP_DOMAIN: process.env.SHOP_DOMAIN || 'hemlock-oak.myshopify.com',

  /********************************************************************
   * Shopify API
   ********************************************************************/
  SHOPIFY_GRAPHQL_URL: `https://${process.env.SHOP_DOMAIN || 'hemlock-oak.myshopify.com'}/admin/api/2025-04/graphql.json`,
  SHOPIFY_ADMIN_TOKEN: process.env.SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET,

  /********************************************************************
   * Klaviyo
   ********************************************************************/
  KLAVIYO_API_KEY: process.env.KLAVIYO_API_KEY,
  KLAVIYO_LIST_ID: process.env.KLAVIYO_LIST_ID || 'Vc2WdM',

  /********************************************************************
   * Judge.me
   ********************************************************************/
  JUDGEME_API_TOKEN: process.env.JUDGEME_API_TOKEN,

  /********************************************************************
   * Security
   ********************************************************************/
  TEST_ENDPOINT_SECRET: process.env.TEST_ENDPOINT_SECRET,

  /********************************************************************
   * Points Configuration
   ********************************************************************/
  SIGNUP_POINTS: 5,
  REFERRER_SIGNUP_BONUS: 5,
  REFERRAL_BONUS_POINTS: 1500,  // $15 worth (awarded when referred user makes first purchase)
  POINTS_PER_DOLLAR: 5,

  /********************************************************************
   * Allowed Actions for Point Awards
   ********************************************************************/
  ALLOWED_ACTIONS: {
    'social_media_follow': 50,
    'community_join': 50,
    'facebook_like': 50,
    'youtube_subscribe': 50,
    'share': 5,
    'instagram': 5,
    'fb': 5,
    'bonus': 5
  },

  /********************************************************************
   * Milestone Rewards (Referral Count -> Reward)
   ********************************************************************/
  MILESTONE_REWARDS: {
    5: {
      name: 'Free Notebook',
      collectionId: 'gid://shopify/Collection/410265616628'
    },
    10: {
      name: 'Free Planner',
      collectionId: 'gid://shopify/Collection/423756136692'
    },
    15: {
      name: 'Free Planner',
      collectionId: 'gid://shopify/Collection/423756136692'
    }
  },

  /********************************************************************
   * CORS Allowed Origins
   ********************************************************************/
  CORS_ORIGINS: [
    'https://www.hemlockandoak.com',
    'https://hemlock-oak.myshopify.com',
    'http://127.0.0.1:9292',
    'http://localhost:9292',
    'http://localhost:3000'
  ]
};
