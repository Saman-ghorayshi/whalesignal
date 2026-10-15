// tools/dns-patch.cjs
// Anti-sinkhole & robust DNS resolver patch for Node.js in restricted networks.

const dns = require("node:dns");

try {
  dns.setServers(["1.1.1.1", "8.8.8.8", "1.0.0.1", "8.8.4.4"]);
} catch {}

const origLookup = dns.lookup;

function doResolve4(hostname, isAll, fallbackErr, fallbackAddr, fallbackFamily, callback) {
  dns.resolve4(hostname, (err2, addrs) => {
    if (!err2 && Array.isArray(addrs) && addrs.length > 0) {
      const clean = addrs.filter((a) => a && !a.startsWith("127.254."));
      if (clean.length > 0) {
        if (isAll) {
          return callback(null, clean.map((a) => ({ address: a, family: 4 })));
        }
        return callback(null, clean[0], 4);
      }
    }
    callback(fallbackErr, fallbackAddr, fallbackFamily);
  });
}

dns.lookup = function (hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const isAll = typeof options === "object" && options !== null && Boolean(options.all);

  // Directly bypass poisoned getaddrinfo for known Cloudflare / AI hosts
  if (typeof hostname === "string" && (hostname.includes("cloudflare.com") || hostname.includes("workers.dev"))) {
    return doResolve4(hostname, isAll, null, null, null, callback);
  }

  origLookup(hostname, options, (err, address, family) => {
    let hasPoison = false;
    if (err) {
      hasPoison = true; // Retry with resolve4 on error
    } else if (isAll && Array.isArray(address)) {
      hasPoison = address.some((a) => a && typeof a.address === "string" && a.address.startsWith("127.254."));
    } else if (typeof address === "string" && address.startsWith("127.254.")) {
      hasPoison = true;
    }

    if (hasPoison) {
      return doResolve4(hostname, isAll, err, address, family, callback);
    }

    callback(err, address, family);
  });
};
