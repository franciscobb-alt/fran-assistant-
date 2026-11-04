const express = require("express");
const crypto = require("node:crypto");
const { openDb } = require("./db");
const { createInbox } = require("./inbox");
const wa = require("./whatsapp");

const WINDOW_MS = 24 * 60 * 60 * 1000; // WhatsApp free-form reply window

function createApp(env = process.env, deps = {}) {
  const db = deps.db || openDb(env.DB_PATH || ":memory:");
  const inbox = createInbox(db);
  const send = deps.sendText || wa.sendText;
  const app = express();

  // Keep the raw body: Meta signs it, and we must verify the exact bytes.
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // ── WhatsApp webhook (public, protected by verify token + signature) ──
  app.get("/webhooks/whatsapp", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === env.WA_VERIFY_TOKEN) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    res.sendStatus(403);
  });

  app.post("/webhooks/whatsapp", (req, res) => {
    if (!wa.verifySignature(req.rawBody || Buffer.alloc(0), req.get("x-hub-signature-256"), env.WA_APP_SECRET)) {
      return res.sendStatus(401);
    }
    const { inbound, statuses } = wa.parseWebhook(req.body);
    for (const m of inbound) inbox.recordInbound({ channel: "whatsapp", ...m });
    for (const s of statuses) inbox.setMessageStatus(s.id, s.status);
    res.sendStatus(200); // always 200 fast, or Meta retries
  });

  // ── Authenticated API ──
  const api = express.Router();
  api.use((req, res, next) => {
    const given = Buffer.from((req.get("authorization") || "").replace(/^Bearer /, ""));
    const want = Buffer.from(env.API_TOKEN || "");
    if (!want.length || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return res.sendStatus(401);
    }
    next();
  });

  const convOr404 = (req, res) => {
    const c = inbox.getConversation(Number(req.params.id));
    if (!c) res.status(404).json({ error: "conversation not found" });
    return c;
  };

  api.get("/conversations", (req, res) => res.json(inbox.listConversations(req.query)));

  api.get("/conversations/:id", (req, res) => {
    const c = convOr404(req, res);
    if (c) res.json(c);
  });

  api.post("/conversations/:id/read", (req, res) => {
    if (!convOr404(req, res)) return;
    inbox.markRead(Number(req.params.id));
    res.sendStatus(204);
  });

  api.patch("/conversations/:id", (req, res) => {
    if (!convOr404(req, res)) return;
    const { status, assignee_id } = req.body || {};
    if (status !== undefined && !["open", "pending", "closed"].includes(status)) {
      return res.status(400).json({ error: "status must be open, pending or closed" });
    }
    inbox.updateConversation(Number(req.params.id), { status, assignee_id });
    res.json(inbox.getConversation(Number(req.params.id)));
  });

  api.post("/conversations/:id/messages", async (req, res) => {
    const c = convOr404(req, res);
    if (!c) return;
    const body = req.body && typeof req.body.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "body is required" });
    if (!c.last_inbound_at || Date.now() - Date.parse(c.last_inbound_at) > WINDOW_MS) {
      return res.status(409).json({
        error: "outside the 24h WhatsApp window; only an approved template message can be sent",
      });
    }
    try {
      const externalId = await send(
        { to: c.contact_external_id, body },
        { phoneNumberId: env.WA_PHONE_NUMBER_ID, accessToken: env.WA_ACCESS_TOKEN }
      );
      const id = inbox.recordOutbound({
        conversationId: c.id, body, externalId, agentId: req.body.agent_id,
      });
      res.status(201).json({ id, external_id: externalId });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  api.post("/conversations/:id/notes", (req, res) => {
    if (!convOr404(req, res)) return;
    const body = req.body && typeof req.body.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "body is required" });
    res.status(201).json(inbox.addNote(Number(req.params.id), body, req.body.agent_id));
  });

  api.post("/conversations/:id/tags", (req, res) => {
    if (!convOr404(req, res)) return;
    const tag = req.body && typeof req.body.tag === "string" ? req.body.tag.trim().toLowerCase() : "";
    if (!tag || tag.includes(",")) return res.status(400).json({ error: "tag is required, no commas" });
    inbox.addTag(Number(req.params.id), tag);
    res.sendStatus(204);
  });

  api.delete("/conversations/:id/tags/:tag", (req, res) => {
    if (!convOr404(req, res)) return;
    inbox.removeTag(Number(req.params.id), req.params.tag.toLowerCase());
    res.sendStatus(204);
  });

  app.use("/api", api);
  app.get("/health", (_req, res) => res.json({ ok: true }));
  return app;
}

module.exports = { createApp };
