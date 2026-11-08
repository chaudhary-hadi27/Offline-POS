'use strict';

/**
 * The vendor's PUBLIC key(s). This file is (re)written by
 *     node tools/license/generate-keys.js
 * Public keys are safe to ship - they can only CHECK a signature, never create one.
 *
 * Each key has a `kid` (key id) written into every license, so a new key can be
 * added later without invalidating licenses signed by an older one.
 *
 * MIN_LICENSE_EPOCH: licenses carry an `epoch` number. If a build ever leaks or is
 * cracked, raise this in the next release and issue new licenses with the higher
 * epoch - licenses from before stop working on the new build.
 */

const PUBLIC_KEYS = [
  {
    "kid": "1",
    "pem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAMyIDA8O8sRosOiVasSHVsgArsO4utQ6YI6rpt8WhY5g=\n-----END PUBLIC KEY-----\n"
  }
];

const MIN_LICENSE_EPOCH = 1;

module.exports = { PUBLIC_KEYS, MIN_LICENSE_EPOCH };
