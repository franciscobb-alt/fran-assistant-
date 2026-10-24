// OneChat server: plain Node http + ws, data kept in a JSON file.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_MEDIA_BYTES = 3 * 1024 * 1024; // data URLs, so keep it modest
const HISTORY_LIMIT = 300; // messages per chat sent on login

// ─────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────

let db = { users: {}, chats: {}, messages: {}, sessions: {} };
if (fs.existsSync(DATA_FILE)) {
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
  } catch (err) {
    console.error("Could not read data file, starting empty:", err.message);
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), (err) => {
      if (err) console.error("Save failed:", err.message);
    });
  }, 300);
}

const id = (bytes = 8) => crypto.randomBytes(bytes).toString("hex");

// BlackBerry-style 8 character PIN, e.g. 2A4F9C1B
function newPin() {
  let pin;
  do pin = crypto.randomBytes(4).toString("hex").toUpperCase();
  while (db.users[pin]);
  return pin;
}

function hashPassword(password, salt = id(16)) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}

// ─────────────────────────────────────────────
// PRESENCE + FAN-OUT
// ─────────────────────────────────────────────

const sockets = new Map(); // pin -> Set<ws>, one per device

const isOnline = (pin) => sockets.has(pin) && sockets.get(pin).size > 0;

function publicUser(pin) {
  const u = db.users[pin];
  if (!u) return null;
  return {
    pin: u.pin,
    name: u.name,
    status: u.status,
    avatar: u.avatar || null,
    online: isOnline(pin),
    lastSeen: u.lastSeen,
  };
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function sendTo(pins, payload, exceptWs = null) {
  const data = JSON.stringify(payload);
  for (const pin of new Set(pins)) {
    for (const ws of sockets.get(pin) || []) {
      if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(data);
    }
  }
}

// Everyone who shares a chat with this user, plus their contacts
function circleOf(pin) {
  const out = new Set(db.users[pin]?.contacts || []);
  for (const chat of Object.values(db.chats)) {
    if (chat.members.includes(pin)) chat.members.forEach((m) => out.add(m));
  }
  out.delete(pin);
  return [...out];
}

function broadcastPresence(pin) {
  sendTo(circleOf(pin), { type: "user", user: publicUser(pin) });
}

// ─────────────────────────────────────────────
// CHAT HELPERS
// ─────────────────────────────────────────────

function chatView(chat, forPin) {
  const view = { ...chat };
  // only admins see the invite code
  if (!chat.admins.includes(forPin)) delete view.invite;
  return view;
}

function findMessage(chatId, msgId) {
  return (db.messages[chatId] || []).find((m) => m.id === msgId);
}

function canSee(pin, chat) {
  return chat && chat.members.includes(pin);
}

function findDm(a, b) {
  return Object.values(db.chats).find(
    (c) => c.type === "dm" && c.members.includes(a) && c.members.includes(b)
  );
}

function createChat({ type, name, members, admins, createdBy }) {
  const chat = {
    id: id(),
    type,
    name: name || "",
    description: "",
    members: [...new Set(members)],
    admins: [...new Set(admins)],
    pinned: null,
    disappear: 0,
    invite: type === "dm" ? null : id(5),
    createdBy,
    createdAt: Date.now(),
  };
  db.chats[chat.id] = chat;
  db.messages[chat.id] = [];
  return chat;
}

function pushChat(chat) {
  for (const pin of chat.members) {
    sendTo([pin], {
      type: "chat",
      chat: chatView(chat, pin),
      users: chat.members.map(publicUser).filter(Boolean),
    });
  }
}

function systemMessage(chat, text) {
  const msg = {
    id: id(),
    chatId: chat.id,
    from: null,
    kind: "system",
    text,
    ts: Date.now(),
    reactions: {},
    deliveredTo: [],
    readBy: [],
  };
  db.messages[chat.id].push(msg);
  sendTo(chat.members, { type: "message", message: msg });
}

// Called when a device comes online: anything waiting for it is now delivered
function markDeliveredOnConnect(pin) {
  for (const chat of Object.values(db.chats)) {
    if (!chat.members.includes(pin)) continue;
    for (const msg of db.messages[chat.id] || []) {
      if (msg.from && msg.from !== pin && !msg.deliveredTo.includes(pin)) {
        msg.deliveredTo.push(pin);
        sendTo([msg.from], {
          type: "receipt",
          chatId: chat.id,
          msgId: msg.id,
          deliveredTo: msg.deliveredTo,
          readBy: msg.readBy,
        });
      }
    }
  }
}

// ─────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────

function startSession(ws, pin, token) {
  ws.pin = pin;
  if (!sockets.has(pin)) sockets.set(pin, new Set());
  sockets.get(pin).add(ws);

  const me = db.users[pin];
  const chats = Object.values(db.chats).filter((c) => c.members.includes(pin));
  const userPins = new Set(me.contacts);
  chats.forEach((c) => c.members.forEach((m) => userPins.add(m)));

  markDeliveredOnConnect(pin);

  send(ws, {
    type: "init",
    token,
    me: { ...publicUser(pin), contacts: me.contacts },
    users: [...userPins].map(publicUser).filter(Boolean),
    chats: chats.map((c) => chatView(c, pin)),
    messages: Object.fromEntries(
      chats.map((c) => [c.id, (db.messages[c.id] || []).slice(-HISTORY_LIMIT)])
    ),
  });
  broadcastPresence(pin);
  save();
}

const handlers = {
  register(ws, { name, password }) {
    name = String(name || "").trim().slice(0, 40);
    if (!name || !password || String(password).length < 6) {
      return send(ws, { type: "error", error: "Name and a 6+ character password are required." });
    }
    const pin = newPin();
    db.users[pin] = {
      pin,
      name,
      status: "Available",
      contacts: [],
      createdAt: Date.now(),
      lastSeen: Date.now(),
      ...hashPassword(String(password)),
    };
    const token = id(24);
    db.sessions[token] = pin;
    startSession(ws, pin, token);
  },

  login(ws, { pin, password }) {
    pin = String(pin || "").trim().toUpperCase();
    const user = db.users[pin];
    if (!user || !checkPassword(user, String(password || ""))) {
      return send(ws, { type: "error", error: "Wrong PIN or password." });
    }
    const token = id(24);
    db.sessions[token] = pin;
    startSession(ws, pin, token);
  },

  resume(ws, { token }) {
    const pin = db.sessions[token];
    if (!pin || !db.users[pin]) return send(ws, { type: "logout" });
    startSession(ws, pin, token);
  },

  logout(ws, { token }) {
    delete db.sessions[token];
    save();
    send(ws, { type: "logout" });
    ws.close();
  },

  profile(ws, { name, status, avatar }) {
    const u = db.users[ws.pin];
    if (name) u.name = String(name).trim().slice(0, 40);
    if (status !== undefined) u.status = String(status).slice(0, 140);
    if (avatar !== undefined) {
      if (avatar && avatar.length > MAX_MEDIA_BYTES) return;
      u.avatar = avatar || null;
    }
    save();
    sendTo([ws.pin], { type: "user", user: publicUser(ws.pin) });
    broadcastPresence(ws.pin);
  },

  // Add a contact by PIN and open a DM, BBM style
  addContact(ws, { pin }) {
    pin = String(pin || "").trim().toUpperCase();
    if (!db.users[pin] || pin === ws.pin) {
      return send(ws, { type: "error", error: "No one with that PIN." });
    }
    const me = db.users[ws.pin];
    const them = db.users[pin];
    if (!me.contacts.includes(pin)) me.contacts.push(pin);
    if (!them.contacts.includes(ws.pin)) them.contacts.push(ws.pin);

    let chat = findDm(ws.pin, pin);
    if (!chat) {
      chat = createChat({ type: "dm", members: [ws.pin, pin], admins: [ws.pin, pin], createdBy: ws.pin });
    }
    save();
    pushChat(chat);
    send(ws, { type: "open", chatId: chat.id });
  },

  // type is "group" (everyone talks) or "channel" (admins broadcast)
  createChat(ws, { chatType: type, name, members }) {
    if (!["group", "channel"].includes(type)) return;
    name = String(name || "").trim().slice(0, 60);
    if (!name) return send(ws, { type: "error", error: "Give it a name." });
    const valid = (members || []).map((p) => String(p).toUpperCase()).filter((p) => db.users[p]);
    const chat = createChat({
      type,
      name,
      members: [ws.pin, ...valid],
      admins: [ws.pin],
      createdBy: ws.pin,
    });
    systemMessage(chat, `${db.users[ws.pin].name} created ${type === "channel" ? "the channel" : "the group"} "${name}"`);
    save();
    pushChat(chat);
    send(ws, { type: "open", chatId: chat.id });
  },

  joinByInvite(ws, { code }) {
    code = String(code || "").trim();
    const chat = Object.values(db.chats).find((c) => c.invite && c.invite === code);
    if (!chat) return send(ws, { type: "error", error: "That invite code doesn't work." });
    if (!chat.members.includes(ws.pin)) {
      chat.members.push(ws.pin);
      systemMessage(chat, `${db.users[ws.pin].name} joined`);
    }
    save();
    pushChat(chat);
    send(ws, {
      type: "history",
      chatId: chat.id,
      messages: db.messages[chat.id].slice(-HISTORY_LIMIT),
    });
    send(ws, { type: "open", chatId: chat.id });
  },

  addMembers(ws, { chatId, members }) {
    const chat = db.chats[chatId];
    if (!chat || chat.type === "dm" || !chat.admins.includes(ws.pin)) return;
    const added = [];
    for (const p of members || []) {
      const pin = String(p).toUpperCase();
      if (db.users[pin] && !chat.members.includes(pin)) {
        chat.members.push(pin);
        added.push(db.users[pin].name);
        sendTo([pin], { type: "history", chatId, messages: db.messages[chatId].slice(-HISTORY_LIMIT) });
      }
    }
    if (added.length) systemMessage(chat, `${db.users[ws.pin].name} added ${added.join(", ")}`);
    save();
    pushChat(chat);
  },

  leaveChat(ws, { chatId }) {
    const chat = db.chats[chatId];
    if (!canSee(ws.pin, chat) || chat.type === "dm") return;
    chat.members = chat.members.filter((m) => m !== ws.pin);
    chat.admins = chat.admins.filter((m) => m !== ws.pin);
    if (!chat.admins.length && chat.members.length) chat.admins.push(chat.members[0]);
    systemMessage(chat, `${db.users[ws.pin].name} left`);
    save();
    pushChat(chat);
    sendTo([ws.pin], { type: "removed", chatId });
  },

  updateChat(ws, { chatId, name, description, disappear }) {
    const chat = db.chats[chatId];
    if (!canSee(ws.pin, chat)) return;
    // in a DM both people can change the timer, in groups only admins
    if (chat.type !== "dm" && !chat.admins.includes(ws.pin)) return;
    const who = db.users[ws.pin].name;
    if (name && chat.type !== "dm") chat.name = String(name).slice(0, 60);
    if (description !== undefined) chat.description = String(description).slice(0, 300);
    if (disappear !== undefined) {
      chat.disappear = Math.max(0, Number(disappear) || 0);
      systemMessage(
        chat,
        chat.disappear ? `${who} turned on disappearing messages (${humanDuration(chat.disappear)})` : `${who} turned off disappearing messages`
      );
    }
    save();
    pushChat(chat);
  },

  send(ws, { chatId, text, kind = "text", media, fileName, replyTo, effect, silent, clientId, duration }) {
    const chat = db.chats[chatId];
    if (!canSee(ws.pin, chat)) return;
    if (chat.type === "channel" && !chat.admins.includes(ws.pin)) {
      return send(ws, { type: "error", error: "Only admins can post in this channel." });
    }
    if (!["text", "image", "voice", "file", "ping"].includes(kind)) return;
    text = String(text || "").slice(0, 8000);
    if (media && media.length > MAX_MEDIA_BYTES) {
      return send(ws, { type: "error", error: "That file is too big (3 MB max for now)." });
    }
    if (kind === "text" && !text.trim()) return;

    const recipients = chat.members.filter((m) => m !== ws.pin);
    const msg = {
      id: id(),
      clientId,
      chatId,
      from: ws.pin,
      kind,
      text,
      media: media || null,
      fileName: kind === "file" ? String(fileName || "file").slice(0, 120) : undefined,
      duration: Number(duration) || undefined,
      replyTo: replyTo && findMessage(chatId, replyTo) ? replyTo : null,
      effect: ["slam", "confetti", "loud", "gentle"].includes(effect) ? effect : null,
      silent: !!silent,
      ts: Date.now(),
      editedAt: null,
      deleted: false,
      reactions: {},
      deliveredTo: recipients.filter(isOnline),
      readBy: [],
      expiresAt: chat.disappear ? Date.now() + chat.disappear * 1000 : null,
    };
    db.messages[chatId].push(msg);
    save();
    sendTo(chat.members, { type: "message", message: msg });
  },

  edit(ws, { chatId, msgId, text }) {
    const msg = findMessage(chatId, msgId);
    if (!msg || msg.from !== ws.pin || msg.deleted || msg.kind !== "text") return;
    text = String(text || "").slice(0, 8000);
    if (!text.trim()) return;
    msg.text = text;
    msg.editedAt = Date.now();
    save();
    sendTo(db.chats[chatId].members, { type: "update", message: msg });
  },

  // Delete for everyone. The bubble stays as a tombstone, like WhatsApp
  delete(ws, { chatId, msgId }) {
    const chat = db.chats[chatId];
    const msg = findMessage(chatId, msgId);
    if (!msg || !chat) return;
    const isAdminInGroup = chat.type !== "dm" && chat.admins.includes(ws.pin);
    if (msg.from !== ws.pin && !isAdminInGroup) return;
    Object.assign(msg, { deleted: true, text: "", media: null, reactions: {}, kind: "text" });
    if (chat.pinned === msgId) chat.pinned = null;
    save();
    sendTo(chat.members, { type: "update", message: msg });
    pushChat(chat);
  },

  // iMessage tapback: one reaction per person, tapping the same one removes it
  react(ws, { chatId, msgId, emoji }) {
    const chat = db.chats[chatId];
    const msg = findMessage(chatId, msgId);
    if (!canSee(ws.pin, chat) || !msg || msg.deleted) return;
    if (msg.reactions[ws.pin] === emoji || !emoji) delete msg.reactions[ws.pin];
    else msg.reactions[ws.pin] = String(emoji).slice(0, 8);
    save();
    sendTo(chat.members, { type: "update", message: msg });
  },

  pin(ws, { chatId, msgId }) {
    const chat = db.chats[chatId];
    if (!canSee(ws.pin, chat)) return;
    if (chat.type !== "dm" && !chat.admins.includes(ws.pin)) return;
    chat.pinned = chat.pinned === msgId ? null : msgId;
    save();
    pushChat(chat);
  },

  typing(ws, { chatId, state }) {
    const chat = db.chats[chatId];
    if (!canSee(ws.pin, chat) || chat.type === "channel") return;
    sendTo(
      chat.members.filter((m) => m !== ws.pin),
      { type: "typing", chatId, pin: ws.pin, state: state || "typing" }
    );
  },

  read(ws, { chatId }) {
    const chat = db.chats[chatId];
    if (!canSee(ws.pin, chat)) return;
    const changed = [];
    for (const msg of db.messages[chatId]) {
      if (msg.from && msg.from !== ws.pin && !msg.readBy.includes(ws.pin)) {
        msg.readBy.push(ws.pin);
        if (!msg.deliveredTo.includes(ws.pin)) msg.deliveredTo.push(ws.pin);
        changed.push(msg);
      }
    }
    if (!changed.length) return;
    save();
    for (const msg of changed) {
      sendTo([msg.from, ws.pin], {
        type: "receipt",
        chatId,
        msgId: msg.id,
        deliveredTo: msg.deliveredTo,
        readBy: msg.readBy,
      });
    }
  },
};

function humanDuration(s) {
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s}s`;
}

// Disappearing messages sweep
setInterval(() => {
  const now = Date.now();
  for (const [chatId, list] of Object.entries(db.messages)) {
    const gone = list.filter((m) => m.expiresAt && m.expiresAt <= now);
    if (!gone.length) continue;
    db.messages[chatId] = list.filter((m) => !gone.includes(m));
    const chat = db.chats[chatId];
    if (chat) {
      for (const m of gone) sendTo(chat.members, { type: "expired", chatId, msgId: m.id });
    }
    save();
  }
}, 5000);

// ─────────────────────────────────────────────
// HTTP + WEBSOCKET
// ─────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, online: sockets.size }));
  }
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MEDIA_BYTES + 64 * 1024 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const handler = handlers[data.type];
    if (!handler) return;
    const open = ["register", "login", "resume"].includes(data.type);
    if (!open && !ws.pin) return send(ws, { type: "logout" });
    try {
      handler(ws, data);
    } catch (err) {
      console.error(`Handler ${data.type} failed:`, err);
      send(ws, { type: "error", error: "Something went wrong on the server." });
    }
  });

  ws.on("close", () => {
    if (!ws.pin) return;
    const set = sockets.get(ws.pin);
    set?.delete(ws);
    if (set && set.size === 0) {
      sockets.delete(ws.pin);
      db.users[ws.pin].lastSeen = Date.now();
      save();
      broadcastPresence(ws.pin);
    }
  });
});

// Drop dead connections so presence stays honest
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`OneChat running on http://localhost:${PORT}`));
