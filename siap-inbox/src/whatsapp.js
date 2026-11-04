const crypto = require("node:crypto");

function verifySignature(rawBody, header, appSecret) {
  if (!header || !appSecret) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Flatten Meta's nested webhook payload into simple events.
function parseWebhook(payload) {
  const inbound = [];
  const statuses = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = {};
      for (const c of v.contacts || []) names[c.wa_id] = c.profile && c.profile.name;
      for (const m of v.messages || []) {
        let body = null;
        if (m.type === "text") body = m.text && m.text.body;
        else if (m.type === "button") body = m.button && m.button.text;
        else if (m.type === "interactive") {
          const i = m.interactive || {};
          body = (i.button_reply || i.list_reply || {}).title || null;
        } else {
          const media = m[m.type] || {};
          body = media.caption || `[${m.type}]`;
        }
        inbound.push({
          from: m.from,
          name: names[m.from] || null,
          id: m.id,
          type: m.type,
          body,
          timestamp: new Date(Number(m.timestamp) * 1000).toISOString(),
        });
      }
      for (const s of v.statuses || []) statuses.push({ id: s.id, status: s.status });
    }
  }
  return { inbound, statuses };
}

async function sendText({ to, body }, cfg, fetchImpl = fetch) {
  const res = await fetchImpl(
    `https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `WhatsApp API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data.messages && data.messages[0] && data.messages[0].id;
}

module.exports = { verifySignature, parseWebhook, sendText };
