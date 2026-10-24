// Protocol tests: boots the server on a temp port and drives it with real sockets.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const WebSocket = require("ws");

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA_FILE = path.join(os.tmpdir(), `onechat-test-${process.pid}.json`);
let server;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT, DATA_FILE },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => server.stdout.once("data", resolve));
});

after(() => {
  server.kill();
  fs.rmSync(DATA_FILE, { force: true });
});

// A tiny client that records every event and can wait for one
function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const events = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const ev = JSON.parse(raw);
    events.push(ev);
    for (const w of [...waiters]) {
      if (w.match(ev)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(ev);
      }
    }
  });
  const c = {
    ws,
    events,
    ready: new Promise((r) => ws.once("open", r)),
    send: (p) => ws.send(JSON.stringify(p)),
    wait(match, ms = 2000) {
      if (typeof match === "string") {
        const type = match;
        match = (ev) => ev.type === type;
      }
      const found = events.find(match);
      if (found) {
        events.splice(events.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const w = { match, resolve: (ev) => (events.splice(events.indexOf(ev), 1), resolve(ev)) };
        waiters.push(w);
        setTimeout(() => reject(new Error("timed out waiting for event")), ms);
      });
    },
  };
  return c;
}

async function signup(name) {
  const c = client();
  await c.ready;
  c.send({ type: "register", name, password: "secret123" });
  const init = await c.wait("init");
  c.pin = init.me.pin;
  c.token = init.token;
  return c;
}

test("register gives an 8 char PIN and login works on a second device", async () => {
  const a = await signup("Ada");
  assert.match(a.pin, /^[0-9A-F]{8}$/);

  const device2 = client();
  await device2.ready;
  device2.send({ type: "login", pin: a.pin.toLowerCase(), password: "secret123" });
  const init = await device2.wait("init");
  assert.equal(init.me.pin, a.pin);

  const bad = client();
  await bad.ready;
  bad.send({ type: "login", pin: a.pin, password: "nope" });
  assert.equal((await bad.wait("error")).error, "Wrong PIN or password.");
  [a, device2, bad].forEach((c) => c.ws.close());
});

test("DM: send, delivered, read, react, edit, delete", async () => {
  const a = await signup("Ada");
  const b = await signup("Bob");

  a.send({ type: "addContact", pin: b.pin });
  const { chatId } = await a.wait("open");
  await b.wait((e) => e.type === "chat" && e.chat.id === chatId);

  a.send({ type: "send", chatId, text: "hey", clientId: "c1" });
  const got = await b.wait("message");
  assert.equal(got.message.text, "hey");
  assert.deepEqual(got.message.deliveredTo, [b.pin], "Bob is online so it's delivered at once");
  const msgId = got.message.id;

  b.send({ type: "read", chatId });
  const receipt = await a.wait((e) => e.type === "receipt" && e.msgId === msgId);
  assert.deepEqual(receipt.readBy, [b.pin]);

  b.send({ type: "react", chatId, msgId, emoji: "❤️" });
  const reacted = await a.wait((e) => e.type === "update" && e.message.reactions[b.pin]);
  assert.equal(reacted.message.reactions[b.pin], "❤️");

  // Bob can't edit Ada's message
  b.send({ type: "edit", chatId, msgId, text: "hacked" });
  a.send({ type: "edit", chatId, msgId, text: "hey there" });
  const edited = await b.wait((e) => e.type === "update" && e.message.editedAt);
  assert.equal(edited.message.text, "hey there");

  a.send({ type: "delete", chatId, msgId });
  const deleted = await b.wait((e) => e.type === "update" && e.message.deleted);
  assert.equal(deleted.message.text, "");
  [a, b].forEach((c) => c.ws.close());
});

test("offline messages are marked delivered when the person comes back", async () => {
  const a = await signup("Ada");
  const b = await signup("Bob");
  a.send({ type: "addContact", pin: b.pin });
  const { chatId } = await a.wait("open");
  b.ws.close();
  await new Promise((r) => setTimeout(r, 100));

  a.send({ type: "send", chatId, text: "you there?" });
  const sent = await a.wait("message");
  assert.deepEqual(sent.message.deliveredTo, []);

  const b2 = client();
  await b2.ready;
  b2.send({ type: "resume", token: b.token });
  await b2.wait("init");
  const receipt = await a.wait((e) => e.type === "receipt" && e.msgId === sent.message.id);
  assert.deepEqual(receipt.deliveredTo, [b.pin]);
  [a, b2].forEach((c) => c.ws.close());
});

test("channels: only admins post, invite code lets people join", async () => {
  const owner = await signup("Owner");
  const fan = await signup("Fan");

  owner.send({ type: "createChat", chatType: "channel", name: "News", members: [] });
  const chatEv = await owner.wait((e) => e.type === "chat" && e.chat.type === "channel");
  const { id: chatId, invite } = chatEv.chat;
  assert.ok(invite, "admin sees the invite code");

  fan.send({ type: "joinByInvite", code: invite });
  const joined = await fan.wait((e) => e.type === "chat" && e.chat.id === chatId);
  assert.equal(joined.chat.invite, undefined, "non-admins don't see the code");

  fan.send({ type: "send", chatId, text: "can I post?" });
  assert.equal((await fan.wait("error")).error, "Only admins can post in this channel.");

  owner.send({ type: "send", chatId, text: "big news" });
  const post = await fan.wait((e) => e.type === "message" && e.message.text === "big news");
  assert.equal(post.message.from, owner.pin);
  [owner, fan].forEach((c) => c.ws.close());
});

test("disappearing messages expire", async () => {
  const a = await signup("Ada");
  const b = await signup("Bob");
  a.send({ type: "addContact", pin: b.pin });
  const { chatId } = await a.wait("open");
  a.send({ type: "updateChat", chatId, disappear: 1 });
  await a.wait((e) => e.type === "chat" && e.chat.disappear === 1);

  a.send({ type: "send", chatId, text: "self destruct" });
  const m = await b.wait((e) => e.type === "message" && e.message.text === "self destruct");
  assert.ok(m.message.expiresAt);
  const gone = await b.wait((e) => e.type === "expired" && e.msgId === m.message.id, 8000);
  assert.equal(gone.chatId, chatId);
  [a, b].forEach((c) => c.ws.close());
});

test("PING and typing reach the other side", async () => {
  const a = await signup("Ada");
  const b = await signup("Bob");
  a.send({ type: "addContact", pin: b.pin });
  const { chatId } = await a.wait("open");

  a.send({ type: "typing", chatId, state: "typing" });
  assert.equal((await b.wait("typing")).pin, a.pin);

  a.send({ type: "send", chatId, kind: "ping" });
  const ping = await b.wait((e) => e.type === "message" && e.message.kind === "ping");
  assert.equal(ping.message.from, a.pin);
  [a, b].forEach((c) => c.ws.close());
});
