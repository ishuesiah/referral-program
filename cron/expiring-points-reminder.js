#!/usr/bin/env node
/********************************************************************
 * Cron: Expiring Points Reminder
 * Runs daily to send Klaviyo events for users with points expiring soon
 *
 * Usage: node cron/expiring-points-reminder.js
 *
 * This script:
 * 1. Finds users with points expiring in 14 days
 * 2. Sends a Klaviyo "Points Expiring Soon" event for each
 * 3. Klaviyo flow triggers the reminder email
 ********************************************************************/
require('dotenv').config();
const repo = require('../src/repository');
const klaviyo = require('../src/gateways/klaviyo');

const DAYS_BEFORE_EXPIRY = 14;

async function run() {
  console.log('Starting expiring points reminder cron...');
  console.log('Time:', new Date().toISOString());
  console.log(`Looking for points expiring in ${DAYS_BEFORE_EXPIRY} days...`);

  try {
    const users = await repo.getUsersWithPointsExpiringInDays(DAYS_BEFORE_EXPIRY);

    if (users.length === 0) {
      console.log('No users with points expiring in 14 days.');
      process.exit(0);
    }

    console.log(`Found ${users.length} users with expiring points.`);

    let successCount = 0;
    let failCount = 0;

    for (const user of users) {
      const expirationDate = new Date(user.expiration_date);
      const formattedDate = expirationDate.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });

      try {
        await klaviyo.trackEvent(user.email, 'Points Expiring Soon', {
          first_name: user.first_name || 'there',
          expiring_points: parseInt(user.expiring_points),
          current_balance: user.points,
          expiration_date: formattedDate,
          days_until_expiry: DAYS_BEFORE_EXPIRY
        });

        console.log(`  ✓ ${user.email}: ${user.expiring_points} points expiring ${formattedDate}`);
        successCount++;
      } catch (err) {
        console.error(`  ✗ ${user.email}: Failed - ${err.message}`);
        failCount++;
      }
    }

    console.log(`\nReminder complete!`);
    console.log(`  Sent: ${successCount}`);
    console.log(`  Failed: ${failCount}`);

    process.exit(0);
  } catch (err) {
    console.error('Expiring points reminder cron failed:', err.message);
    process.exit(1);
  }
}

run();
