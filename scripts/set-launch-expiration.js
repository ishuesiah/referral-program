#!/usr/bin/env node
/********************************************************************
 * Script: Set Launch Expiration Date
 *
 * Run this ONCE after syncing Smile.io data and before launching.
 * Sets expiration date for all existing points to 6 months from launch.
 *
 * Usage: node scripts/set-launch-expiration.js [YYYY-MM-DD]
 *
 * If no date provided, uses today + 6 months as expiration.
 ********************************************************************/
require('dotenv').config();
const repo = require('../src/repository');

async function run() {
  console.log('Setting expiration date for existing points...');
  console.log('Time:', new Date().toISOString());

  // Parse launch date from argument or use today
  let launchDate = new Date();
  if (process.argv[2]) {
    launchDate = new Date(process.argv[2]);
    if (isNaN(launchDate.getTime())) {
      console.error('Invalid date format. Use YYYY-MM-DD');
      process.exit(1);
    }
  }

  // Calculate expiration (12 months from launch)
  const expirationDate = new Date(launchDate);
  expirationDate.setMonth(expirationDate.getMonth() + 12);

  console.log(`Launch date: ${launchDate.toISOString().split('T')[0]}`);
  console.log(`Expiration date: ${expirationDate.toISOString().split('T')[0]}`);
  console.log('');

  try {
    const count = await repo.setExpirationForExistingActions(expirationDate.toISOString());
    console.log(`Updated ${count} actions with expiration date.`);
    console.log('');
    console.log('Done! All existing points will expire on:', expirationDate.toISOString().split('T')[0]);
    process.exit(0);
  } catch (err) {
    console.error('Failed to set expiration dates:', err.message);
    process.exit(1);
  }
}

run();
