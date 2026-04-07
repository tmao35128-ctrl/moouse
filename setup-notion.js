require("dotenv").config();
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function setup() {
  // タスク管理DB
  const taskDB = await notion.databases.create({
    parent: { type: "page_id", page_id: "33659192-177b-80ec-b5e8-c7baed71226e" },
    title: [{ type: "text", text: { content: "タスク管理" } }],
    properties: {
      タスク名: { title: {} },
      重要度: {
        select: {
          options: [
            { name: "高", color: "red" },
            { name: "中", color: "yellow" },
            { name: "低", color: "blue" },
          ],
        },
      },
      優先順位: {
        select: {
          options: [
            { name: "今すぐ", color: "red" },
            { name: "今日中", color: "orange" },
            { name: "今週中", color: "yellow" },
            { name: "いつか", color: "gray" },
          ],
        },
      },
      ステータス: {
        select: {
          options: [
            { name: "未完了", color: "orange" },
            { name: "進行中", color: "blue" },
            { name: "完了", color: "green" },
          ],
        },
      },
      期限: { date: {} },
      カテゴリ: {
        select: {
          options: [
            { name: "仕事", color: "purple" },
            { name: "プライベート", color: "pink" },
            { name: "学習", color: "green" },
          ],
        },
      },
    },
  });
  console.log("タスク管理DB作成:", taskDB.id);

  // メモDB
  const memoDB = await notion.databases.create({
    parent: { type: "page_id", page_id: "33659192-177b-80ec-b5e8-c7baed71226e" },
    title: [{ type: "text", text: { content: "メモ" } }],
    properties: {
      タイトル: { title: {} },
      内容: { rich_text: {} },
      タグ: { multi_select: { options: [] } },
      日付: { date: {} },
    },
  });
  console.log("メモDB作成:", memoDB.id);

  console.log("\n.envに追加してください:");
  console.log(`NOTION_TASK_DB_ID=${taskDB.id}`);
  console.log(`NOTION_MEMO_DB_ID=${memoDB.id}`);
}

setup().catch(console.error);
