// OneChat client. No framework, no build step.
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"];
const EFFECTS = [
  { id: "slam", label: "Slam", icon: "💥" },
  { id: "loud", label: "Loud", icon: "📢" },
  { id: "gentle", label: "Gentle", icon: "🪶" },
  { id: "confetti", label: "Confetti", icon: "🎉" },
];
const MAX_MEDIA = 3 * 1024 * 1024;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const S = {
  token: store.get("oc.token", null),
  me: null,
  users: {},
  chats: {},
  messages: {},
  current: null,
  filter: "all",
  query: "",
  typing: {}, // chatId -> { pin: timeout }
  context: null, // { mode: 'reply'|'edit', msg }
  effect: null,
  silent: false,
  starred: new Set(store.get("oc.starred", [])),
  drafts: store.get("oc.drafts", {}),
  receiptStyle: store.get("oc.receipts", "ticks"), // 'ticks' or 'bbm'
  outbox: [],
  panelOpen: false,
};

// ─────────────────────────────────────────────
// SOCKET
// ─────────────────────────────────────────────

let ws = null;
let retry = 0;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  setConn("Connecting…");

  ws.onopen = () => {
    retry = 0;
    setConn("");
    if (S.token) wsSend({ type: "resume", token: S.token });
    else showAuth();
  };
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
  ws.onclose = () => {
    setConn("Offline. Reconnecting…");
    const wait = Math.min(15000, 500 * 2 ** retry++);
    setTimeout(connect, wait);
  };
}

function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

// Messages queue while offline and flush on reconnect
function sendOrQueue(payload) {
  if (!wsSend(payload)) {
    S.outbox.push(payload);
    toast("You're offline. It'll send when you reconnect.");
  }
}

function setConn(text) {
  $("#conn").textContent = text;
}

// ─────────────────────────────────────────────
// SERVER EVENTS
// ─────────────────────────────────────────────

function onServer(ev) {
  switch (ev.type) {
    case "init": {
      S.token = ev.token;
      store.set("oc.token", ev.token);
      S.me = ev.me;
      S.users = Object.fromEntries(ev.users.map((u) => [u.pin, u]));
      S.users[ev.me.pin] = ev.me;
      S.chats = Object.fromEntries(ev.chats.map((c) => [c.id, c]));
      S.messages = ev.messages;
      showApp();
      while (S.outbox.length) wsSend(S.outbox.shift());
      if (S.current && !S.chats[S.current]) S.current = null;
      renderAll();
      if (S.current) markRead();
      if (sessionStorage.getItem("oc.justRegistered")) {
        sessionStorage.removeItem("oc.justRegistered");
        showPinSheet(true);
      }
      break;
    }
    case "logout":
      S.token = null;
      store.set("oc.token", null);
      showAuth();
      break;
    case "error":
      if (!S.me) $("#authError").textContent = ev.error;
      else toast(ev.error);
      break;
    case "user":
      S.users[ev.user.pin] = { ...S.users[ev.user.pin], ...ev.user };
      if (ev.user.pin === S.me.pin) Object.assign(S.me, ev.user);
      renderSidebar();
      renderHeader();
      if (S.panelOpen) renderPanel();
      break;
    case "chat":
      S.chats[ev.chat.id] = ev.chat;
      ev.users.forEach((u) => (S.users[u.pin] = { ...S.users[u.pin], ...u }));
      if (!S.messages[ev.chat.id]) S.messages[ev.chat.id] = [];
      renderSidebar();
      if (S.current === ev.chat.id) {
        renderHeader();
        renderPinned();
        renderComposer();
        if (S.panelOpen) renderPanel();
      }
      break;
    case "history":
      S.messages[ev.chatId] = ev.messages;
      if (S.current === ev.chatId) renderMessages();
      break;
    case "open":
      openChat(ev.chatId);
      break;
    case "removed":
      delete S.chats[ev.chatId];
      delete S.messages[ev.chatId];
      if (S.current === ev.chatId) closeChat();
      renderSidebar();
      break;
    case "message":
      onMessage(ev.message);
      break;
    case "update":
      replaceMessage(ev.message);
      break;
    case "receipt": {
      const msg = findMsg(ev.chatId, ev.msgId);
      if (!msg) break;
      msg.deliveredTo = ev.deliveredTo;
      msg.readBy = ev.readBy;
      if (S.current === ev.chatId) {
        if (msg.from === S.me.pin) refreshMessage(msg);
        renderStatusLine();
      }
      renderSidebar();
      break;
    }
    case "expired": {
      const list = S.messages[ev.chatId] || [];
      S.messages[ev.chatId] = list.filter((m) => m.id !== ev.msgId);
      if (S.current === ev.chatId) $(`[data-id="${ev.msgId}"]`)?.remove();
      renderSidebar();
      break;
    }
    case "typing":
      onTyping(ev);
      break;
  }
}

function onMessage(msg) {
  const list = (S.messages[msg.chatId] ||= []);
  // our own optimistic copy gets swapped for the real one
  const local = msg.clientId ? list.findIndex((m) => m.clientId === msg.clientId && m.pending) : -1;
  const localId = local > -1 ? list[local].id : null;
  if (local > -1) list.splice(local, 1, msg);
  else list.push(msg);

  clearTyping(msg.chatId, msg.from);
  const isMine = msg.from === S.me.pin;
  const here = S.current === msg.chatId;

  if (here) {
    if (localId) {
      const el = $(`#messages [data-id="${localId}"]`);
      if (el) el.dataset.id = msg.id;
      refreshMessage(msg);
      renderStatusLine();
    } else {
      appendMessage(msg, { animate: !isMine });
    }
    if (!isMine && document.visibilityState === "visible") markRead();
  }

  if (!isMine && msg.kind === "ping") doPing();
  if (!isMine && msg.effect === "confetti" && here) confetti();
  if (!isMine && msg.from && !msg.silent && (!here || document.visibilityState !== "visible")) {
    notify(msg);
  }
  renderSidebar();
}

function onTyping({ chatId, pin, state }) {
  const map = (S.typing[chatId] ||= {});
  clearTimeout(map[pin]?.t);
  map[pin] = { state, t: setTimeout(() => clearTyping(chatId, pin), 4000) };
  renderSidebar();
  if (S.current === chatId) {
    renderHeader();
    renderTypingBubble();
  }
}

function clearTyping(chatId, pin) {
  const map = S.typing[chatId];
  if (!map || !map[pin]) return;
  clearTimeout(map[pin].t);
  delete map[pin];
  renderSidebar();
  if (S.current === chatId) {
    renderHeader();
    renderTypingBubble();
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// WhatsApp-style *bold* _italic_ ~strike~ `code`, plus links
function format(text) {
  let s = esc(text);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1<b>$2</b>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?]|$)/g, "$1<s>$2</s>");
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,!?)]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  return s;
}

function onlyEmoji(text) {
  const t = (text || "").trim();
  if (!t || t.length > 16) return false;
  return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && !/^[\d#*\s]+$/.test(t);
}

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899"];
function colorFor(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function initials(name) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase();
}

function avatarHTML({ name, key, img, online, size = "" }) {
  const style = img ? `background-image:url('${img}')` : `background:${colorFor(key)}`;
  return `<span class="avatar ${size}" style="${style}">${img ? "" : esc(initials(name))}${online ? '<span class="dot"></span>' : ""}</span>`;
}

function otherPin(chat) {
  return chat.members.find((m) => m !== S.me.pin) || S.me.pin;
}

function chatTitle(chat) {
  if (chat.type === "dm") return S.users[otherPin(chat)]?.name || "Unknown";
  return chat.name;
}

function chatAvatar(chat, size) {
  if (chat.type === "dm") {
    const u = S.users[otherPin(chat)] || {};
    return avatarHTML({ name: u.name, key: u.pin, img: u.avatar, online: u.online, size });
  }
  return avatarHTML({ name: chat.name, key: chat.id, size });
}

function findMsg(chatId, id) {
  return (S.messages[chatId] || []).find((m) => m.id === id);
}

function unreadCount(chatId) {
  return (S.messages[chatId] || []).filter((m) => m.from && m.from !== S.me.pin && !m.readBy.includes(S.me.pin)).length;
}

function lastMessage(chatId) {
  const list = S.messages[chatId] || [];
  return list[list.length - 1];
}

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function shortTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeOf(ts);
  const diff = (now - d) / 86400000;
  if (diff < 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function lastSeenText(u) {
  if (!u) return "";
  if (u.online) return "online";
  if (!u.lastSeen) return "";
  return `last seen ${shortTime(u.lastSeen).toLowerCase()}${new Date(u.lastSeen).toDateString() === new Date().toDateString() ? "" : " at " + timeOf(u.lastSeen)}`;
}

function previewText(msg) {
  if (!msg) return "";
  if (msg.deleted) return "🚫 Message deleted";
  const who = msg.from && msg.from !== S.me.pin && S.chats[msg.chatId]?.type !== "dm" ? `${S.users[msg.from]?.name?.split(" ")[0] || ""}: ` : "";
  const map = { image: "📷 Photo", voice: "🎤 Voice note", file: `📎 ${msg.fileName || "File"}`, ping: "PING!!!" };
  const body = map[msg.kind] ? `${map[msg.kind]}${msg.text ? " " + msg.text : ""}` : msg.text;
  return who + body;
}

function typingText(chatId) {
  const map = S.typing[chatId] || {};
  const pins = Object.keys(map);
  if (!pins.length) return "";
  const chat = S.chats[chatId];
  const recording = pins.some((p) => map[p].state === "recording");
  const verb = recording ? "recording audio" : "typing";
  if (chat?.type === "dm") return `${verb}…`;
  const names = pins.map((p) => S.users[p]?.name?.split(" ")[0] || "Someone");
  return `${names.slice(0, 2).join(", ")}${names.length > 2 ? " and others" : ""} ${names.length > 1 ? "are" : "is"} ${verb}…`;
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 2800);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Shrink photos before sending so they fit and load fast
async function compressImage(file, maxSide = 1600, quality = 0.82) {
  const url = await readFileAsDataURL(file);
  if (file.type === "image/gif") return url;
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

// ─────────────────────────────────────────────
// SCREENS
// ─────────────────────────────────────────────

function showAuth() {
  $("#app").classList.add("hidden");
  $("#auth").classList.remove("hidden");
}

function showApp() {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#authError").textContent = "";
}

function renderAll() {
  renderMe();
  renderSidebar();
  if (S.current) openChat(S.current, { keepScroll: true });
}

function renderMe() {
  $("#meAvatar").outerHTML = avatarHTML({ name: S.me.name, key: S.me.pin, img: S.me.avatar }).replace('class="avatar', 'id="meAvatar" class="avatar sm');
  $("#meName").textContent = S.me.name;
  $("#mePin").textContent = `PIN ${S.me.pin}`;
}

// ─────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────

function renderSidebar() {
  if (!S.me) return;
  renderMe();
  const q = S.query.toLowerCase();
  let chats = Object.values(S.chats);

  if (S.filter === "starred") return renderStarred();
  if (S.filter === "unread") chats = chats.filter((c) => unreadCount(c.id));
  else if (S.filter !== "all") chats = chats.filter((c) => c.type === S.filter);

  let hits = [];
  if (q) {
    chats = chats.filter((c) => chatTitle(c).toLowerCase().includes(q));
    for (const [chatId, list] of Object.entries(S.messages)) {
      if (!S.chats[chatId]) continue;
      for (const m of list) if (!m.deleted && m.text && m.text.toLowerCase().includes(q)) hits.push(m);
    }
    hits = hits.sort((a, b) => b.ts - a.ts).slice(0, 30);
  }

  chats.sort((a, b) => (lastMessage(b.id)?.ts || b.createdAt) - (lastMessage(a.id)?.ts || a.createdAt));

  const rows = chats.map((c) => {
    const last = lastMessage(c.id);
    const unread = unreadCount(c.id);
    const typing = typingText(c.id);
    const draft = S.drafts[c.id];
    let preview = typing
      ? `<span class="preview typing">${esc(typing)}</span>`
      : draft && S.current !== c.id
        ? `<span class="preview"><b style="color:var(--danger)">Draft:</b> ${esc(draft)}</span>`
        : `<span class="preview">${last?.from === S.me.pin ? tickHTML(last) + " " : ""}${esc(previewText(last))}</span>`;
    const tag = c.type === "channel" ? '<span class="kind-tag">channel</span>' : c.type === "group" ? '<span class="kind-tag">group</span>' : "";
    return `<li class="chat-item ${S.current === c.id ? "active" : ""}" data-chat="${c.id}">
      ${chatAvatar(c)}
      <div class="meta">
        <div class="row"><span class="name">${esc(chatTitle(c))}${tag}</span><span class="time">${last ? shortTime(last.ts) : ""}</span></div>
        <div class="row">${preview}${unread ? `<span class="badge">${unread}</span>` : ""}</div>
      </div></li>`;
  });

  if (hits.length) {
    rows.push(`<li class="list-empty" style="padding:12px 8px 4px;text-align:left">Messages</li>`);
    for (const m of hits) {
      const c = S.chats[m.chatId];
      rows.push(`<li class="chat-item" data-chat="${c.id}" data-jump="${m.id}">
        ${chatAvatar(c, "sm")}
        <div class="meta"><div class="row"><span class="name">${esc(chatTitle(c))}</span><span class="time">${shortTime(m.ts)}</span></div>
        <div class="row"><span class="preview">${esc(previewText(m))}</span></div></div></li>`);
    }
  }

  $("#chatList").innerHTML = rows.join("") || `<li class="list-empty">${q ? "Nothing matches." : S.filter === "all" ? "No chats yet. Tap + to add someone by PIN." : "Nothing here."}</li>`;
}

function renderStarred() {
  const items = [];
  for (const [chatId, list] of Object.entries(S.messages)) {
    for (const m of list) if (S.starred.has(m.id) && !m.deleted) items.push(m);
  }
  items.sort((a, b) => b.ts - a.ts);
  $("#chatList").innerHTML =
    items
      .map((m) => {
        const c = S.chats[m.chatId];
        if (!c) return "";
        return `<li class="chat-item" data-chat="${c.id}" data-jump="${m.id}">
        ${chatAvatar(c, "sm")}
        <div class="meta"><div class="row"><span class="name">★ ${esc(chatTitle(c))}</span><span class="time">${shortTime(m.ts)}</span></div>
        <div class="row"><span class="preview">${esc(previewText(m))}</span></div></div></li>`;
      })
      .join("") || `<li class="list-empty">Star a message to keep it here.</li>`;
}

// ─────────────────────────────────────────────
// CHAT VIEW
// ─────────────────────────────────────────────

function openChat(chatId, { keepScroll = false, jump = null } = {}) {
  const chat = S.chats[chatId];
  if (!chat) return;
  if (S.current && S.current !== chatId) saveDraft();
  S.current = chatId;
  S.context = null;
  $("#app").classList.add("in-chat");
  $("#emptyState").classList.add("hidden");
  $("#chatHead").classList.remove("hidden");
  $("#composer").classList.remove("hidden");
  $("#chatSearchBar").classList.add("hidden");
  $("#chatSearch").value = "";
  renderHeader();
  renderPinned();
  renderComposer();
  renderMessages({ keepScroll });
  if (S.panelOpen) renderPanel();
  $("#input").value = S.drafts[chatId] || "";
  autosize();
  updateSendIcon();
  markRead();
  renderSidebar();
  if (jump) jumpTo(jump);
  else if (matchMedia("(min-width: 761px)").matches) $("#input").focus();
}

function closeChat() {
  saveDraft();
  S.current = null;
  S.panelOpen = false;
  $("#app").classList.remove("in-chat", "with-panel");
  $("#panel").classList.add("hidden");
  $("#emptyState").classList.remove("hidden");
  ["#chatHead", "#composer", "#pinnedBar", "#chatSearchBar"].forEach((s) => $(s).classList.add("hidden"));
  $("#messages").innerHTML = "";
  renderSidebar();
}

function renderHeader() {
  const chat = S.chats[S.current];
  if (!chat) return;
  $("#chatAvatar").outerHTML = chatAvatar(chat).replace('class="avatar', 'id="chatAvatar" class="avatar sm');
  $("#chatName").textContent = chatTitle(chat);
  const typing = typingText(chat.id);
  const sub = $("#chatSub");
  sub.classList.toggle("typing", !!typing);
  if (typing) sub.textContent = typing;
  else if (chat.type === "dm") {
    const u = S.users[otherPin(chat)];
    sub.textContent = [lastSeenText(u), u?.status].filter(Boolean).join(" · ");
  } else {
    const n = chat.members.length;
    const on = chat.members.filter((m) => S.users[m]?.online && m !== S.me.pin).length;
    sub.textContent = `${n} ${chat.type === "channel" ? "subscriber" : "member"}${n === 1 ? "" : "s"}${on ? `, ${on} online` : ""}${chat.disappear ? " · ⏱" : ""}`;
  }
  $("#pingBtn").classList.toggle("hidden", chat.type !== "dm");
}

function renderPinned() {
  const chat = S.chats[S.current];
  const bar = $("#pinnedBar");
  const msg = chat?.pinned && findMsg(chat.id, chat.pinned);
  if (!msg) return bar.classList.add("hidden");
  bar.classList.remove("hidden");
  bar.innerHTML = `<b>📌 Pinned</b><span>${esc(previewText(msg))}</span>`;
  bar.onclick = () => jumpTo(msg.id);
}

function canPost(chat) {
  return chat.type !== "channel" || chat.admins.includes(S.me.pin);
}

function renderComposer() {
  const chat = S.chats[S.current];
  if (!chat) return;
  const ok = canPost(chat);
  $("#composeRow").classList.toggle("hidden", !ok);
  $("#readonlyNote").classList.toggle("hidden", ok);
  const ctx = S.context;
  $("#contextBar").classList.toggle("hidden", !ctx);
  if (ctx) {
    $("#contextTitle").textContent = ctx.mode === "edit" ? "Edit message" : `Reply to ${ctx.msg.from === S.me.pin ? "yourself" : S.users[ctx.msg.from]?.name || ""}`;
    $("#contextText").textContent = previewText(ctx.msg);
  }
  $("#effectBtn").classList.toggle("effect-on", !!(S.effect || S.silent));
  $("#input").placeholder = S.silent ? "Silent message" : S.effect ? `Send with ${S.effect}` : chat.type === "channel" ? "Broadcast" : "Message";
}

function renderMessages({ keepScroll = false } = {}) {
  const box = $("#messages");
  const prevBottom = box.scrollHeight - box.scrollTop;
  box.innerHTML = "";
  const list = S.messages[S.current] || [];
  let prev = null;
  const frag = document.createDocumentFragment();
  for (const m of list) {
    frag.append(...buildRow(m, prev));
    prev = m;
  }
  box.append(frag);
  renderTypingBubble();
  renderStatusLine();
  box.scrollTop = keepScroll ? box.scrollHeight - prevBottom : box.scrollHeight;
}

function buildRow(m, prev) {
  const out = [];
  if (!prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString()) {
    const d = document.createElement("div");
    d.className = "day";
    d.textContent = dayLabel(m.ts);
    out.push(d);
  }
  out.push(messageEl(m, prev));
  return out;
}

function tickHTML(m) {
  if (!m || m.from !== S.me.pin || m.kind === "system") return "";
  const chat = S.chats[m.chatId];
  const others = chat ? chat.members.filter((p) => p !== S.me.pin) : [];
  const delivered = others.length && others.every((p) => m.deliveredTo.includes(p));
  const read = others.length && others.every((p) => m.readBy.includes(p));
  if (m.pending) return `<span class="ticks">🕓</span>`;
  if (S.receiptStyle === "bbm") {
    if (read) return `<span class="bbm r">R</span>`;
    if (delivered) return `<span class="bbm">D</span>`;
    return `<span class="ticks">✓</span>`;
  }
  if (read) return `<span class="ticks read">✓✓</span>`;
  if (delivered) return `<span class="ticks">✓✓</span>`;
  return `<span class="ticks">✓</span>`;
}

function messageEl(m, prev) {
  const el = document.createElement("div");
  el.dataset.id = m.id;
  if (m.kind === "system") {
    el.className = "system";
    el.textContent = m.text;
    return el;
  }
  const chat = S.chats[m.chatId];
  const mine = m.from === S.me.pin;
  const sameRun = prev && prev.from === m.from && prev.kind !== "system" && m.ts - prev.ts < 5 * 60000;
  el.className = `msg ${mine ? "mine" : ""} ${sameRun ? "" : "gap"}`;

  let html = "";
  if (!mine && chat.type === "group" && !sameRun) {
    const u = S.users[m.from];
    html += `<span class="author" style="color:${colorFor(m.from)}">${esc(u?.name || "Unknown")}</span>`;
  }

  let body = "";
  let cls = "bubble";
  if (m.deleted) {
    cls += " deleted";
    body = mine ? "🚫 You deleted this message" : "🚫 This message was deleted";
  } else {
    if (m.replyTo) {
      const r = findMsg(m.chatId, m.replyTo);
      if (r) body += `<div class="reply-quote" data-jump="${r.id}"><b>${esc(r.from === S.me.pin ? "You" : S.users[r.from]?.name || "")}</b>${esc(previewText(r))}</div>`;
    }
    if (m.kind === "image") {
      cls += " media";
      body += `<img src="${m.media}" alt="Photo" loading="lazy" data-zoom>`;
      if (m.text) body += `<div class="caption">${format(m.text)}</div>`;
    } else if (m.kind === "voice") {
      body += `<div class="voice">🎤<audio controls preload="metadata" src="${m.media}"></audio></div>`;
    } else if (m.kind === "file") {
      body += `<a class="file-link" href="${m.media}" download="${esc(m.fileName)}">📎 ${esc(m.fileName)}</a>`;
      if (m.text) body += format(m.text);
    } else if (m.kind === "ping") {
      cls += " ping-b";
      body += `<div class="ping-msg">PING!!!</div>`;
    } else {
      if (onlyEmoji(m.text) && !m.replyTo) cls += " only-emoji";
      body += format(m.text);
    }
  }

  const star = S.starred.has(m.id) ? "★ " : "";
  const edited = m.editedAt && !m.deleted ? "edited " : "";
  const silent = m.silent ? "🔕 " : "";
  const timer = m.expiresAt ? `<span class="expiry">⏱</span>` : "";
  const foot = `<span class="foot">${timer}${silent}${star}${edited}${timeOf(m.ts)} ${tickHTML(m)}</span>`;
  html += `<div class="${cls}">${body}${foot}</div>`;

  const reacts = Object.entries(m.reactions || {});
  if (reacts.length) {
    const counts = {};
    for (const [, e] of reacts) counts[e] = (counts[e] || 0) + 1;
    const myR = m.reactions[S.me.pin];
    html += `<div class="reactions">${Object.entries(counts)
      .map(([e, n]) => `<span class="${e === myR ? "mine-r" : ""}" title="${esc(reacts.filter(([, x]) => x === e).map(([p]) => S.users[p]?.name).join(", "))}">${e}${n > 1 ? " " + n : ""}</span>`)
      .join("")}</div>`;
  }
  el.innerHTML = html;
  return el;
}

function appendMessage(m, { animate }) {
  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  const list = S.messages[S.current];
  const prev = list[list.indexOf(m) - 1];
  $(".typing-bubble", box)?.remove();
  const rows = buildRow(m, prev);
  box.append(...rows);
  if (animate || m.from === S.me.pin) {
    const el = rows[rows.length - 1];
    if (m.effect && m.effect !== "confetti") el.classList.add(`fx-${m.effect}`);
  }
  if (m.from === S.me.pin && m.effect === "confetti") confetti();
  renderTypingBubble();
  renderStatusLine();
  if (nearBottom || m.from === S.me.pin) box.scrollTop = box.scrollHeight;
}

function replaceMessage(m) {
  const list = S.messages[m.chatId] || [];
  const i = list.findIndex((x) => x.id === m.id);
  if (i > -1) list[i] = m;
  if (S.current === m.chatId) {
    refreshMessage(m);
    renderPinned();
  }
  renderSidebar();
}

function refreshMessage(m) {
  const old = $(`#messages [data-id="${m.id}"]`);
  if (!old) return;
  const list = S.messages[m.chatId];
  const prev = list[list.indexOf(m) - 1];
  old.replaceWith(messageEl(m, prev));
}

function renderTypingBubble() {
  const box = $("#messages");
  $(".typing-bubble", box)?.remove();
  if (!S.current || !Object.keys(S.typing[S.current] || {}).length) return;
  const el = document.createElement("div");
  el.className = "typing-bubble";
  el.innerHTML = "<i></i><i></i><i></i>";
  box.append(el);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// iMessage-style "Read 10:42" under your last message in a DM
function renderStatusLine() {
  $("#messages .status-line")?.remove();
  const chat = S.chats[S.current];
  if (!chat || chat.type !== "dm") return;
  const list = S.messages[chat.id] || [];
  const last = [...list].reverse().find((m) => m.from && m.kind !== "system");
  if (!last || last.from !== S.me.pin || last.pending) return;
  const other = otherPin(chat);
  let text = "";
  if (last.readBy.includes(other)) text = "Read";
  else if (last.deliveredTo.includes(other)) text = "Delivered";
  if (!text) return;
  const el = $(`#messages [data-id="${last.id}"]`);
  if (!el) return;
  const s = document.createElement("div");
  s.className = "status-line";
  s.textContent = text;
  el.append(s);
}

function jumpTo(msgId) {
  const el = $(`#messages [data-id="${msgId}"]`);
  if (!el) return toast("That message isn't loaded.");
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

function markRead() {
  if (!S.current || document.visibilityState !== "visible") return;
  if (unreadCount(S.current)) {
    wsSend({ type: "read", chatId: S.current });
    // update locally right away so badges clear
    for (const m of S.messages[S.current]) {
      if (m.from && m.from !== S.me.pin && !m.readBy.includes(S.me.pin)) m.readBy.push(S.me.pin);
    }
    renderSidebar();
  }
}

function saveDraft() {
  if (!S.current) return;
  const v = $("#input").value;
  if (v.trim() && S.context?.mode !== "edit") S.drafts[S.current] = v;
  else delete S.drafts[S.current];
  store.set("oc.drafts", S.drafts);
}

// ─────────────────────────────────────────────
// SENDING
// ─────────────────────────────────────────────

function sendMessage(extra = {}) {
  const chat = S.chats[S.current];
  if (!chat) return;
  const input = $("#input");
  const text = extra.text ?? input.value;

  if (S.context?.mode === "edit" && !extra.kind) {
    if (text.trim()) sendOrQueue({ type: "edit", chatId: chat.id, msgId: S.context.msg.id, text });
    resetComposer();
    return;
  }

  const kind = extra.kind || "text";
  if (kind === "text" && !text.trim()) return;

  const clientId = Math.random().toString(36).slice(2);
  const payload = {
    type: "send",
    chatId: chat.id,
    clientId,
    kind,
    text: kind === "ping" ? "" : text,
    media: extra.media,
    fileName: extra.fileName,
    duration: extra.duration,
    replyTo: S.context?.mode === "reply" ? S.context.msg.id : null,
    effect: S.effect,
    silent: S.silent,
  };

  // optimistic bubble with a clock until the server confirms
  const optimistic = {
    ...payload,
    id: "local-" + clientId,
    from: S.me.pin,
    ts: Date.now(),
    reactions: {},
    deliveredTo: [],
    readBy: [],
    pending: true,
    expiresAt: chat.disappear ? Date.now() + chat.disappear * 1000 : null,
  };
  delete optimistic.type;
  S.messages[chat.id].push(optimistic);
  appendMessage(optimistic, { animate: true });

  sendOrQueue(payload);
  wsSend({ type: "typing", chatId: chat.id, state: "stopped" });
  if (kind === "text" || kind === "ping") {
    input.value = "";
  }
  resetComposer();
  renderSidebar();
}

function resetComposer() {
  S.context = null;
  S.effect = null;
  S.silent = false;
  if (S.current) {
    delete S.drafts[S.current];
    store.set("oc.drafts", S.drafts);
  }
  const input = $("#input");
  if (input.dataset.editing) {
    input.value = "";
    delete input.dataset.editing;
  }
  autosize();
  updateSendIcon();
  renderComposer();
}

function autosize() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}

function updateSendIcon() {
  const empty = !$("#input").value.trim() && S.context?.mode !== "edit";
  const canRecord = !!(navigator.mediaDevices && window.MediaRecorder);
  $("#sendIcon").classList.toggle("hidden", empty && canRecord && !recorder);
  $("#micIcon").classList.toggle("hidden", !(empty && canRecord && !recorder));
}

let typingSentAt = 0;
function notifyTyping() {
  if (!S.current) return;
  const now = Date.now();
  if (now - typingSentAt > 2500) {
    typingSentAt = now;
    wsSend({ type: "typing", chatId: S.current, state: "typing" });
  }
}

// ─────────────────────────────────────────────
// VOICE NOTES
// ─────────────────────────────────────────────

let recorder = null;
let recChunks = [];
let recStart = 0;
let recTimer = null;
let recCancelled = false;
let recTypingTimer = null;

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    recChunks = [];
    recCancelled = false;
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      clearInterval(recTypingTimer);
      $("#recordingBar").classList.add("hidden");
      $("#sendBtn").classList.remove("recording");
      const duration = Math.round((Date.now() - recStart) / 1000);
      recorder = null;
      updateSendIcon();
      if (recCancelled || duration < 1) return;
      const blob = new Blob(recChunks, { type: recChunks[0]?.type || "audio/webm" });
      if (blob.size > MAX_MEDIA) return toast("That voice note is too long.");
      const media = await readFileAsDataURL(blob);
      sendMessage({ kind: "voice", media, duration, text: "" });
    };
    recorder.start();
    recStart = Date.now();
    $("#recordingBar").classList.remove("hidden");
    $("#sendBtn").classList.add("recording");
    $("#sendIcon").classList.remove("hidden");
    $("#micIcon").classList.add("hidden");
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $("#recTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if (s >= 180) recorder?.stop();
    }, 250);
    wsSend({ type: "typing", chatId: S.current, state: "recording" });
    recTypingTimer = setInterval(() => wsSend({ type: "typing", chatId: S.current, state: "recording" }), 2500);
  } catch {
    toast("Microphone access was blocked.");
  }
}

// ─────────────────────────────────────────────
// PING + EFFECTS
// ─────────────────────────────────────────────

function doPing() {
  const app = $("#app");
  app.classList.remove("shake");
  void app.offsetWidth;
  app.classList.add("shake");
  navigator.vibrate?.([120, 60, 120, 60, 240]);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.08, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.15);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.16);
    });
  } catch {}
}

function confetti() {
  const canvas = $("#fx");
  const ctx = canvas.getContext("2d");
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const bits = Array.from({ length: 160 }, () => ({
    x: Math.random() * innerWidth,
    y: -20 - Math.random() * innerHeight * 0.5,
    vx: (Math.random() - 0.5) * 3,
    vy: 2 + Math.random() * 4,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: COLORS[Math.floor(Math.random() * COLORS.length)],
    w: 6 + Math.random() * 6,
  }));
  const end = Date.now() + 3000;
  (function frame() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.x += b.vx;
      b.y += b.vy;
      b.r += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.r);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.w / 4, b.w, b.w / 2);
      ctx.restore();
    }
    if (Date.now() < end) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })();
}

// ─────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────

function notify(msg) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const chat = S.chats[msg.chatId];
  if (!chat) return;
  const n = new Notification(chatTitle(chat), { body: previewText(msg), tag: chat.id, icon: "icon.svg" });
  n.onclick = () => {
    window.focus();
    openChat(chat.id);
    n.close();
  };
}

// ─────────────────────────────────────────────
// MENUS AND SHEETS
// ─────────────────────────────────────────────

function openMenu(x, y, html, onClick) {
  const menu = $("#menu");
  menu.innerHTML = html;
  menu.classList.remove("hidden");
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
  menu.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    closeMenu();
    onClick(b.dataset);
  };
}

function closeMenu() {
  $("#menu").classList.add("hidden");
}

function messageMenu(msgId, x, y) {
  const m = findMsg(S.current, msgId);
  if (!m || m.pending || m.kind === "system") return;
  const chat = S.chats[S.current];
  const mine = m.from === S.me.pin;
  const admin = chat.admins.includes(S.me.pin);
  const items = [];
  if (!m.deleted) {
    if (canPost(chat)) items.push(["reply", "↩︎ Reply"]);
    if (m.text) items.push(["copy", "⧉ Copy"]);
    if (mine && m.kind === "text") items.push(["edit", "✎ Edit"]);
    if (chat.type === "dm" || admin) items.push(["pin", chat.pinned === m.id ? "📌 Unpin" : "📌 Pin"]);
    items.push(["star", S.starred.has(m.id) ? "☆ Unstar" : "★ Star"]);
    if (m.kind !== "text" && m.media) items.push(["save", "⤓ Save"]);
    if (mine || chat.type !== "dm") items.push(["info", "ⓘ Info"]);
    if (mine || (chat.type !== "dm" && admin)) items.push(["delete", "🗑 Delete for everyone", "danger"]);
  }
  const myR = m.reactions[S.me.pin];
  const taps = m.deleted ? "" : `<div class="tapbacks">${TAPBACKS.map((e) => `<button data-act="react" data-emoji="${e}" class="${myR === e ? "on" : ""}">${e}</button>`).join("")}</div>`;
  if (!items.length && !taps) return;
  openMenu(x, y, taps + items.map(([a, l, c]) => `<button class="item ${c || ""}" data-act="${a}">${l}</button>`).join(""), ({ act, emoji }) => {
    if (act === "react") return wsSend({ type: "react", chatId: chat.id, msgId: m.id, emoji });
    if (act === "reply") {
      S.context = { mode: "reply", msg: m };
      renderComposer();
      $("#input").focus();
    }
    if (act === "edit") {
      S.context = { mode: "edit", msg: m };
      const input = $("#input");
      input.value = m.text;
      input.dataset.editing = "1";
      autosize();
      updateSendIcon();
      renderComposer();
      input.focus();
    }
    if (act === "copy") navigator.clipboard?.writeText(m.text).then(() => toast("Copied"));
    if (act === "pin") wsSend({ type: "pin", chatId: chat.id, msgId: m.id });
    if (act === "star") {
      S.starred.has(m.id) ? S.starred.delete(m.id) : S.starred.add(m.id);
      store.set("oc.starred", [...S.starred]);
      refreshMessage(m);
      toast(S.starred.has(m.id) ? "Starred" : "Unstarred");
    }
    if (act === "save") {
      const a = document.createElement("a");
      a.href = m.media;
      a.download = m.fileName || (m.kind === "image" ? "photo.jpg" : "voice-note.webm");
      a.click();
    }
    if (act === "info") showInfoSheet(m);
    if (act === "delete") {
      if (confirm("Delete this message for everyone?")) wsSend({ type: "delete", chatId: chat.id, msgId: m.id });
    }
  });
}

function openSheet(html) {
  $("#sheet").innerHTML = html;
  $("#sheetBackdrop").classList.remove("hidden");
  setTimeout(() => $("#sheet input, #sheet textarea")?.focus(), 50);
}

function closeSheet() {
  $("#sheetBackdrop").classList.add("hidden");
}

function showInfoSheet(m) {
  const chat = S.chats[m.chatId];
  const others = chat.members.filter((p) => p !== S.me.pin && p !== m.from);
  const row = (p) => `<div class="member">${avatarHTML({ name: S.users[p]?.name, key: p, img: S.users[p]?.avatar, size: "sm" })}<span>${esc(S.users[p]?.name || p)}</span></div>`;
  const read = others.filter((p) => m.readBy.includes(p));
  const delivered = others.filter((p) => m.deliveredTo.includes(p) && !m.readBy.includes(p));
  const waiting = others.filter((p) => !m.deliveredTo.includes(p));
  openSheet(`<h3>Message info</h3><div class="stack">
    <p class="hint">Sent ${new Date(m.ts).toLocaleString()}${m.editedAt ? `<br>Edited ${new Date(m.editedAt).toLocaleString()}` : ""}</p>
    ${m.from === S.me.pin ? `
    <h4 class="hint"><b>Read by</b></h4>${read.map(row).join("") || '<p class="hint">No one yet</p>'}
    <h4 class="hint"><b>Delivered to</b></h4>${delivered.map(row).join("") || '<p class="hint">—</p>'}
    ${waiting.length ? `<h4 class="hint"><b>Waiting</b></h4>${waiting.map(row).join("")}` : ""}` : `<p class="hint">From ${esc(S.users[m.from]?.name || "")}</p>`}
  </div><div class="actions"><button class="secondary" data-close>Close</button></div>`);
}

function showNewSheet() {
  openSheet(`<h3>Start something</h3><div class="stack">
    <button class="choice" data-new="contact"><span class="ico">👤</span><span><b>Add by PIN</b><small>Chat one-to-one</small></span></button>
    <button class="choice" data-new="group"><span class="ico">👥</span><span><b>New group</b><small>Everyone can talk</small></span></button>
    <button class="choice" data-new="channel"><span class="ico">📣</span><span><b>New channel</b><small>You broadcast, they follow</small></span></button>
    <button class="choice" data-new="join"><span class="ico">🔗</span><span><b>Join with invite code</b><small>For groups and channels</small></span></button>
    <button class="choice" data-new="mypin"><span class="ico">🪪</span><span><b>Show my PIN</b><small>${esc(S.me.pin)}</small></span></button>
  </div>`);
}

function showContactSheet() {
  openSheet(`<h3>Add by PIN</h3><form class="stack" data-form="contact">
    <label>Their PIN<input name="pin" maxlength="8" required placeholder="e.g. 2A4F9C1B" style="text-transform:uppercase;font-family:ui-monospace,monospace;letter-spacing:.1em"></label>
    <div class="actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Add and chat</button></div>
  </form>`);
}

// Contacts from the server list plus anyone you have a DM with
function contactPins() {
  const pins = new Set(S.me.contacts || []);
  for (const c of Object.values(S.chats)) if (c.type === "dm") pins.add(otherPin(c));
  pins.delete(S.me.pin);
  return [...pins];
}

function memberPicker(exclude = []) {
  const contacts = contactPins().filter((p) => !exclude.includes(p) && S.users[p]);
  if (!contacts.length) return `<p class="hint">Add people by PIN first. You can also share the invite code once it's created.</p>`;
  return `<div class="pick-list">${contacts
    .map((p) => `<label class="pick"><input type="checkbox" name="m" value="${p}">${avatarHTML({ name: S.users[p].name, key: p, img: S.users[p].avatar, size: "sm" })}${esc(S.users[p].name)}</label>`)
    .join("")}</div>`;
}

function showCreateSheet(type) {
  openSheet(`<h3>${type === "channel" ? "New channel" : "New group"}</h3><form class="stack" data-form="create" data-type="${type}">
    <label>Name<input name="name" maxlength="60" required></label>
    <label>${type === "channel" ? "Subscribers" : "Members"}</label>${memberPicker()}
    <div class="actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Create</button></div>
  </form>`);
}

function showJoinSheet() {
  openSheet(`<h3>Join with invite code</h3><form class="stack" data-form="join">
    <label>Invite code<input name="code" required></label>
    <div class="actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Join</button></div>
  </form>`);
}

function showPinSheet(welcome = false) {
  openSheet(`<h3>${welcome ? `Welcome, ${esc(S.me.name)}` : "Your PIN"}</h3><div class="stack">
    ${welcome ? '<p class="hint">This is your PIN. It\'s how you sign in and how people add you. Write it down.</p>' : '<p class="hint">Share this so people can add you.</p>'}
    <div class="pin-big">${esc(S.me.pin)}</div>
  </div><div class="actions">
    <button class="secondary" data-copy="${esc(S.me.pin)}">Copy</button>
    <button class="primary" data-close>${welcome ? "Got it" : "Done"}</button></div>`);
}

function showProfileSheet() {
  const notif = "Notification" in window ? Notification.permission : "unsupported";
  const theme = document.documentElement.dataset.theme || "auto";
  openSheet(`<h3>Profile and settings</h3><form class="stack" data-form="profile">
    <div style="text-align:center">${avatarHTML({ name: S.me.name, key: S.me.pin, img: S.me.avatar, size: "lg" })}<br>
      <label class="link-btn" style="display:inline-block;margin-top:8px;cursor:pointer">Change photo<input type="file" accept="image/*" name="avatar" hidden></label>
      ${S.me.avatar ? '<button type="button" class="link-btn" data-remove-avatar style="margin-left:12px">Remove</button>' : ""}
    </div>
    <label>Name<input name="name" value="${esc(S.me.name)}" maxlength="40" required></label>
    <label>Status<input name="status" value="${esc(S.me.status || "")}" maxlength="140" placeholder="Available, At the gym, …"></label>
    <div class="toggle-row">PIN <code style="font-weight:700;letter-spacing:.08em">${esc(S.me.pin)}</code></div>
    <div class="toggle-row">Read receipts style
      <select name="receipts"><option value="ticks"${S.receiptStyle === "ticks" ? " selected" : ""}>✓✓ ticks</option><option value="bbm"${S.receiptStyle === "bbm" ? " selected" : ""}>D / R (BBM)</option></select></div>
    <div class="toggle-row">Theme
      <select name="theme"><option value="auto"${theme === "auto" ? " selected" : ""}>Match device</option><option value="light"${theme === "light" ? " selected" : ""}>Light</option><option value="dark"${theme === "dark" ? " selected" : ""}>Dark</option></select></div>
    <div class="toggle-row">Notifications ${notif === "granted" ? "<span class='hint'>On</span>" : notif === "unsupported" ? "<span class='hint'>Not supported</span>" : '<button type="button" class="secondary" data-notif>Turn on</button>'}</div>
    <button type="button" class="danger-btn" data-logout>Sign out of this device</button>
    <div class="actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Save</button></div>
  </form>`);
}

function effectMenu() {
  const r = $("#effectBtn").getBoundingClientRect();
  const html =
    EFFECTS.map((e) => `<button class="item" data-effect="${e.id}">${e.icon} ${e.label}${S.effect === e.id ? "<small>on</small>" : ""}</button>`).join("") +
    `<button class="item" data-effect="silent">🔕 Send silently${S.silent ? "<small>on</small>" : ""}</button>` +
    (S.effect || S.silent ? `<button class="item" data-effect="none">✕ Clear</button>` : "");
  openMenu(r.left - 150, r.top - 290, html, ({ effect }) => {
    if (effect === "silent") S.silent = !S.silent;
    else if (effect === "none") {
      S.effect = null;
      S.silent = false;
    } else S.effect = S.effect === effect ? null : effect;
    renderComposer();
    $("#input").focus();
  });
}

// ─────────────────────────────────────────────
// CHAT INFO PANEL
// ─────────────────────────────────────────────

function renderPanel() {
  const chat = S.chats[S.current];
  const panel = $("#panel");
  if (!chat) return;
  const admin = chat.admins.includes(S.me.pin);
  const isDm = chat.type === "dm";
  const other = isDm ? S.users[otherPin(chat)] : null;
  const media = (S.messages[chat.id] || []).filter((m) => m.kind === "image" && !m.deleted).slice(-9).reverse();

  const timers = [
    [0, "Off"],
    [30, "30 seconds"],
    [3600, "1 hour"],
    [86400, "24 hours"],
    [604800, "7 days"],
    [7776000, "90 days"],
  ];
  const canTimer = isDm || admin;

  panel.innerHTML = `
    <button class="icon-btn" data-panel-close aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <div class="panel-head">${chatAvatar(chat, "lg")}
      <h3>${esc(chatTitle(chat))}</h3>
      <p>${isDm ? `PIN ${esc(other?.pin)}<br>${esc(other?.status || "")}` : `${chat.type === "channel" ? "Channel" : "Group"} · ${chat.members.length} ${chat.type === "channel" ? "subscribers" : "members"}`}</p>
    </div>
    ${!isDm && (chat.description || admin) ? `<section><h4>About</h4>${admin ? `<textarea rows="2" data-desc placeholder="Add a description">${esc(chat.description)}</textarea>` : `<p style="margin:0">${esc(chat.description)}</p>`}</section>` : ""}
    ${!isDm && admin && chat.invite ? `<section><h4>Invite code</h4><div class="code-box"><code>${esc(chat.invite)}</code><button class="secondary" data-copy="${esc(chat.invite)}">Copy</button></div><p class="hint">Anyone with this code can join.</p></section>` : ""}
    <section><h4>Disappearing messages</h4>
      ${canTimer ? `<select data-timer>${timers.map(([v, l]) => `<option value="${v}"${chat.disappear === v ? " selected" : ""}>${l}</option>`).join("")}</select>` : `<p class="hint">${timers.find(([v]) => v === chat.disappear)?.[1] || "Custom"}</p>`}
      <p class="hint">New messages vanish for everyone after this time.</p>
    </section>
    ${media.length ? `<section><h4>Photos</h4><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px">${media.map((m) => `<img src="${m.media}" data-zoom style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;cursor:zoom-in">`).join("")}</div></section>` : ""}
    ${!isDm ? `<section><h4>${chat.type === "channel" ? "Subscribers" : "Members"}</h4>
      ${admin ? `<button class="secondary" data-add-members>+ Add people</button>` : ""}
      ${chat.members.map((p) => {
        const u = S.users[p] || { name: p };
        return `<div class="member">${avatarHTML({ name: u.name, key: p, img: u.avatar, online: u.online, size: "sm" })}<span>${esc(u.name)}${p === S.me.pin ? " (you)" : ""}<small>${esc(u.online ? "online" : lastSeenText(u))}</small></span>${chat.admins.includes(p) ? '<span class="role">admin</span>' : ""}</div>`;
      }).join("")}
    </section>
    <section><button class="danger-btn" data-leave>Leave ${chat.type}</button></section>` : ""}
  `;
}

function togglePanel(open = !S.panelOpen) {
  S.panelOpen = open;
  $("#panel").classList.toggle("hidden", !open);
  $("#app").classList.toggle("with-panel", open);
  if (open) renderPanel();
}

// ─────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────

function bind() {
  // auth
  $$(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
      $("#registerForm").classList.toggle("hidden", t.dataset.auth !== "register");
      $("#loginForm").classList.toggle("hidden", t.dataset.auth !== "login");
      $("#authError").textContent = "";
    })
  );
  $("#registerForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    sessionStorage.setItem("oc.justRegistered", "1");
    if (!wsSend({ type: "register", name: f.get("name"), password: f.get("password") })) $("#authError").textContent = "Not connected yet. Try again in a second.";
  });
  $("#loginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (!wsSend({ type: "login", pin: f.get("pin"), password: f.get("password") })) $("#authError").textContent = "Not connected yet. Try again in a second.";
  });

  // sidebar
  $("#chatList").addEventListener("click", (e) => {
    const li = e.target.closest("[data-chat]");
    if (li) openChat(li.dataset.chat, { jump: li.dataset.jump || null });
  });
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.filter = b.dataset.filter;
    $$("#filters button").forEach((x) => x.classList.toggle("active", x === b));
    renderSidebar();
  });
  $("#globalSearch").addEventListener("input", (e) => {
    S.query = e.target.value.trim();
    renderSidebar();
  });
  $("#newBtn").addEventListener("click", showNewSheet);
  $("#meBtn").addEventListener("click", showProfileSheet);

  // header
  $("#backBtn").addEventListener("click", closeChat);
  $("#chatTitleBtn").addEventListener("click", () => togglePanel());
  $("#pingBtn").addEventListener("click", () => {
    const now = Date.now();
    if (now - (S.lastPing || 0) < 5000) return toast("Easy. One PING at a time.");
    S.lastPing = now;
    sendMessage({ kind: "ping", text: "" });
    doPing();
  });
  $("#chatSearchBtn").addEventListener("click", () => {
    const bar = $("#chatSearchBar");
    bar.classList.toggle("hidden");
    if (!bar.classList.contains("hidden")) $("#chatSearch").focus();
    else {
      $("#chatSearch").value = "";
      $$("#messages .hit").forEach((b) => b.classList.remove("hit"));
      $("#chatSearchCount").textContent = "";
    }
  });
  $("#chatSearch").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$("#messages .hit").forEach((b) => b.classList.remove("hit"));
    if (!q) return ($("#chatSearchCount").textContent = "");
    const hits = (S.messages[S.current] || []).filter((m) => !m.deleted && m.text?.toLowerCase().includes(q));
    hits.forEach((m) => $(`#messages [data-id="${m.id}"] .bubble`)?.classList.add("hit"));
    $("#chatSearchCount").textContent = `${hits.length} found`;
    if (hits.length) $(`#messages [data-id="${hits[hits.length - 1].id}"]`)?.scrollIntoView({ block: "center" });
  });

  // composer
  const input = $("#input");
  input.addEventListener("input", () => {
    autosize();
    updateSendIcon();
    if (S.context?.mode !== "edit") notifyTyping();
  });
  input.addEventListener("keydown", (e) => {
    const touch = matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !touch) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === "Escape" && S.context) resetComposer();
    // up arrow edits your last message, like Telegram desktop
    if (e.key === "ArrowUp" && !input.value) {
      const last = [...(S.messages[S.current] || [])].reverse().find((m) => m.from === S.me.pin && m.kind === "text" && !m.deleted && !m.pending);
      if (last) {
        e.preventDefault();
        S.context = { mode: "edit", msg: last };
        input.value = last.text;
        input.dataset.editing = "1";
        autosize();
        renderComposer();
      }
    }
  });
  $("#sendBtn").addEventListener("click", () => {
    if (recorder) return recorder.stop();
    if (!input.value.trim() && S.context?.mode !== "edit" && navigator.mediaDevices && window.MediaRecorder) return startRecording();
    sendMessage();
  });
  $("#recCancel").addEventListener("click", () => {
    recCancelled = true;
    recorder?.stop();
  });
  $("#contextClose").addEventListener("click", resetComposer);
  $("#effectBtn").addEventListener("click", effectMenu);
  $("#fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const caption = input.value.trim();
      if (file.type.startsWith("image/")) {
        const media = await compressImage(file);
        if (media.length > MAX_MEDIA) return toast("That photo is too big.");
        sendMessage({ kind: "image", media, text: caption });
      } else {
        if (file.size > MAX_MEDIA * 0.74) return toast("Files up to about 2 MB for now.");
        const media = await readFileAsDataURL(file);
        sendMessage({ kind: "file", media, fileName: file.name, text: caption });
      }
      input.value = "";
      autosize();
      updateSendIcon();
    } catch {
      toast("Couldn't read that file.");
    }
  });
  // paste an image straight into the box
  input.addEventListener("paste", async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    const media = await compressImage(item.getAsFile());
    sendMessage({ kind: "image", media, text: input.value.trim() });
    input.value = "";
  });

  // messages
  const box = $("#messages");
  box.addEventListener("contextmenu", (e) => {
    const el = e.target.closest(".msg");
    if (!el || e.target.closest("a, audio")) return;
    e.preventDefault();
    messageMenu(el.dataset.id, e.clientX, e.clientY);
  });
  // double tap = ❤️, like iMessage/Instagram
  box.addEventListener("dblclick", (e) => {
    const el = e.target.closest(".msg");
    if (!el || e.target.closest("a, audio, img")) return;
    const m = findMsg(S.current, el.dataset.id);
    if (!m || m.pending || m.deleted) return;
    window.getSelection()?.removeAllRanges();
    wsSend({ type: "react", chatId: S.current, msgId: m.id, emoji: "❤️" });
  });
  // long press on touch
  let pressTimer = null;
  box.addEventListener("touchstart", (e) => {
    const el = e.target.closest(".msg");
    if (!el || e.target.closest("a, audio")) return;
    const t = e.touches[0];
    pressTimer = setTimeout(() => {
      navigator.vibrate?.(15);
      messageMenu(el.dataset.id, t.clientX, t.clientY);
    }, 450);
  }, { passive: true });
  ["touchend", "touchmove", "touchcancel"].forEach((ev) => box.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));
  box.addEventListener("click", (e) => {
    const q = e.target.closest("[data-jump]");
    if (q) return jumpTo(q.dataset.jump);
  });

  document.addEventListener("click", (e) => {
    const img = e.target.closest("img[data-zoom]");
    if (img) {
      const lb = document.createElement("div");
      lb.className = "lightbox";
      lb.innerHTML = `<img src="${img.src}" alt="">`;
      lb.onclick = () => lb.remove();
      document.body.append(lb);
      return;
    }
    if (!e.target.closest("#menu") && !e.target.closest("#effectBtn")) closeMenu();
    const copy = e.target.closest("[data-copy]");
    if (copy) navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast("Copied"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMenu();
      closeSheet();
      $(".lightbox")?.remove();
    }
  });

  // sheets
  $("#sheetBackdrop").addEventListener("click", (e) => {
    if (e.target === e.currentTarget || e.target.closest("[data-close]")) return closeSheet();
    const n = e.target.closest("[data-new]")?.dataset.new;
    if (n === "contact") showContactSheet();
    if (n === "group" || n === "channel") showCreateSheet(n);
    if (n === "join") showJoinSheet();
    if (n === "mypin") showPinSheet();
    if (e.target.closest("[data-logout]")) {
      wsSend({ type: "logout", token: S.token });
      store.set("oc.token", null);
      S.token = null;
      S.me = null;
      closeSheet();
      closeChat();
      showAuth();
    }
    if (e.target.closest("[data-notif]")) {
      Notification.requestPermission().then(() => showProfileSheet());
    }
    if (e.target.closest("[data-remove-avatar]")) {
      wsSend({ type: "profile", avatar: null });
      closeSheet();
    }
  });
  $("#sheet").addEventListener("change", async (e) => {
    if (e.target.name === "avatar" && e.target.files[0]) {
      const avatar = await compressImage(e.target.files[0], 256, 0.85);
      wsSend({ type: "profile", avatar });
      toast("Photo updated");
    }
  });
  $("#sheet").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const f = new FormData(form);
    const kind = form.dataset.form;
    if (kind === "contact") wsSend({ type: "addContact", pin: f.get("pin") });
    if (kind === "create") wsSend({ type: "createChat", chatType: form.dataset.type, name: f.get("name"), members: f.getAll("m") });
    if (kind === "join") wsSend({ type: "joinByInvite", code: f.get("code") });
    if (kind === "addMembers") wsSend({ type: "addMembers", chatId: S.current, members: f.getAll("m") });
    if (kind === "profile") {
      wsSend({ type: "profile", name: f.get("name"), status: f.get("status") });
      S.receiptStyle = f.get("receipts");
      store.set("oc.receipts", S.receiptStyle);
      const theme = f.get("theme");
      if (theme === "auto") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
      store.set("oc.theme", theme);
      if (S.current) renderMessages({ keepScroll: true });
      renderSidebar();
    }
    closeSheet();
  });

  // panel
  $("#panel").addEventListener("click", (e) => {
    if (e.target.closest("[data-panel-close]")) togglePanel(false);
    if (e.target.closest("[data-leave]")) {
      const chat = S.chats[S.current];
      if (confirm(`Leave "${chat.name}"?`)) wsSend({ type: "leaveChat", chatId: chat.id });
    }
    if (e.target.closest("[data-add-members]")) {
      const chat = S.chats[S.current];
      openSheet(`<h3>Add people</h3><form class="stack" data-form="addMembers">${memberPicker(chat.members)}
        <div class="actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Add</button></div></form>`);
    }
  });
  $("#panel").addEventListener("change", (e) => {
    if (e.target.matches("[data-timer]")) wsSend({ type: "updateChat", chatId: S.current, disappear: Number(e.target.value) });
    if (e.target.matches("[data-desc]")) wsSend({ type: "updateChat", chatId: S.current, description: e.target.value });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") markRead();
    else saveDraft();
  });
  addEventListener("beforeunload", saveDraft);
}

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

const savedTheme = store.get("oc.theme", "auto");
if (savedTheme !== "auto") document.documentElement.dataset.theme = savedTheme;
bind();
connect();
if (!S.token) showAuth();
