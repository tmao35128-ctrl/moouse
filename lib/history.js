const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCommand(...args) {
  const res = await fetch(`${REDIS_URL}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const json = await res.json();
  return json.result;
}

async function redisSet(key, value) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encoded}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  return res.json();
}

async function redisGet(key) {
  const result = await redisCommand("get", key);
  if (!result) return null;
  try { return JSON.parse(result); } catch { return result; }
}

async function redisDel(key) {
  return redisCommand("del", key);
}

async function redisSadd(key, member) {
  return redisCommand("sadd", key, member);
}

async function redisSmembers(key) {
  const result = await redisCommand("smembers", key);
  return result || [];
}

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
  const data = await redisGet(HISTORY_KEY(userId));
  const history = data || [];
  return sanitizeHistory(history);
}

async function addToHistory(userId, role, content) {
  const history = await redisGet(HISTORY_KEY(userId)) || [];
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, 2);
  await redisSet(HISTORY_KEY(userId), history);
}

async function clearHistory(userId) {
  await redisDel(HISTORY_KEY(userId));
}

async function saveUserId(userId) {
  await redisSadd(USER_IDS_KEY, userId);
}

async function getUserIds() {
  return redisSmembers(USER_IDS_KEY);
}

module.exports = { getHistory, addToHistory, clearHistory, saveUserId, getUserIds };
