// Core inbox logic. Channel-agnostic: WhatsApp is just the first adapter.

function createInbox(db) {
  const q = {
    upsertContact: db.prepare(
      `INSERT INTO contacts (channel, external_id, name) VALUES (?, ?, ?)
       ON CONFLICT(channel, external_id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)
       RETURNING id`
    ),
    upsertConv: db.prepare(
      `INSERT INTO conversations (contact_id, channel) VALUES (?, ?)
       ON CONFLICT(contact_id, channel) DO UPDATE SET contact_id = contact_id
       RETURNING id`
    ),
    insertMsg: db.prepare(
      `INSERT OR IGNORE INTO messages (conversation_id, direction, body, type, external_id, status, sent_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ),
  };

  function recordInbound({ channel, from, name, id, type, body, timestamp }) {
    const contactId = q.upsertContact.get(channel, from, name || null).id;
    const convId = q.upsertConv.get(contactId, channel).id;
    const msg = q.insertMsg.get(convId, "in", body, type || "text", id || null, "received", null, timestamp);
    if (!msg) return null; // duplicate webhook delivery, already stored
    db.prepare(
      `UPDATE conversations
       SET unread = unread + 1, last_message_at = ?, last_inbound_at = ?, last_preview = ?,
           status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
       WHERE id = ?`
    ).run(timestamp, timestamp, (body || "").slice(0, 120), convId);
    return { conversationId: convId, messageId: msg.id };
  }

  function recordOutbound({ conversationId, body, externalId, agentId }) {
    const now = new Date().toISOString();
    const msg = q.insertMsg.get(conversationId, "out", body, "text", externalId || null, "sent", agentId || null, now);
    db.prepare(
      `UPDATE conversations SET last_message_at = ?, last_preview = ?, unread = 0 WHERE id = ?`
    ).run(now, (body || "").slice(0, 120), conversationId);
    return msg.id;
  }

  function setMessageStatus(externalId, status) {
    db.prepare(`UPDATE messages SET status = ? WHERE external_id = ?`).run(status, externalId);
  }

  function listConversations({ status, assignee, tag, limit = 50, before } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push("c.status = ?"); args.push(status); }
    if (assignee === "none") where.push("c.assignee_id IS NULL");
    else if (assignee) { where.push("c.assignee_id = ?"); args.push(Number(assignee)); }
    if (tag) {
      where.push("EXISTS (SELECT 1 FROM conversation_tags t WHERE t.conversation_id = c.id AND t.tag = ?)");
      args.push(tag);
    }
    if (before) { where.push("c.last_message_at < ?"); args.push(before); }
    args.push(Math.min(Number(limit) || 50, 200));
    return db
      .prepare(
        `SELECT c.id, c.channel, c.status, c.assignee_id, c.unread, c.last_message_at, c.last_preview,
                ct.name AS contact_name, ct.external_id AS contact_id,
                (SELECT group_concat(tag) FROM conversation_tags t WHERE t.conversation_id = c.id) AS tags
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY c.last_message_at DESC LIMIT ?`
      )
      .all(...args)
      .map((r) => ({ ...r, tags: r.tags ? r.tags.split(",") : [] }));
  }

  function getConversation(id) {
    const conv = db
      .prepare(
        `SELECT c.*, ct.name AS contact_name, ct.external_id AS contact_external_id
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?`
      )
      .get(id);
    if (!conv) return null;
    conv.messages = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY id`).all(id);
    conv.notes = db.prepare(`SELECT * FROM notes WHERE conversation_id = ? ORDER BY id`).all(id);
    conv.tags = db.prepare(`SELECT tag FROM conversation_tags WHERE conversation_id = ?`).all(id).map((r) => r.tag);
    return conv;
  }

  function markRead(id) {
    db.prepare(`UPDATE conversations SET unread = 0 WHERE id = ?`).run(id);
  }

  function updateConversation(id, { status, assignee_id }) {
    if (status !== undefined) db.prepare(`UPDATE conversations SET status = ? WHERE id = ?`).run(status, id);
    if (assignee_id !== undefined) db.prepare(`UPDATE conversations SET assignee_id = ? WHERE id = ?`).run(assignee_id, id);
  }

  function addNote(conversationId, body, agentId) {
    return db
      .prepare(`INSERT INTO notes (conversation_id, agent_id, body) VALUES (?, ?, ?) RETURNING *`)
      .get(conversationId, agentId || null, body);
  }

  function addTag(conversationId, tag) {
    db.prepare(`INSERT OR IGNORE INTO conversation_tags (conversation_id, tag) VALUES (?, ?)`).run(conversationId, tag);
  }
  function removeTag(conversationId, tag) {
    db.prepare(`DELETE FROM conversation_tags WHERE conversation_id = ? AND tag = ?`).run(conversationId, tag);
  }

  return {
    recordInbound, recordOutbound, setMessageStatus, listConversations,
    getConversation, markRead, updateConversation, addNote, addTag, removeTag,
  };
}

module.exports = { createInbox };
