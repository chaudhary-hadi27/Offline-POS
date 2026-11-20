'use strict';

/**
 * LEGACY - only for apps built BEFORE the recovery key pair existed (those apps check an HMAC made with
 * the old shared secret). New builds use `npm run recovery:issue` instead (a signature; no secret in the app).
 *
 *   POS_MASTER_SECRET="<the old secret>" node scripts/compute-master-key.js A1B2-C3D4
 */
const crypto = require('crypto');

const secret = process.env.POS_MASTER_SECRET;
const challenge = String(process.argv[2] || '').replace(/[\s-]/g, '').toUpperCase();
if (!secret || secret.length < 16 || !challenge) {
  console.error('Usage: POS_MASTER_SECRET="<old secret>" node scripts/compute-master-key.js A1B2-C3D4');
  process.exit(1);
}
console.log(crypto.createHmac('sha256', secret).update(challenge).digest('hex').slice(0, 10).toUpperCase());
