const https = require("https");

const NOTION_TOKEN = (process.env.NOTION_TOKEN || "").trim();
const TASK_DB_ID = (process.env.NOTION_TASK_DB_ID || "").trim();
const MEMO_DB_ID = (process.env.NOTION_MEMO_DB_ID || "").trim();
const SCHEDULE_DB_ID = (process.env.NOTION_SCHEDULE_DB_ID || "").trim();

function notionRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.notion.com",
      path: `/v1/${endpoint}`,
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
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

async function checkReminders(pushFn) {
  if (!SCHEDULE_DB_ID) return;
  const now = new Date();
  const soon = new Date(now.getTime() + 15 * 60 * 1000);
  const past = new Date(now.getTime() - 60 * 1000);
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
    await pushFn(message);
    await notionUpdate(page.id, { リマインダー送信済み: { checkbox: true } });
  }
}

module.exports = {
  notionRequest, notionQuery, notionCreate, notionUpdate,
  addTask, getTasks, updateTaskStatus,
  addMemo, getMemos,
  addSchedule, getSchedules,
  deleteTask, deleteMemo, deleteSchedule,
  checkReminders,
};
