#!/usr/bin/env node
/********************************************************************
 * Cron: Expire Points
 * Runs daily to process expired points and update user balances
 *
 * Usage: node cron/expire-points.js
 *
 * This script:
 * 1. Finds all actions with expired points
 * 2. Marks them as expired
 * 3. Recalculates each affected user's point balance
 * 4. Optionally sends notifications via Klaviyo
 ********************************************************************/
require('dotenv').config();
const repo = require('../src/repository');
const klaviyo = require('../src/gateways/klaviyo');

async function run() {
  console.log('Starting points expiration cron job...');
  console.log('Time:', new Date().toISOString());

  try {
    // Get all expired actions that haven't been processed yet
    const expiredActions = await repo.getExpiredActions();

    if (expiredActions.length === 0) {
      console.log('No expired points to process.');
      process.exit(0);
    }

    console.log(`Found ${expiredActions.length} expired point actions.`);

    // Group by user
    const userActions = {};
    for (const action of expiredActions) {
      if (!userActions[action.user_id]) {
        userActions[action.user_id] = {
          email: action.email,
          firstName: action.first_name,
          actions: [],
          totalExpired: 0
        };
      }
      userActions[action.user_id].actions.push(action);
      userActions[action.user_id].totalExpired += action.points_awarded;
    }

    // Process each user
    const actionIds = expiredActions.map(a => a.action_id);
    await repo.markActionsAsExpired(actionIds);
    console.log(`Marked ${actionIds.length} actions as expired.`);

    // Update each user's point balance
    let usersProcessed = 0;
    for (const userId of Object.keys(userActions)) {
      const userData = userActions[userId];
      const newPoints = await repo.syncUserPointsFromActions(parseInt(userId));

      console.log(`  - ${userData.email}: ${userData.totalExpired} points expired, new balance: ${newPoints}`);

      // Send Klaviyo notification about expired points
      try {
        await klaviyo.trackEvent(userData.email, 'Points Expired', {
          first_name: userData.firstName,
          points_expired: userData.totalExpired,
          new_balance: newPoints
        });
      } catch (err) {
        console.error(`  Failed to send Klaviyo event for ${userData.email}:`, err.message);
      }

      usersProcessed++;
    }

    console.log(`\nExpiration complete!`);
    console.log(`  Actions expired: ${actionIds.length}`);
    console.log(`  Users affected: ${usersProcessed}`);

    process.exit(0);
  } catch (err) {
    console.error('Points expiration cron failed:', err.message);
    process.exit(1);
  }
}

run();
