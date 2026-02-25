/********************************************************************
 * shopify-gateway.js
 * Shopify API integration - discounts, customers, webhooks
 ********************************************************************/
const crypto = require('crypto');
const fetch = require('node-fetch');
const config = require('./config');

/********************************************************************
 * Webhook Verification
 ********************************************************************/
function verifyWebhook(req) {
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
 * Customer Functions
 ********************************************************************/
async function getCustomerTotalSpent(email) {
  const query = `
    query getCustomerByEmail($email: String!) {
      customers(first: 1, query: $email) {
        edges {
          node {
            id
            email
            amountSpent {
              amount
              currencyCode
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(config.SHOPIFY_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': config.SHOPIFY_ADMIN_TOKEN
      },
      body: JSON.stringify({ query, variables: { email: `email:${email}` } })
    });

    const result = await response.json();
    const customer = result.data?.customers?.edges?.[0]?.node;

    if (customer) {
      return parseFloat(customer.amountSpent?.amount || 0);
    }
    return 0;
  } catch (err) {
    console.error('Error fetching customer total spent:', err);
    return 0;
  }
}

/********************************************************************
 * Discount Code Functions
 ********************************************************************/
async function createDiscountCode(amountOff, pointsToRedeem, options = {}) {
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

async function deactivateDiscount(discountId) {
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
 * Exports
 ********************************************************************/
module.exports = {
  verifyWebhook,
  getCustomerTotalSpent,
  createDiscountCode,
  deactivateDiscount
};
