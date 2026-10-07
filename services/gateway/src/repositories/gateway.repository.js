'use strict';
const { createClient } = require('redis');
const RATE_SCRIPT =
  "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]); end; return {n,redis.call('PTTL',KEYS[1])}";

// Gateway owns rate-limit counters in Redis; it has no business database.
module.exports = (redis) => ({
  ping() {
    return redis.ping();
  },
  async incrementWindow(key) {
    const [count, ttl] = await redis.eval(RATE_SCRIPT, {
      keys: [`cab:rate:${key}`],
      arguments: ['60000'],
    });
    return { count: Number(count), ttl: Number(ttl) };
  },
});
module.exports.connect = async () => {
  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', () => console.error('Redis unavailable'));
  await redis.connect();
  await redis.ping();
  return redis;
};
