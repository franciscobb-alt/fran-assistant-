const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { createApp } = require("../src/app");

const env = { API_TOKEN: "tok", WA_VERIFY_TOKEN: "vt", WA_APP_SECRET: "secret", DB_PATH: ":memory:" };

function payload(id, text = "hi", ts = Math.floor(Date.now() / 1000)) {
  return {
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: "6591234567", profile: { name: "Aisha" } }],
      messages: [{ from: "6591234567", id, timestamp: String(ts), type: "text", text: { body: text } }],
    } }] }],
  };
}

async function start(sendText) {
  const server = createApp(env, { sendText }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => {
    const raw = JSON.stringify(body);
    const sig = "sha256=" + crypto.createHmac("sha256", "secret").update(raw).digest("hex");
    return fetch(base + "/webhooks/whatsapp", {
      method: "POST", body: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    });
  };
  const api = (path, opts = {}) =>
    fetch(base + "/api" + path, {
      ...opts,
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: opts.body && JSON.stringify(opts.body),
    });
  return { server, base, post, api };
}

test("webhook verify handshake", async () => {
  const { server, base } = await start();
  const ok = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc`);
  assert.equal(await ok.text(), "abc");
  const bad = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=no&hub.challenge=abc`);
  assert.equal(bad.status, 403);
  server.close();
});

test("rejects bad signature and missing api token", async () => {
  const { server, base } = await start();
  const r = await fetch(base + "/webhooks/whatsapp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(r.status, 401);
  assert.equal((await fetch(base + "/api/conversations")).status, 401);
  server.close();
});

test("inbound creates one conversation, dedupes retries, reply works", async () => {
  const sent = [];
  const { server, post, api } = await start(async (m) => { sent.push(m); return "wamid.OUT1"; });
  await post(payload("wamid.A"));
  await post(payload("wamid.A")); // Meta retry
  await post(payload("wamid.B", "price?"));

  const list = await (await api("/conversations")).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].unread, 2);
  assert.equal(list[0].contact_name, "Aisha");

  const id = list[0].id;
  assert.equal((await api(`/conversations/${id}/messages`, { method: "POST", body: { body: "Hello!" } })).status, 201);
  assert.deepEqual(sent[0], { to: "6591234567", body: "Hello!" });

  await api(`/conversations/${id}/tags`, { method: "POST", body: { tag: "Lead" } });
  await api(`/conversations/${id}/notes`, { method: "POST", body: { body: "wants a quote" } });
  const conv = await (await api(`/conversations/${id}`)).json();
  assert.equal(conv.messages.length, 3);
  assert.deepEqual(conv.tags, ["lead"]);
  assert.equal(conv.notes.length, 1);
  assert.equal(conv.unread, 0);
  server.close();
});

test("blocks free-form reply outside the 24h window", async () => {
  const { server, post, api } = await start(async () => "x");
  await post(payload("wamid.OLD", "old", Math.floor(Date.now() / 1000) - 3 * 86400));
  const [c] = await (await api("/conversations")).json();
  const r = await api(`/conversations/${c.id}/messages`, { method: "POST", body: { body: "hey" } });
  assert.equal(r.status, 409);
  server.close();
});
