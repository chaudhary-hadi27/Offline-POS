'use strict';

/**
 * Run this WHENEVER a locked-out customer calls you and reads out
 * their 8-character challenge code (shown on their screen as
 * something like "A1B2-C3D4"). It prints the matching response key -
 * read that back to them, they type it in, and they're unlocked.
 *
 * This uses the EXACT SAME secret your packaged app was built with
 * (electron/security/master-secret.generated.js), so this only works
 * correctly if you run it on the same machine/checkout you used to
 * run scripts/generate-master-secret-file.js, or if you set the same
 * POS_MASTER_SECRET in your shell here.
 *
 * Usage - pass the code straight on the command line (dashes,
 * spaces, and lower/upper case are all fine, exactly as read to you):
 *   node scripts/compute-master-key.js A1B2-C3D4
 *
 * Or run with no arguments to be prompted interactively (handy if
 * you're on the phone and want to paste it in when ready):
 *   node scripts/compute-master-key.js
 */

const readline = require('readline');
const { computeResponseKey } = require('../electron/security/masterKeyRecovery');

function printResult(challengeInput) {
  const responseKey = computeResponseKey(challengeInput);
  console.log('\n' + '='.repeat(40));
  console.log('  Read this back to the customer:');
  console.log(`  ${responseKey}`);
  console.log('='.repeat(40) + '\n');
}

const argChallenge = process.argv[2];

if (argChallenge) {
  printResult(argChallenge);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Challenge code from the customer\'s screen: ', (answer) => {
    printResult(answer);
    rl.close();
  });
}
