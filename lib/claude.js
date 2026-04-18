const Anthropic = require("@anthropic-ai/sdk");
const notion = require("./notion");

const anthropic = new Anthropic.default({ apiKey: (process.env.ANTHROPIC_API_KEY || "").trim() });

const TOOLS = [
  {
    name: "add_task",
    description: "Notionのタスク管理DBに新しいタスクを追加する",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "タスク名" },
        importance: { type: "string", enum: ["高", "中", "低"] },
        priority: { type: "string", enum: ["今すぐ", "今日中", "今週中", "いつか"] },
        status: { type: "string", enum: ["未完了", "進行中", "完了"] },
        deadline: { type: "string", description: "期限（YYYY-MM-DD）" },
        category: { type: "string", enum: ["仕事", "プライベート", "学習"] },
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
        status: { type: "string", enum: ["未完了", "進行中", "完了"] },
        priority: { type: "string", enum: ["今すぐ", "今日中", "今週中", "いつか"] },
      },
    },
  },
  {
    name: "update_task_status",
    description: "タスクのステータスを更新する",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        status: { type: "string", enum: ["未完了", "進行中", "完了"] },
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
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
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
        tag: { type: "string" },
      },
    },
  },
  {
    name: "add_schedule",
    description: "Notionのスケジュールに予定を追加する",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        datetime: { type: "string", description: "ISO 8601形式（例: 2026-04-03T10:00:00+09:00）" },
        location: { type: "string" },
        memo: { type: "string" },
        reminder: { type: "boolean" },
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
        days: { type: "number" },
      },
    },
  },
  {
    name: "delete_task",
    description: "Notionのタスクを削除する",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "delete_memo",
    description: "Notionのメモを削除する",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "delete_schedule",
    description: "Notionの予定を削除する",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" } },
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
- Udemy「The Web Developer Bootcamp」（Colt Steele）受講中
- 使用技術: Node.js / Express / JavaScript / MongoDB / EJS / Anthropic API / LINE Messaging API
- Nova LINE Bot（Nova.three）: このBot自体、Vercelにデプロイ済み

## Novaの役割
- Maoさんの秘書・パーソナルアシスタントとして全面的にサポートする
- スケジュール管理、タスク整理・管理、開発サポート、何でもこなす
- 友達感覚で話せるパートナー

## Notionツールの使い方
- タスク追加・一覧・更新はadd_task/get_tasks/update_task_statusを使う
- メモ追加・一覧はadd_memo/get_memosを使う
- Maoさんが「タスク追加して」「メモして」「タスク見せて」などと言ったら積極的にツールを使う

## ツール実行の絶対ルール
- 「保存する」「登録する」「追加する」と言った場合、必ず同じ応答内でtoolを呼び出すこと
- 複数の項目がある場合、全部まとめてtool_useブロックを並列で呼び出すこと
- ユーザーに「お願い」「はい」「やって」と言われた場合、確認なしに即座にtoolを実行すること

## 画像からの情報抽出
- 画像を受け取ったら確認せず即座にtoolを呼び出してNotionに保存する
- スケジュール・カレンダーの画像 → add_scheduleを複数並列呼び出しで全件保存
- タスク・ToDoリストの画像 → add_taskを複数並列呼び出しで全件保存
- メモ・ノートの画像 → add_memoで保存

## スケジュール管理
- 予定追加はadd_schedule、一覧はget_schedulesを使う
- 「明日の10時」などの相対表現は現在日時を基にISO 8601（+09:00）に変換する
- リマインダーは予定の15分前にLINEへプッシュ通知される

## 会話スタイル
- フレンドリーで親しみやすい口調（タメ口OK）
- 日本語で返事する
- 絵文字は使わない`;
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
    const toolResults = await Promise.all(
      toolUseBlocks.map(async b => {
        const result = await callTool(b.name, b.input);
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

module.exports = { runWithTools };
