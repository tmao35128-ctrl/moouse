const { messagingApi } = require("@line/bot-sdk");
const { checkReminders } = require("../lib/notion");
const { getUserIds } = require("../lib/history");

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) return res.status(401).end();

  try {
    const userIds = await getUserIds();
    await checkReminders(async (message) => {
      for (const userId of userIds) {
        await client.pushMessage({ to: userId, messages: [{ type: "text", text: message }] });
      }
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("check-reminders error:", err.message);
    res.status(500).json({ error: err.message });
  }
};
