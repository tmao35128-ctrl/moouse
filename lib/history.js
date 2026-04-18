const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const HISTORY_KEY = (userId) => `history:${userId}`;
const USER_IDS_KEY = "user_ids";
const MAX_HISTORY = 40;

function sanitizeHistory(history) {
  const clean = [];
  for (const msg of history) {
    if (typeof msg.content === "string") {
      clean.push(msg);
    } else if (Array.isArray(msg.content)) {
      const filtered = msg.content.filter(b => b.type !== "image");
      const hasToolBlock = filtered.some(b => b.type === "tool_use" || b.type === "tool_result");
      if (!hasToolBlock && filtered.length > 0) clean.push({ ...msg, content: filtered });
    }
  }
  while (clean.length > 0 && clean[clean.length - 1].role === "assistant") {
    clean.pop();
  }
  return clean;
}

async function getHistory(userId) {
  const data = await redis.get(HISTORY_KEY(userId));
  const history = data || [];
  return sanitizeHistory(history);
}

async function addToHistory(userId, role, content) {
  const history = await redis.get(HISTORY_KEY(userId)) || [];
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, 2);
  await redis.set(HISTORY_KEY(userId), history);
}

async function clearHistory(userId) {
  await redis.del(HISTORY_KEY(userId));
}

async function saveUserId(userId) {
  await redis.sadd(USER_IDS_KEY, userId);
}

async function getUserIds() {
  return await redis.smembers(USER_IDS_KEY);
}

module.exports = { getHistory, addToHistory, clearHistory, saveUserId, getUserIds };
