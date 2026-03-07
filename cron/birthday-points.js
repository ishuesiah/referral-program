#!/usr/bin/env node
/********************************************************************
 * Cron: Birthday Points
 * Runs daily to award birthday points to users
 *
 * Usage: node cron/birthday-points.js
 ********************************************************************/
require('dotenv').config();
const rewards = require('../src/rewards');

async function run() {
  console.log('Starting birthday points cron job...');
  console.log('Time:', new Date().toISOString());

  try {
    const results = await rewards.processBirthdayPoints();

    console.log(`Processed ${results.length} birthdays`);
    results.forEach(r => {
      console.log(`  - ${r.email}: ${r.status}${r.points ? ` (+${r.points} pts)` : ''}`);
    });

    console.log('Birthday points cron completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Birthday points cron failed:', err.message);
    process.exit(1);
  }
}

run();
