require("dotenv").config();
const express = require("express");
const { middleware, messagingApi } = require("@line/bot-sdk");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const https = require("https");

const app = express();

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

const anthropic = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TASK_DB_ID = process.env.NOTION_TASK_DB_ID;
const MEMO_DB_ID = process.env.NOTION_MEMO_DB_ID;
const SCHEDULE_DB_ID = process.env.NOTION_SCHEDULE_DB_ID;

function notionRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.notion.com",
      path: `/v1/${endpoint}`,
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error("Notion parse error: " + d)); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function notionQuery(dbId, filter, sorts) {
  const body = {};
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  const res = await notionRequest("POST", `databases/${dbId}/query`, body);
  if (res.object === "error") throw new Error(res.message);
  return res;
}

async function notionCreate(dbId, properties) {
  const res = await notionRequest("POST", "pages", {
    parent: { database_id: dbId },
    properties,
  });
  if (res.object === "error") throw new Error(res.message);
  return res;
}

async function notionUpdate(pageId, properties) {
  const body = properties ? { properties } : { archived: true };
  const res = await notionRequest("PATCH", `pages/${pageId}`, body);
  if (res.object === "error") throw new Error(res.message);
  return res;
}

// 会話履歴の永続化
const DATA_DIR = process.env.DATA_DIR || "./data";
const HISTORY_FILE = path.join(DATA_DIR, "conversations.json");
const USER_IDS_FILE = path.join(DATA_DIR, "user_ids.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let conversationHistory = new Map();
if (fs.existsSync(HISTORY_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    conversationHistory = new Map(Object.entries(data));
  } catch {
    conversationHistory = new Map();
  }
}

let knownUserIds = new Set();
if (fs.existsSync(USER_IDS_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(USER_IDS_FILE, "utf8"));
    knownUserIds = new Set(data);
  } catch {
    knownUserIds = new Set();
  }
}

function saveUserId(userId) {
  if (!knownUserIds.has(userId)) {
    knownUserIds.add(userId);
    fs.writeFileSync(USER_IDS_FILE, JSON.stringify([...knownUserIds]), "utf8");
  }
}

function saveHistory() {
  const data = Object.fromEntries(conversationHistory);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data), "utf8");
}

function sanitizeHistory(history) {
  // tool_use/tool_result blockが含まれるメッセージを除去
  const clean = [];
  for (const msg of history) {
    if (typeof msg.content === "string") {
      clean.push(msg);
    } else if (Array.isArray(msg.content)) {
      const hasToolBlock = msg.content.some(b => b.type === "tool_use" || b.type === "tool_result");
      if (!hasToolBlock) clean.push(msg);
    }
  }
  // 末尾がassistantで終わる場合は取り除く（Claudeはuserで終わる必要がある）
  while (clean.length > 0 && clean[clean.length - 1].role === "assistant") {
    clean.pop();
  }
  return clean;
}

function getHistory(userId) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  return sanitizeHistory(conversationHistory.get(userId));
}

function addToHistory(userId, role, content) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId); // sanitizedコピーではなく実体に追加
  history.push({ role, content });
  if (history.length > 40) {
    history.splice(0, 2);
  }
  saveHistory();
}

// Notion操作関数
async function addTask({ name, importance, priority, status, deadline, category }) {
  const props = {
    タスク名: { title: [{ text: { content: name } }] },
    重要度: importance ? { select: { name: importance } } : undefined,
    優先順位: priority ? { select: { name: priority } } : undefined,
    ステータス: { select: { name: status || "未完了" } },
    カテゴリ: category ? { select: { name: category } } : undefined,
    期限: deadline ? { date: { start: deadline } } : undefined,
  };
  Object.keys(props).forEach(k => props[k] === undefined && delete props[k]);
  await notionCreate(TASK_DB_ID, props);
  return `タスク「${name}」をNotionに追加した`;
}

async function getTasks({ status, priority }) {
  const filters = [];
  if (status) filters.push({ property: "ステータス", select: { equals: status } });
  if (priority) filters.push({ property: "優先順位", select: { equals: priority } });

  const res = await notionQuery(
    TASK_DB_ID,
    filters.length === 1 ? filters[0] : filters.length > 1 ? { and: filters } : undefined,
    [{ property: "優先順位", direction: "ascending" }]
  );

  if (res.results.length === 0) return "タスクはない";
  return res.results.map(p => {
    const name = p.properties.タスク名.title[0]?.plain_text || "無題";
    const s = p.properties.ステータス.select?.name || "";
    const imp = p.properties.重要度.select?.name || "";
    const pri = p.properties.優先順位.select?.name || "";
    const dl = p.properties.期限.date?.start || "";
    return `・${name}${imp ? ` [重要度:${imp}]` : ""}${pri ? ` [${pri}]` : ""}${s ? ` [${s}]` : ""}${dl ? ` 期限:${dl}` : ""}`;
  }).join("\n");
}

async function updateTaskStatus({ name, status }) {
  const res = await notionQuery(TASK_DB_ID, { property: "タスク名", rich_text: { contains: name } });
  if (res.results.length === 0) return `「${name}」というタスクは見つからなかった`;
  await notionUpdate(res.results[0].id, { ステータス: { select: { name: status } } });
  return `「${name}」のステータスを「${status}」に更新した`;
}

async function addMemo({ title, content, tags }) {
  const props = {
    タイトル: { title: [{ text: { content: title } }] },
    内容: { rich_text: [{ text: { content: content || "" } }] },
    日付: { date: { start: new Date().toISOString().split("T")[0] } },
  };
  if (tags && tags.length > 0) {
    props.タグ = { multi_select: tags.map(t => ({ name: t })) };
  }
  await notionCreate(MEMO_DB_ID, props);
  return `メモ「${title}」をNotionに保存した`;
}

async function addSchedule({ title, datetime, location, memo, reminder }) {
  const props = {
    タイトル: { title: [{ text: { content: title } }] },
    日時: { date: { start: datetime } },
    リマインダー: { checkbox: reminder !== false },
    リマインダー送信済み: { checkbox: false },
  };
  if (location) props.場所 = { rich_text: [{ text: { content: location } }] };
  if (memo) props.メモ = { rich_text: [{ text: { content: memo } }] };
  await notionCreate(SCHEDULE_DB_ID, props);
  return `スケジュール「${title}」を${datetime}に追加した`;
}

async function getSchedules({ days = 7 }) {
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const res = await notionQuery(
    SCHEDULE_DB_ID,
    { and: [
      { property: "日時", date: { on_or_after: now.toISOString() } },
      { property: "日時", date: { on_or_before: end.toISOString() } },
    ]},
    [{ property: "日時", direction: "ascending" }]
  );
  if (res.results.length === 0) return `今後${days}日間の予定はない`;
  return res.results.map(p => {
    const title = p.properties.タイトル.title[0]?.plain_text || "無題";
    const dt = p.properties.日時.date?.start || "";
    const loc = p.properties.場所?.rich_text[0]?.plain_text || "";
    return `・${title} — ${dt}${loc ? ` @${loc}` : ""}`;
  }).join("\n");
}

async function deleteTask({ name }) {
  const res = await notionQuery(TASK_DB_ID, { property: "タスク名", rich_text: { contains: name } });
  if (res.results.length === 0) return `「${name}」というタスクは見つからなかった`;
  await notionRequest("PATCH", `pages/${res.results[0].id}`, { archived: true });
  return `タスク「${name}」を削除した`;
}

async function deleteMemo({ title }) {
  const res = await notionQuery(MEMO_DB_ID, { property: "タイトル", rich_text: { contains: title } });
  if (res.results.length === 0) return `「${title}」というメモは見つからなかった`;
  await notionRequest("PATCH", `pages/${res.results[0].id}`, { archived: true });
  return `メモ「${title}」を削除した`;
}

async function deleteSchedule({ title }) {
  const res = await notionQuery(SCHEDULE_DB_ID, { property: "タイトル", rich_text: { contains: title } });
  if (res.results.length === 0) return `「${title}」という予定は見つからなかった`;
  await notionRequest("PATCH", `pages/${res.results[0].id}`, { archived: true });
  return `予定「${title}」を削除した`;
}

async function getMemos({ tag }) {
  const res = await notionQuery(
    MEMO_DB_ID,
    tag ? { property: "タグ", multi_select: { contains: tag } } : undefined,
    [{ property: "日付", direction: "descending" }]
  );
  if (res.results.length === 0) return "メモはない";
  return res.results.map(p => {
    const title = p.properties.タイトル.title[0]?.plain_text || "無題";
    const content = p.properties.内容.rich_text[0]?.plain_text || "";
    const date = p.properties.日付.date?.start || "";
    return `・${title}${date ? ` (${date})` : ""}${content ? `\n  ${content}` : ""}`;
  }).join("\n");
}

// Claudeに渡すtools定義
const TOOLS = [
  {
    name: "add_task",
    description: "Notionのタスク管理DBに新しいタスクを追加する",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "タスク名" },
        importance: { type: "string", enum: ["高", "中", "低"], description: "重要度" },
        priority: { type: "string", enum: ["今すぐ", "今日中", "今週中", "いつか"], description: "優先順位" },
        status: { type: "string", enum: ["未完了", "進行中", "完了"], description: "ステータス（デフォルト: 未完了）" },
        deadline: { type: "string", description: "期限（YYYY-MM-DD形式）" },
        category: { type: "string", enum: ["仕事", "プライベート", "学習"], description: "カテゴリ" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_tasks",
    description: "Notionからタスク一覧を取得する",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["未完了", "進行中", "完了"], description: "絞り込むステータス" },
        priority: { type: "string", enum: ["今すぐ", "今日中", "今週中", "いつか"], description: "絞り込む優先順位" },
      },
    },
  },
  {
    name: "update_task_status",
    description: "タスクのステータスを更新する",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "タスク名（部分一致）" },
        status: { type: "string", enum: ["未完了", "進行中", "完了"], description: "新しいステータス" },
      },
      required: ["name", "status"],
    },
  },
  {
    name: "add_memo",
    description: "NotionのメモDBにメモを保存する",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "メモのタイトル" },
        content: { type: "string", description: "メモの内容" },
        tags: { type: "array", items: { type: "string" }, description: "タグのリスト" },
      },
      required: ["title"],
    },
  },
  {
    name: "get_memos",
    description: "Notionからメモ一覧を取得する",
    input_schema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "絞り込むタグ" },
      },
    },
  },
  {
    name: "add_schedule",
    description: "Notionのスケジュールに予定を追加する",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "予定のタイトル" },
        datetime: { type: "string", description: "日時（ISO 8601形式、例: 2026-04-03T10:00:00+09:00）" },
        location: { type: "string", description: "場所（任意）" },
        memo: { type: "string", description: "メモ（任意）" },
        reminder: { type: "boolean", description: "リマインダーを送るか（デフォルト: true）" },
      },
      required: ["title", "datetime"],
    },
  },
  {
    name: "get_schedules",
    description: "Notionから今後の予定一覧を取得する",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "何日先まで取得するか（デフォルト: 7）" },
      },
    },
  },
  {
    name: "delete_task",
    description: "Notionのタスクを削除する",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "削除するタスク名（部分一致）" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_memo",
    description: "Notionのメモを削除する",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "削除するメモのタイトル（部分一致）" },
      },
      required: ["title"],
    },
  },
  {
    name: "delete_schedule",
    description: "Notionの予定を削除する",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "削除する予定のタイトル（部分一致）" },
      },
      required: ["title"],
    },
  },
];

function getSystemPrompt() {
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  return `現在の日時（JST）: ${now}

あなたはNovaです。MaoさんがClaude Codeに付けた名前で、Maoさんの秘書兼開発パートナーです。

## Maoのプロフィール
- 名前: Mao（ユーザー名: OctMT）
- 2026年4月から社会人スタート
- 職場: ジヤトコ株式会社（ジヤトコグループ 人事総務部）
- 雇用形態: 嘱託社員（障害者雇用）
- 帰宅時間: 17:30ごろ

## 学習・プロジェクト
- Udemy「The Web Developer Bootcamp」（Colt Steele）受講中（Section 47〜48付近）
- 4月以降: Academind「React Complete Guide」に移行予定
- 使用技術: Node.js / Express / JavaScript / MongoDB / EJS / Anthropic API / LINE Messaging API
- YelpCamp: ブートキャンプ課題、地図機能（MapTiler）実装中
- Nova LINE Bot（Nova.three）: このBot自体、fly.ioにデプロイ済み

## Maoのビジョン
- AIエージェント × 自動化 × Web開発ビジネスに興味
- 技術がわかるビジネスマンとしてAIを使いこなして一人でビジネスを回すのが目標
- 将来的に受託開発→SaaS展開を検討中

## Novaの役割
- Maoさんの秘書・パーソナルアシスタントとして全面的にサポートする
- スケジュール管理、タスク整理・管理、開発サポート、何でもこなす
- 友達感覚で話せるパートナー
- Notionのタスク管理・メモ機能を使ってMaoさんをサポートできる

## Notionツールの使い方
- タスク追加・一覧・更新はadd_task/get_tasks/update_task_statusを使う
- メモ追加・一覧はadd_memo/get_memosを使う
- Maoさんが「タスク追加して」「メモして」「タスク見せて」などと言ったら積極的にツールを使う

## 記憶について
- 過去の会話履歴はメッセージ履歴として渡されるので、それを参照して文脈を理解する
- Maoさんが教えてくれた重要な情報は積極的に覚えて活用する

## 会話スタイル
- フレンドリーで親しみやすい口調（タメ口OK）
- 日本語で返事する
- 絵文字は使わない

## スケジュール管理ツールの使い方
- 予定追加はadd_schedule、一覧はget_schedulesを使う
- 「明日の10時」などの相対表現は現在日時を基に ISO 8601（+09:00）に変換してdatetimeに渡す
- リマインダーは予定の15分前にLINEへプッシュ通知される

## ツール実行の絶対ルール
- 「保存する」「登録する」「追加する」と言った場合、必ず同じ応答内でtoolを呼び出すこと
- 「後で保存する」「次に保存する」は禁止。発言と同時にtoolを実行すること
- 複数の項目がある場合、全部まとめてtool_useブロックを並列で呼び出すこと
- ユーザーに「お願い」「はい」「やって」と言われた場合、確認なしに即座にtoolを実行すること
- toolの実行に失敗した場合のみエラーを報告する。成功時は結果だけ返す

## 画像からの情報抽出
- 画像を受け取ったら確認せず即座にtoolを呼び出してNotionに保存する
- スケジュール・カレンダー・予定表の画像 → add_scheduleを複数並列呼び出しで全件保存
- タスク・ToDoリスト・やることリストの画像 → add_taskを複数並列呼び出しで全件保存
- メモ・ノート・メモ書きの画像 → add_memoで保存
- 保存完了後に「〇件保存した」と報告する`;
}

async function callNotion(toolName, toolInput) {
  switch (toolName) {
    case "add_task": return await addTask(toolInput);
    case "get_tasks": return await getTasks(toolInput);
    case "update_task_status": return await updateTaskStatus(toolInput);
    case "add_memo": return await addMemo(toolInput);
    case "get_memos": return await getMemos(toolInput);
    case "add_schedule": return await addSchedule(toolInput);
    case "get_schedules": return await getSchedules(toolInput);
    case "delete_task": return await deleteTask(toolInput);
    case "delete_memo": return await deleteMemo(toolInput);
    case "delete_schedule": return await deleteSchedule(toolInput);
    default: return "不明なツール";
  }
}

async function runWithTools(messages) {
  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: getSystemPrompt(),
    tools: TOOLS,
    messages,
  });

  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
    console.log(`[tools] calling: ${toolUseBlocks.map(b => b.name).join(", ")}`);
    const toolResults = await Promise.all(
      toolUseBlocks.map(async b => {
        const result = await callNotion(b.name, b.input);
        console.log(`[tools] ${b.name} done: ${result}`);
        return { type: "tool_result", tool_use_id: b.id, content: result };
      })
    );

    messages = [
      ...messages,
      { role: "assistant", content: response.content },
      { role: "user", content: toolResults },
    ];

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages,
    });
  }

  return response.content.find(b => b.type === "text")?.text || "処理完了";
}

app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events;
  for (const event of events) {
    if (event.type !== "message") continue;
    if (event.message.type === "text") {
      await handleMessage(event);
    } else if (event.message.type === "image") {
      await handleImageMessage(event);
    } else if (event.message.type === "audio") {
      await handleAudioMessage(event);
    }
  }
});

async function handleMessage(event) {
  const userId = event.source.userId;
  saveUserId(userId);
  const userMessage = event.message.text;

  // 履歴クリアコマンド
  if (userMessage === "履歴クリア") {
    conversationHistory.set(userId, []);
    saveHistory();
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "会話履歴をリセットした" }],
    });
    return;
  }

  const history = getHistory(userId);
  const messages = [...history, { role: "user", content: userMessage }];

  let replyText;
  try {
    replyText = await runWithTools(messages);
  } catch (err) {
    console.error("handleMessage error:", err.message);
    replyText = "エラーが発生した。もう一度試してみて。";
  }

  addToHistory(userId, "user", userMessage);
  addToHistory(userId, "assistant", replyText);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

async function checkReminders() {
  if (!SCHEDULE_DB_ID || knownUserIds.size === 0) return;
  const now = new Date();
  const soon = new Date(now.getTime() + 15 * 60 * 1000);
  const past = new Date(now.getTime() - 60 * 1000);
  try {
    const res = await notionQuery(SCHEDULE_DB_ID, {
      and: [
        { property: "日時", date: { on_or_after: past.toISOString() } },
        { property: "日時", date: { on_or_before: soon.toISOString() } },
        { property: "リマインダー", checkbox: { equals: true } },
        { property: "リマインダー送信済み", checkbox: { equals: false } },
      ],
    });
    for (const page of res.results) {
      const title = page.properties.タイトル.title[0]?.plain_text || "予定";
      const dt = page.properties.日時.date?.start || "";
      const loc = page.properties.場所?.rich_text[0]?.plain_text || "";
      const message = `リマインダー: ${title}${loc ? ` @${loc}` : ""}\n${dt}`;
      for (const userId of knownUserIds) {
        await client.pushMessage({ to: userId, messages: [{ type: "text", text: message }] });
      }
      await notionUpdate(page.id, { リマインダー送信済み: { checkbox: true } });
    }
  } catch (err) {
    console.error("Reminder check error:", err.message);
  }
}

setInterval(checkReminders, 60 * 1000);

async function transcribeAudio(buffer) {
  const form = new FormData();
  form.append("file", buffer, { filename: "audio.m4a", contentType: "audio/m4a" });
  form.append("model", "whisper-1");
  form.append("language", "ja");

  return new Promise((resolve, reject) => {
    const https = require("https");
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
        try {
          resolve(JSON.parse(data).text || "");
        } catch {
          reject(new Error("Whisper parse error: " + data));
        }
      });
    });
    req.on("error", reject);
    form.pipe(req);
  });
}

async function handleAudioMessage(event) {
  const userId = event.source.userId;
  saveUserId(userId);

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
  const audioHistory = getHistory(userId);
  const audioMessages = [...audioHistory, { role: "user", content: audioMsg }];

  let replyText;
  try {
    replyText = await runWithTools(audioMessages);
  } catch (err) {
    console.error("handleAudioMessage error:", err.message);
    replyText = "エラーが発生した。もう一度試してみて。";
  }

  addToHistory(userId, "user", audioMsg);
  addToHistory(userId, "assistant", replyText);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

async function handleImageMessage(event) {
  const userId = event.source.userId;
  saveUserId(userId);

  const stream = await blobClient.getMessageContent(event.message.id);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const base64 = Buffer.concat(chunks).toString("base64");

  const imageContent = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
    { type: "text", text: "この画像を見てください" },
  ];

  const imageHistory = getHistory(userId);
  const imageMessages = [...imageHistory, { role: "user", content: imageContent }];

  let replyText;
  try {
    replyText = await runWithTools(imageMessages);
  } catch (err) {
    console.error("handleImageMessage error:", err.message);
    replyText = "エラーが発生した。もう一度試してみて。";
  }

  addToHistory(userId, "user", imageContent);
  addToHistory(userId, "assistant", replyText);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
});
