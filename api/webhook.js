const { middleware, messagingApi } = require("@line/bot-sdk");
const FormData = require("form-data");
const https = require("https");
const { getHistory, addToHistory, clearHistory, saveUserId } = require("../lib/history");
const { runWithTools } = require("../lib/claude");

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const blobClient = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

async function transcribeAudio(buffer) {
  const form = new FormData();
  form.append("file", buffer, { filename: "audio.m4a", contentType: "audio/m4a" });
  form.append("model", "whisper-1");
  form.append("language", "ja");
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/audio/transcriptions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data).text || ""); }
        catch { reject(new Error("Whisper parse error: " + data)); }
      });
    });
    req.on("error", reject);
    form.pipe(req);
  });
}

async function handleText(event) {
  const userId = event.source.userId;
  await saveUserId(userId);
  const userMessage = event.message.text;

  if (userMessage === "履歴クリア") {
    await clearHistory(userId);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "会話履歴をリセットした" }],
    });
    return;
  }

  const history = await getHistory(userId);
  const messages = [...history, { role: "user", content: userMessage }];
  let replyText;
  try {
    replyText = await runWithTools(messages);
  } catch (err) {
    console.error("handleText error:", err.message);
    replyText = "エラーが発生した。もう一度試してみて。";
  }
  await addToHistory(userId, "user", userMessage);
  await addToHistory(userId, "assistant", replyText);
  try {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: replyText }],
    });
  } catch (err) {
    console.error("replyMessage error:", err.message);
  }
}

async function handleImage(event) {
  const userId = event.source.userId;
  await saveUserId(userId);

  const stream = await blobClient.getMessageContent(event.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const base64 = Buffer.concat(chunks).toString("base64");

  const imageContent = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
    { type: "text", text: "この画像を見てください" },
  ];

  const history = await getHistory(userId);
  const messages = [...history, { role: "user", content: imageContent }];
  let replyText;
  try {
    replyText = await runWithTools(messages);
  } catch (err) {
    console.error("handleImage error:", err.message);
    replyText = "エラーが発生した。もう一度試してみて。";
  }

  await addToHistory(userId, "user", "（画像を送信）");
  await addToHistory(userId, "assistant", replyText);
  try {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: replyText }],
    });
  } catch (err) {
    console.error("replyMessage error (image):", err.message);
  }
}

async function handleAudio(event) {
  const userId = event.source.userId;
  await saveUserId(userId);

  const stream = await blobClient.getMessageContent(event.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  let transcript;
  try {
    transcript = await transcribeAudio(buffer);
  } catch (err) {
    console.error("Transcribe error:", err.message);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "音声の読み取りに失敗した。もう一度試してみて。" }],
    });
    return;
  }

  if (!transcript) {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "音声が聞き取れなかった。もう一度試してみて。" }],
    });
    return;
  }

  const audioMsg = `[音声メッセージ] ${transcript}`;
  const history = await getHistory(userId);
  const messages = [...history, { role: "user", content: audioMsg }];
  let replyText;
  try {
    replyText = await runWithTools(messages);
  } catch (err) {
    console.error("handleAudio error:", err.message);
    replyText = "エラーが発生した。もう一度試してみて。";
  }
  await addToHistory(userId, "user", audioMsg);
  await addToHistory(userId, "assistant", replyText);
  try {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: replyText }],
    });
  } catch (err) {
    console.error("replyMessage error (audio):", err.message);
  }
}

const lineMiddleware = middleware(lineConfig);

const handler = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  await new Promise((resolve, reject) => {
    lineMiddleware(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  }).catch(err => {
    console.error("Middleware error:", err.message);
    res.status(400).end();
    return;
  });

  if (res.headersSent) return;
  res.status(200).end();

  const events = req.body.events || [];
  for (const event of events) {
    if (event.type !== "message") continue;
    if (event.message.type === "text") await handleText(event);
    else if (event.message.type === "image") await handleImage(event);
    else if (event.message.type === "audio") await handleAudio(event);
  }
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
