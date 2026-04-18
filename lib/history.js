const https = require("https");

function redisCommand(args) {
  return new Promise((resolve, reject) => {
    const url = new URL(process.env.UPSTASH_REDIS_REST_URL);
    const data = JSON.stringify(args);
    const req = https.request({
      hostname: url.hostname,
      path: "/",
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d).result); }
        catch { reject(new Error("Redis error: " + d)); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
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
  const result = await redisCommand(["GET", HISTORY_KEY(userId)]);
  if (!result) return [];
  try {
    const data = typeof result === "string" ? JSON.parse(result) : result;
    return sanitizeHistory(data);
  } catch { return []; }
}

async function addToHistory(userId, role, content) {
  const key = HISTORY_KEY(userId);
  const result = await redisCommand(["GET", key]);
  let history = [];
  if (result) {
    try { history = typeof result === "string" ? JSON.parse(result) : result; }
    catch { history = []; }
  }
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, 2);
  await redisCommand(["SET", key, JSON.stringify(history)]);
}

async function clearHistory(userId) {
  await redisCommand(["DEL", HISTORY_KEY(userId)]);
}

async function saveUserId(userId) {
  await redisCommand(["SADD", USER_IDS_KEY, userId]);
}

async function getUserIds() {
  const result = await redisCommand(["SMEMBERS", USER_IDS_KEY]);
  return result || [];
}

module.exports = { getHistory, addToHistory, clearHistory, saveUserId, getUserIds };
