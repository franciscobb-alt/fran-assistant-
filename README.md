# Fran Assistant Bot

Your personal Telegram assistant connected to Notion Command Center.

## What it does
- 🌅 Morning digest (9am) — what's due or overdue today
- 🌆 EOD nudge (5:30pm) — follow-ups and pending tasks
- 📅 Friday 4pm — week recap prompt before Monday sync
- ⚡ Monday 8:30am — dept sync heads up
- 💬 Natural language task logging — just type to it
- ✅ Mark tasks done inline in Telegram

## Setup Steps

### 1. Create Telegram Bot
- Open Telegram, search for @BotFather
- Send `/newbot`, follow prompts
- Copy the bot token

### 2. Get your Telegram Chat ID
- Start your bot, send `/start`
- The bot will reply with your Chat ID
- Copy that number

### 3. Get Notion Database ID
- Open your Command Center in Notion
- Copy the URL — it looks like:
  `notion.so/xxxxx?v=yyyyy`
- The database ID is the part before the `?v=`
- It looks like: `2fd80542542180…`

### 4. Get Anthropic API Key
- Go to console.anthropic.com
- API Keys → Create new key
- Copy it

### 5. Add missing Notion properties
In your Command Center database, add these properties:
- `Follow-up Date` — type: Date
- `Area` — type: Select (options: Work, Personal, Hyrox, Faith)
- `Person/Context` — type: Text

### 6. Deploy to Railway
- Push this folder to a GitHub repo
- Go to railway.app → New Project → Deploy from GitHub
- Add environment variables from .env.example
- Deploy!

## Environment Variables
```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
NOTION_API_KEY=
NOTION_DATABASE_ID=
ANTHROPIC_API_KEY=
```

## Commands
- Just type naturally to log a task
- `/pending` — all open tasks
- `/today` — due today
- `/overdue` — overdue tasks
- `/done` — mark a task complete
- `/help` — show commands
