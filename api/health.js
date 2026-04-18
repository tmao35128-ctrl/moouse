module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasLineSecret: !!process.env.LINE_CHANNEL_SECRET,
      hasLineToken: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
      hasRedisUrl: !!process.env.UPSTASH_REDIS_REST_URL,
      hasRedisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    }
  });
};
