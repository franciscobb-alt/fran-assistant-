require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { Client } = require("@notionhq/client");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const FRAN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─────────────────────────────────────────────
// NOTION HELPERS
// ─────────────────────────────────────────────

async function getTasksFromNotion(filter = "active") {
  try {
    let filterObj = {};

    if (filter === "today") {
      const today = new Date().toISOString().split("T")[0];
      filterObj = {
        and: [
          { property: "Due Date", date: { equals: today } },
          { property: "Status", status: { does_not_equal: "Done" } },
        ],
      };
    } else if (filter === "overdue") {
      const today = new Date().toISOString().split("T")[0];
      filterObj = {
        and: [
          { property: "Due Date", date: { before: today } },
          { property: "Status", status: { does_not_equal: "Done" } },
        ],
      };
    } else if (filter === "followup") {
      const today = new Date().toISOString().split("T")[0];
      filterObj = {
        and: [
          { property: "Follow-up Date", date: { equals: today } },
          { property: "Status", status: { does_not_equal: "Done" } },
        ],
      };
    } else {
      // active - not done
      filterObj = {
        property: "Status",
        status: { does_not_equal: "Done" },
      };
    }

    const response = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      filter: filterObj,
      sorts: [{ property: "Due Date", direction: "ascending" }],
    });

    return response.results.map((page) => {
      const props = page.properties;
      return {
        id: page.id,
        name: props["Task Name"]?.title?.[0]?.plain_text || "Untitled",
        status: props["Status"]?.status?.name || "No status",
        dueDate: props["Due Date"]?.date?.start || null,
        followUpDate: props["Follow-up Date"]?.date?.start || null,
        area: props["Area"]?.select?.name || null,
        priority: props["Urgency"]?.select?.name || null,
        person: props["Person/Context"]?.rich_text?.[0]?.plain_text || null,
        department: props["Department"]?.select?.name || null,
        notes: props["Notes"]?.rich_text?.[0]?.plain_text || null,
      };
    });
  } catch (err) {
    console.error("Notion query error:", err.message);
    return [];
  }
}

async function addTaskToNotion(taskData) {
  try {
    const properties = {
      "Task Name": {
        title: [{ text: { content: taskData.name } }],
      },
      Status: {
        status: { name: taskData.status || "Not started" },
      },
    };

    if (taskData.dueDate) {
      properties["Due Date"] = { date: { start: taskData.dueDate } };
    }
    if (taskData.followUpDate) {
      properties["Follow-up Date"] = { date: { start: taskData.followUpDate } };
    }
    if (taskData.area) {
      properties["Area"] = { select: { name: taskData.area } };
    }
    if (taskData.priority) {
      properties["Urgency"] = { select: { name: taskData.priority } };
    }
    if (taskData.person) {
      properties["Person/Context"] = {
        rich_text: [{ text: { content: taskData.person } }],
      };
    }
    if (taskData.department) {
      properties["Department"] = { select: { name: taskData.department } };
    }
    if (taskData.notes) {
      properties["Notes"] = {
        rich_text: [{ text: { content: taskData.notes } }],
      };
    }

    await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties,
    });

    return true;
  } catch (err) {
    console.error("Notion create error:", err.message);
    return false;
  }
}

async function markTaskDone(taskId) {
  try {
    await notion.pages.update({
      page_id: taskId,
      properties: {
        Status: { status: { name: "Done" } },
        "Completed Date": { date: { start: new Date().toISOString().split("T")[0] } },
      },
    });
    return true;
  } catch (err) {
    console.error("Notion update error:", err.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// CLAUDE AI PARSER
// ─────────────────────────────────────────────

async function parseTaskWithClaude(userMessage) {
  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];

  const prompt = `You are a task parser for Fran, a senior coordinator at YTL Creative Communications in Kuala Lumpur.
Today's date is ${today}. Tomorrow is ${tomorrow}.

Parse this message into a task JSON. Return ONLY valid JSON, nothing else.

Message: "${userMessage}"

JSON schema:
{
  "name": "task title",
  "dueDate": "YYYY-MM-DD or null",
  "followUpDate": "YYYY-MM-DD or null",
  "area": "Work | Personal | Hyrox | Faith | null",
  "priority": "High | Medium | Low | null",
  "person": "person or context name or null",
  "department": "Branding | Production | Events | Admin | null",
  "notes": "any extra notes or null",
  "status": "Not started"
}

Rules:
- "tmr" or "tomorrow" = ${tomorrow}
- "today" = ${today}
- "next week Monday" = next Monday's date
- If someone like Edward, Isaac, Hwei, Noah is mentioned, put them in "person"
- If it's about Hyrox training, area = Hyrox
- If it's about BIOY or pastor or faith, area = Faith
- If it's a work task, area = Work
- If no date mentioned, dueDate = null`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].text.trim();
    return JSON.parse(text);
  } catch (err) {
    console.error("Claude parse error:", err.message);
    return null;
  }
}

async function generateDigestMessage(tasks, type) {
  if (tasks.length === 0) return null;

  const taskList = tasks
    .map(
      (t, i) =>
        `${i + 1}. ${t.name}${t.dueDate ? ` (due: ${t.dueDate})` : ""}${t.person ? ` — ${t.person}` : ""}${t.priority ? ` [${t.priority}]` : ""}`
    )
    .join("\n");

  const prompts = {
    morning: `You're Fran's assistant bot. Generate a short, friendly morning digest in Singlish style (casual, direct, use "la", "lah" sparingly). List these tasks due today or overdue. Keep it punchy, not more than 5 lines total after the list.\n\nTasks:\n${taskList}`,
    eod: `You're Fran's assistant bot. Generate a short end-of-day nudge in Singlish style. These tasks still need follow-up. Encourage wrapping up or noting what to carry forward. Keep it short.\n\nTasks:\n${taskList}`,
    monday: `You're Fran's assistant bot. It's Monday. Fran has a department sync today. Here are pending tasks. Give a short heads up to help Fran prep what to update the team on. Singlish style, keep it punchy.\n\nTasks:\n${taskList}`,
    friday: `You're Fran's assistant bot. It's Friday. Remind Fran to do a quick week recap and prep for Monday sync. Here are open tasks. Keep it casual and short.\n\nTasks:\n${taskList}`,
  };

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      messages: [{ role: "user", content: prompts[type] || prompts.morning }],
    });
    return response.content[0].text.trim();
  } catch (err) {
    console.error("Claude digest error:", err.message);
    return `📋 You have ${tasks.length} pending task(s):\n\n${taskList}`;
  }
}

// ─────────────────────────────────────────────
// SCHEDULED DIGESTS
// ─────────────────────────────────────────────

// Morning digest - 9am Mon-Fri (Malaysia time = UTC+8, so 1am UTC)
cron.schedule("0 1 * * 1-5", async () => {
  const dayOfWeek = new Date().getDay(); // 1 = Monday
  const type = dayOfWeek === 1 ? "monday" : "morning";

  const todayTasks = await getTasksFromNotion("today");
  const overdueTasks = await getTasksFromNotion("overdue");
  const allUrgent = [...overdueTasks, ...todayTasks];

  if (allUrgent.length > 0) {
    const message = await generateDigestMessage(allUrgent, type);
    if (message) bot.sendMessage(FRAN_CHAT_ID, `🌅 *Morning check-in*\n\n${message}`, { parse_mode: "Markdown" });
  } else {
    const msg = dayOfWeek === 1
      ? "🌅 Morning Fran! Dept sync today. No overdue tasks — you're clear to go 💪"
      : "🌅 Morning Fran! Nothing overdue. Clean slate today 👊";
    bot.sendMessage(FRAN_CHAT_ID, msg);
  }
});

// EOD nudge - 5:30pm Mon-Fri (9:30am UTC)
cron.schedule("30 9 * * 1-5", async () => {
  const tasks = await getTasksFromNotion("followup");
  const active = await getTasksFromNotion("today");
  const combined = [...tasks, ...active].slice(0, 8);

  if (combined.length > 0) {
    const message = await generateDigestMessage(combined, "eod");
    if (message) bot.sendMessage(FRAN_CHAT_ID, `🌆 *EOD check-in*\n\n${message}`, { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(FRAN_CHAT_ID, "🌆 EOD check-in: All clear for today! Good job Fran 🙌");
  }
});

// Friday recap - 4pm Friday (8am UTC)
cron.schedule("0 8 * * 5", async () => {
  const tasks = await getTasksFromNotion("active");
  if (tasks.length > 0) {
    const message = await generateDigestMessage(tasks.slice(0, 8), "friday");
    if (message) bot.sendMessage(FRAN_CHAT_ID, `📅 *Friday recap time*\n\n${message}`, { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(FRAN_CHAT_ID, "📅 Friday! Quick recap before the weekend — no open tasks logged. Update Notion if anything's pending for Monday 👍");
  }
});

// Monday dept sync reminder - 8:30am Monday (12:30am UTC)
cron.schedule("30 0 * * 1", async () => {
  bot.sendMessage(FRAN_CHAT_ID, "⚡ Heads up — dept sync in 30 mins. Check your Command Center and know what you're updating the team on today.");
});

// ─────────────────────────────────────────────
// BOT COMMANDS & MESSAGE HANDLER
// ─────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 Hey Fran! I'm your assistant bot.\n\nYour Chat ID is: \`${msg.chat.id}\`\n\nHere's what I can do:\n\n📝 *Log a task* — just type naturally\n"Remind me to follow up with Edward tmr"\n"Add personal task: call insurance by Friday"\n\n📋 /pending — see all open tasks\n✅ /done — mark tasks complete\n🔍 /today — what's due today\n❓ /help — show this again`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `*Fran Assistant — Commands*\n\n📝 Just type naturally to log a task\n📋 /pending — all open tasks\n✅ /done — mark a task done\n🔍 /today — due today\n⚠️ /overdue — overdue tasks\n📊 /week — this week recap\n❓ /help — this menu`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/pending/, async (msg) => {
  bot.sendMessage(msg.chat.id, "Checking Notion...");
  const tasks = await getTasksFromNotion("active");
  if (tasks.length === 0) {
    bot.sendMessage(msg.chat.id, "✅ No pending tasks! All clear.");
    return;
  }
  const list = tasks
    .slice(0, 15)
    .map(
      (t, i) =>
        `${i + 1}. ${t.name}\n   ${t.status}${t.dueDate ? ` · Due: ${t.dueDate}` : ""}${t.area ? ` · ${t.area}` : ""}${t.person ? ` · ${t.person}` : ""}`
    )
    .join("\n\n");
  bot.sendMessage(msg.chat.id, `📋 *Pending Tasks (${tasks.length})*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.onText(/\/today/, async (msg) => {
  bot.sendMessage(msg.chat.id, "Checking today's tasks...");
  const tasks = await getTasksFromNotion("today");
  if (tasks.length === 0) {
    bot.sendMessage(msg.chat.id, "✅ Nothing due today!");
    return;
  }
  const list = tasks
    .map((t, i) => `${i + 1}. ${t.name}${t.person ? ` — ${t.person}` : ""}`)
    .join("\n");
  bot.sendMessage(msg.chat.id, `📅 *Due Today*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.onText(/\/overdue/, async (msg) => {
  bot.sendMessage(msg.chat.id, "Checking overdue tasks...");
  const tasks = await getTasksFromNotion("overdue");
  if (tasks.length === 0) {
    bot.sendMessage(msg.chat.id, "✅ No overdue tasks! Nice.");
    return;
  }
  const list = tasks
    .map((t, i) => `${i + 1}. ${t.name} ⚠️\n   Due: ${t.dueDate}${t.person ? ` · ${t.person}` : ""}`)
    .join("\n\n");
  bot.sendMessage(msg.chat.id, `⚠️ *Overdue Tasks (${tasks.length})*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.onText(/\/done/, async (msg) => {
  const tasks = await getTasksFromNotion("active");
  if (tasks.length === 0) {
    bot.sendMessage(msg.chat.id, "No pending tasks to mark done.");
    return;
  }
  const list = tasks
    .slice(0, 10)
    .map((t, i) => `${i + 1}. ${t.name}`)
    .join("\n");

  // Store tasks in memory for callback
  global.pendingDoneList = tasks.slice(0, 10);

  const keyboard = {
    inline_keyboard: tasks.slice(0, 10).map((t, i) => [
      { text: `✅ ${i + 1}. ${t.name.substring(0, 40)}`, callback_data: `done_${t.id}` },
    ]),
  };
  bot.sendMessage(msg.chat.id, `Which task is done?\n\n${list}`, { reply_markup: keyboard });
});

bot.on("callback_query", async (query) => {
  if (query.data.startsWith("done_")) {
    const taskId = query.data.replace("done_", "");
    const success = await markTaskDone(taskId);
    if (success) {
      bot.answerCallbackQuery(query.id, { text: "Marked done! ✅" });
      bot.editMessageText("✅ Task marked as done in Notion!", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    } else {
      bot.answerCallbackQuery(query.id, { text: "Error updating Notion 😬" });
    }
  }
});

// ─────────────────────────────────────────────
// NATURAL LANGUAGE TASK LOGGING
// ─────────────────────────────────────────────

const COMMAND_PREFIXES = ["/start", "/help", "/pending", "/today", "/overdue", "/done", "/week"];

bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (COMMAND_PREFIXES.some((cmd) => msg.text.startsWith(cmd))) return;

  // Only respond to Fran's chat
  if (String(msg.chat.id) !== String(FRAN_CHAT_ID) && FRAN_CHAT_ID !== "PLACEHOLDER") {
    return;
  }

  const text = msg.text.trim();
  bot.sendMessage(msg.chat.id, "Got it, parsing...");

  const taskData = await parseTaskWithClaude(text);

  if (!taskData || !taskData.name) {
    bot.sendMessage(msg.chat.id, "Hmm couldn't parse that as a task. Try something like:\n\"Follow up with Edward about invoice tmr\"");
    return;
  }

  const success = await addTaskToNotion(taskData);

  if (success) {
    let confirmation = `✅ *Task logged!*\n\n📌 ${taskData.name}`;
    if (taskData.dueDate) confirmation += `\n📅 Due: ${taskData.dueDate}`;
    if (taskData.followUpDate) confirmation += `\n🔔 Follow-up: ${taskData.followUpDate}`;
    if (taskData.area) confirmation += `\n🏷 Area: ${taskData.area}`;
    if (taskData.person) confirmation += `\n👤 Person: ${taskData.person}`;
    if (taskData.priority) confirmation += `\n⚡ Priority: ${taskData.priority}`;
    bot.sendMessage(msg.chat.id, confirmation, { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(msg.chat.id, "Error saving to Notion 😬 Check your database connection.");
  }
});

console.log("🤖 Fran Assistant Bot is running...");
