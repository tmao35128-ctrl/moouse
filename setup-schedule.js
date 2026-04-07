require("dotenv").config();
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function setup() {
  const scheduleDB = await notion.databases.create({
    parent: { type: "page_id", page_id: "33659192-177b-80ec-b5e8-c7baed71226e" },
    title: [{ type: "text", text: { content: "スケジュール" } }],
    properties: {
      タイトル: { title: {} },
      日時: { date: {} },
      場所: { rich_text: {} },
      メモ: { rich_text: {} },
      リマインダー: { checkbox: {} },
      リマインダー送信済み: { checkbox: {} },
    },
  });
  console.log("スケジュールDB作成:", scheduleDB.id);
  console.log("\n.envに追加してください:");
  console.log(`NOTION_SCHEDULE_DB_ID=${scheduleDB.id}`);
}

setup().catch(console.error);
