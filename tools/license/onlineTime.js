'use strict';

/** Best-effort "what time is it really?" from the HTTP Date header of a big, well-run site. */
const https = require('https');

function getOnlineTimeMs(timeoutMs = 4000, hosts = ['api.github.com', 'www.cloudflare.com', 'www.google.com']) {
  const tryHost = (host) =>
    new Promise((resolve) => {
      const req = https.request({ host, method: 'HEAD', path: '/', timeout: timeoutMs }, (res) => {
        const t = Date.parse(res.headers.date || '');
        res.resume();
        resolve(Number.isFinite(t) ? t : null);
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  return (async () => {
    for (const h of hosts) {
      const t = await tryHost(h);
      if (t) return t;
    }
    return null;
  })();
}

module.exports = { getOnlineTimeMs };
