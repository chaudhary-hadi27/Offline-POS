'use strict';

/**
 * The PUBLIC key(s) for "Forgot PIN" recovery. This file is written by
 *     npm run recovery:keys        (tools/license/generate-recovery-key.js)
 * A public key can only CHECK a recovery code, never create one, so it is safe to ship inside the app.
 * It is a different key pair from the licence keys on purpose: leaking one never affects the other.
 *
 * Empty = recovery by the developer is switched off in this build (the build check stops a release
 * without it). The owner can still unlock with the security question.
 */
const RECOVERY_PUBLIC_KEYS = [
  {
    "kid": "1",
    "pem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPNkbXAF3QdNdkY/CNL8H+/tub/lOspbqfqQbuMpxcZ0=\n-----END PUBLIC KEY-----\n"
  }
];

module.exports = { RECOVERY_PUBLIC_KEYS };
