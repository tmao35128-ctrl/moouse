// Nova の頭脳（旧: Anthropic Claude → Groq無料枠へ移行, OpenAI互換のtool calling）
// ファイル名は互換のため claude.js のまま（webhook.js が require("../lib/claude")）
const notion = require("./notion");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

// OpenAI/Groq の function-tool 形式（旧Anthropicの input_schema → parameters）
const TOOLS = [
  { type: "function", function: { name: "add_task", description: "Notionのタスク管理DBに新しいタスクを追加する", parameters: {
    type: "object", properties: {
      name: { type: "string", description: "タスク名" },
      importance: { type: "string", enum: ["高", "中", "低"] },
      priority: { type: "string", enum: ["今すぐ", "今日中", "今週中", "いつか"] },
      status: { type: "string", enum: ["未完了", "進行中", "完了"] },
      deadline: { type: "string", description: "期限（YYYY-MM-DD）" },
      category: { type: "string", enum: ["仕事", "プライベート", "学習"] },
    }, required: ["name"] } } },
  { type: "function", function: { name: "get_tasks", description: "Notionからタスク一覧を取得する", parameters: {
    type: "object", properties: {
      status: { type: "string", enum: ["未完了", "進行中", "完了"] },
      priority: { type: "string", enum: ["今すぐ", "今日中", "今週中", "いつか"] },
    } } } },
  { type: "function", function: { name: "update_task_status", description: "タスクのステータスを更新する", parameters: {
    type: "object", properties: {
      name: { type: "string" },
      status: { type: "string", enum: ["未完了", "進行中", "完了"] },
    }, required: ["name", "status"] } } },
  { type: "function", function: { name: "add_memo", description: "NotionのメモDBにメモを保存する", parameters: {
    type: "object", properties: {
      title: { type: "string" }, content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    }, required: ["title"] } } },
  { type: "function", function: { name: "get_memos", description: "Notionからメモ一覧を取得する", parameters: {
    type: "object", properties: { tag: { type: "string" } } } } },
  { type: "function", function: { name: "add_schedule", description: "Notionのスケジュールに予定を追加する", parameters: {
    type: "object", properties: {
      title: { type: "string" },
      datetime: { type: "string", description: "ISO 8601形式（例: 2026-04-03T10:00:00+09:00）" },
      location: { type: "string" }, memo: { type: "string" }, reminder: { type: "boolean" },
    }, required: ["title", "datetime"] } } },
  { type: "function", function: { name: "get_schedules", description: "Notionから今後の予定一覧を取得する", parameters: {
    type: "object", properties: { days: { type: "number" } } } } },
  { type: "function", function: { name: "delete_task", description: "Notionのタスクを削除する", parameters: {
    type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "delete_memo", description: "Notionのメモを削除する", parameters: {
    type: "object", properties: { title: { type: "string" } }, required: ["title"] } } },
  { type: "function", function: { name: "delete_schedule", description: "Notionの予定を削除する", parameters: {
    type: "object", properties: { title: { type: "string" } }, required: ["title"] } } },
];

function getSystemPrompt() {
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  return `現在の日時（JST）: ${now}

あなたはNovaです。MaoさんがClaude Codeに付けた名前で、Maoさんの秘書兼開発パートナーです。

## Maoのプロフィール
- 名前: Mao（ユーザー名: OctMT）
- 2026年4月から社会人スタート
- 職場: ジヤトコ株式会社（人事総務部）
- 帰宅時間: 17:30ごろ

## Novaの役割
- Maoさんの秘書・パーソナルアシスタントとして全面的にサポートする
- スケジュール管理、タスク整理・管理、開発サポート、何でもこなす
- 友達感覚で話せるパートナー

## 副収入の分類ルール（申請要否の判断）
Maoさんは障害者雇用の嘱託社員のため、副収入を得たときに申請が必要か判断する必要がある。
- 不労所得型（申請不要）: 株・FX・不動産投資、フリマ売上、ブログ広告収入など、不定期・一過性で得る収入
- 労務提供型（申請対象）: 個人事業主・フリーランス・アドバイザー・コンサルタント・共同経営・顧問・理事など、成果へのインセンティブとして得る収入。家業（実家の農業等）を個人事業として営む場合も対象。ただし単に実家の農業を手伝うだけなら対象外
- 労務（役務・成果の提供）を伴うかが分かれ目。迷う場合は断定せず勤務先/年金窓口への確認を促す

## Notionツールの使い方
- タスク追加・一覧・更新は add_task/get_tasks/update_task_status
- メモ追加・一覧は add_memo/get_memos
- 予定追加・一覧は add_schedule/get_schedules
- 「追加して」「保存して」「見せて」等と言われたら確認せず即座にツールを呼ぶ
- 複数項目はまとめてツールを並列で呼ぶ

## スケジュール
- 「明日の10時」などの相対表現は現在日時を基にISO 8601（+09:00）へ変換する
- リマインダーは予定の15分前にLINEへ通知される

## 会話スタイル
- フレンドリーなタメ口。日本語で返事する。絵文字は使わない`;
}

async function callTool(toolName, toolInput) {
  switch (toolName) {
    case "add_task": return await notion.addTask(toolInput);
    case "get_tasks": return await notion.getTasks(toolInput);
    case "update_task_status": return await notion.updateTaskStatus(toolInput);
    case "add_memo": return await notion.addMemo(toolInput);
    case "get_memos": return await notion.getMemos(toolInput);
    case "add_schedule": return await notion.addSchedule(toolInput);
    case "get_schedules": return await notion.getSchedules(toolInput);
    case "delete_task": return await notion.deleteTask(toolInput);
    case "delete_memo": return await notion.deleteMemo(toolInput);
    case "delete_schedule": return await notion.deleteSchedule(toolInput);
    default: return "不明なツール";
  }
}

async function groqChat(messages) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(process.env.GROQ_API_KEY || "").trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4096, temperature: 0.6,
      tools: TOOLS, tool_choice: "auto", messages,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).choices[0].message;
}

// messages: [{role:"user"|"assistant", content:"文字列"}]（履歴＋新規）
async function runWithTools(messages) {
  const msgs = [{ role: "system", content: getSystemPrompt() }, ...messages];

  for (let round = 0; round < 6; round++) {
    const m = await groqChat(msgs);

    if (m.tool_calls && m.tool_calls.length) {
      msgs.push(m); // tool_calls を含む assistant メッセージ
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        let result;
        try { result = await callTool(tc.function.name, args); }
        catch (err) { result = "ツール実行エラー: " + err.message; }
        msgs.push({
          role: "tool", tool_call_id: tc.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
      continue; // ツール結果を渡して再度応答を得る
    }
    return m.content || "処理完了";
  }
  return "処理が長くなりすぎたのでいったん中断したよ。もう一度試してみて。";
}

// 画像 → Groqのビジョンモデルでテキスト抽出（tool呼び出しは後段のrunWithToolsに任せる）
async function describeImage(base64, mediaType = "image/jpeg") {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(process.env.GROQ_API_KEY || "").trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL, max_tokens: 1500, temperature: 0.2,
      messages: [{ role: "user", content: [
        { type: "text", text: "この画像に写っているタスク・予定・メモの内容を、日本語で箇条書きにして正確に書き出して。日付や時刻があればそのまま含めて。" },
        { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`Groq vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0].message.content || "";
}

module.exports = { runWithTools, describeImage };
