import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// ─── Draft queue ────────────────────────────────────────────────────────────
const draftQueue = [];

// ─── Seen messages tracker (poll dedup) ─────────────────────────────────────
const seenMessageIds = new Set();

// ─── Notification schedule (CT) ─────────────────────────────────────────────
const DIGEST_HOURS_CT = [9, 13, 17, 20]; // 9am, 1pm, 5pm, 8pm

function nowCT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
}

function isQuietHours() {
  const hour = nowCT().getHours();
  return hour >= 22 || hour < 9;
}

// ─── GHL API helpers ─────────────────────────────────────────────────────────
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_HEADERS = {
  Authorization: `Bearer ${process.env.GHL_API_KEY}`,
  Version: '2021-04-15',
  'Content-Type': 'application/json',
};

async function getRecentConversations() {
  const res = await axios.get(
    `${GHL_BASE}/conversations/search`,
    {
      headers: GHL_HEADERS,
      params: { locationId: process.env.GHL_LOCATION_ID, limit: 20 }
    }
  );
  return res.data.conversations || [];
}

async function getConversationMessages(conversationId) {
  const res = await axios.get(
    `${GHL_BASE}/conversations/${conversationId}/messages`,
    { headers: GHL_HEADERS }
  );
  // GHL returns { messages: { messages: [...] } } or { messages: [...] }
  const data = res.data.messages;
  if (Array.isArray(data)) return data;
  if (data?.messages && Array.isArray(data.messages)) return data.messages;
  return [];
}

async function getContact(contactId) {
  const res = await axios.get(
    `${GHL_BASE}/contacts/${contactId}`,
    { headers: GHL_HEADERS }
  );
  return res.data.contact;
}

async function sendGHLMessage(conversationId, message) {
  await axios.post(
    `${GHL_BASE}/conversations/messages`,
    {
      type: 'SMS',
      conversationId,
      message,
    },
    { headers: GHL_HEADERS }
  );
}

async function updateOpportunityStage(contactId, stage) {
  const res = await axios.get(
    `${GHL_BASE}/opportunities/search?contact_id=${contactId}&location_id=${process.env.GHL_LOCATION_ID}`,
    { headers: GHL_HEADERS }
  );
  const opps = res.data.opportunities || [];
  if (!opps.length) return;

  const oppId = opps[0].id;
  await axios.put(
    `${GHL_BASE}/opportunities/${oppId}`,
    { stageId: stage },
    { headers: GHL_HEADERS }
  );
}

async function updateContactTags(contactId, tagsToAdd, tagsToRemove) {
  if (tagsToAdd?.length) {
    await axios.post(
      `${GHL_BASE}/contacts/${contactId}/tags`,
      { tags: tagsToAdd },
      { headers: GHL_HEADERS }
    );
  }
  if (tagsToRemove?.length) {
    await axios.delete(
      `${GHL_BASE}/contacts/${contactId}/tags`,
      {
        headers: GHL_HEADERS,
        data: { tags: tagsToRemove }
      }
    );
  }
}

async function addContactNote(contactId, note) {
  await axios.post(
    `${GHL_BASE}/contacts/${contactId}/notes`,
    { body: note, userId: process.env.GHL_USER_ID || '' },
    { headers: GHL_HEADERS }
  );
}

// ─── Telegram helpers ────────────────────────────────────────────────────────
const TG_BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendTelegram(text, replyMarkup = null) {
  const payload = {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await axios.post(`${TG_BASE}/sendMessage`, payload);
}

async function answerCallbackQuery(callbackQueryId, text) {
  await axios.post(`${TG_BASE}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
    text,
  });
}

// ─── Claude draft generation ─────────────────────────────────────────────────
const SETTER_SOP = `You are Kimberly Ring, a high-performance sales setter for Naomi Rose Mustangs — a liberty horse training program called the Connected Liberty Project (CLP).

Your job is to qualify inbound leads and book discovery calls with Naomi. You are warm, direct, and results-focused. You do not pitch — you qualify and connect.

CONTEXT:
- The program is the Connected Liberty Project (CLP) — a liberty horse training program
- Leads come in via Instagram/Facebook DMs after commenting "CLP" on Naomi's content
- Your goal: qualify them (do they have a horse? Are they coachable? Do they want this result?) and book a call with Naomi
- Price is not discussed — that happens on the call with Naomi

YOUR VOICE:
- Warm but not fluffy
- Direct questions, not essays
- Short messages — 1-3 sentences max
- Never use corporate language or sound like a bot
- Mirror the lead's energy level

QUALIFICATION CRITERIA (must hit all 3 to book):
1. Has a horse (or access to one)
2. Has a specific goal or problem with their horse
3. Expresses genuine interest in the program

BOOKING LANGUAGE:
When qualified, say something like: "I'd love to get you on a quick call with Naomi — she can walk you through exactly how CLP would work for you and [horse name/situation]. Are you free this week?"

PIPELINE STAGES:
- New Lead → Contacted
- Contacted → Qualified (all 3 criteria met)
- Qualified → Call Booked
- Call Booked → Show / No Show

RESPONSE FORMAT:
Return ONLY valid JSON, no other text:
{
  "draft_message": "your drafted reply here",
  "bucket": "PIPELINE" | "QUALIFIED" | "BOOKING" | "OBJECTION" | "DEAD",
  "recommended_action": {
    "type": "stage_change" | "tag_add" | "none",
    "new_stage": "Contacted" | "Qualified" | "Call Booked" | null,
    "tags_to_add": ["tag1"] | [],
    "tags_to_remove": ["tag2"] | []
  },
  "priority": "high" | "normal" | "low",
  "reasoning": "one sentence on why you drafted this response"
}

Priority is "high" if: lead says they want to book, raises a price/objection, or has been waiting 4+ hours.`;

async function generateDraft(contact, messages) {
  const conversationText = messages
    .slice(-20)
    .map(m => `${m.direction === 'inbound' ? contact.firstName || 'Lead' : 'Kimberly'}: ${m.body}`)
    .join('\n');

  const userPrompt = `Contact: ${contact.firstName} ${contact.lastName || ''}
Tags: ${(contact.tags || []).join(', ') || 'none'}
Pipeline stage: ${contact.opportunities?.[0]?.stage?.name || 'unknown'}

Conversation:
${conversationText}

Draft a reply and recommend a pipeline action. Return JSON only.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SETTER_SOP,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text.trim();
  return JSON.parse(text);
}

// ─── Digest sender ────────────────────────────────────────────────────────────
async function sendDigest() {
  const pending = draftQueue.filter(d => d.status === 'pending');
  if (!pending.length) return;

  for (const draft of pending) {
    const msg = `<b>📩 New lead reply — ${draft.contactName}</b>\n\n` +
      `<b>Draft:</b>\n${draft.draft_message}\n\n` +
      `<b>Recommended:</b> ${draft.recommended_action?.new_stage || 'No stage change'}\n` +
      `<b>Priority:</b> ${draft.priority}`;

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${draft.id}` },
        { text: '✏️ Edit', callback_data: `edit:${draft.id}` },
        { text: '⏭ Skip', callback_data: `skip:${draft.id}` },
      ]],
    };

    await sendTelegram(msg, keyboard);
    draft.status = 'sent_to_review';
  }
}

// ─── POLL: check GHL for new inbound messages ─────────────────────────────────
async function pollGHL() {
  console.log(`[poll] Checking GHL at ${new Date().toISOString()}`);
  try {
    const conversations = await getRecentConversations();
    console.log(`[poll] Found ${conversations.length} conversations`);

    for (const convo of conversations) {
      // Only process conversations with unread inbound messages
      if (!convo.unreadCount || convo.unreadCount === 0) continue;

      const messages = await getConversationMessages(convo.id);
      const newInbound = messages.filter(
        m => m.direction === 'inbound' && !seenMessageIds.has(m.id)
      );

      if (!newInbound.length) continue;

      // Mark all as seen
      for (const m of messages) seenMessageIds.add(m.id);

      // Skip if we already have a pending draft for this conversation
      const alreadyQueued = draftQueue.find(
        d => d.conversationId === convo.id && d.status === 'pending'
      );
      if (alreadyQueued) continue;

      const contact = await getContact(convo.contactId);
      const claudeResponse = await generateDraft(contact, messages);

      const draftId = crypto.randomUUID();
      const draft = {
        id: draftId,
        contactId: convo.contactId,
        conversationId: convo.id,
        contactName: `${contact.firstName} ${contact.lastName || ''}`.trim(),
        draft_message: claudeResponse.draft_message,
        recommended_action: claudeResponse.recommended_action,
        priority: claudeResponse.priority,
        bucket: claudeResponse.bucket,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      draftQueue.push(draft);
      console.log(`Queued draft for ${draft.contactName} (${draft.priority} priority)`);

      // Immediate alert for high priority
      if (claudeResponse.priority === 'high' && !isQuietHours()) {
        await sendDigest();
      }
    }
  } catch (err) {
    console.error('[poll] Error:', err.message);
    if (err.response) {
      console.error('[poll] GHL response:', err.response.status, JSON.stringify(err.response.data));
    }
  }
}

// ─── Scheduled digest + poll ──────────────────────────────────────────────────
function scheduleDigests() {
  // Poll GHL every 3 minutes
  setInterval(pollGHL, 3 * 60 * 1000);

  // Send digests at scheduled hours
  setInterval(async () => {
    if (isQuietHours()) return;
    const now = nowCT();
    const hour = now.getHours();
    const minute = now.getMinutes();
    if (DIGEST_HOURS_CT.includes(hour) && minute === 0) {
      await sendDigest();
    }
  }, 60 * 1000);
}

// ─── Telegram webhook (for button callbacks) ──────────────────────────────────
app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200);

  const { callback_query, message } = req.body;

  if (callback_query) {
    const { id: callbackId, data, message: cbMessage } = callback_query;
    const [action, draftId] = data.split(':');
    const draft = draftQueue.find(d => d.id === draftId);

    if (!draft) {
      await answerCallbackQuery(callbackId, 'Draft not found.');
      return;
    }

    if (action === 'approve') {
      await sendGHLMessage(draft.conversationId, draft.draft_message);
      if (draft.recommended_action?.new_stage) {
        await updateOpportunityStage(draft.contactId, draft.recommended_action.new_stage);
      }
      if (draft.recommended_action?.tags_to_add?.length || draft.recommended_action?.tags_to_remove?.length) {
        await updateContactTags(
          draft.contactId,
          draft.recommended_action.tags_to_add,
          draft.recommended_action.tags_to_remove
        );
      }
      await addContactNote(
        draft.contactId,
        `Draft approved by Kimberly via Claude Setter Bot at ${new Date().toISOString()}`
      );
      draft.status = 'approved';
      await answerCallbackQuery(callbackId, '✅ Sent!');

    } else if (action === 'edit') {
      draft.status = 'awaiting_edit';
      draft.telegramMessageId = cbMessage.message_id;
      await answerCallbackQuery(callbackId, 'Send your edited message now.');
      await sendTelegram(`✏️ Reply with your edited message for <b>${draft.contactName}</b>:\n\n<i>Current draft:</i>\n${draft.draft_message}`);

    } else if (action === 'skip') {
      draft.status = 'skipped';
      await answerCallbackQuery(callbackId, '⏭ Skipped.');
    }
  }

  // Handle edit replies
  if (message?.text) {
    const editDraft = draftQueue.find(d => d.status === 'awaiting_edit');
    if (editDraft) {
      await sendGHLMessage(editDraft.conversationId, message.text);
      await addContactNote(
        editDraft.contactId,
        `Edited draft sent by Kimberly via Claude Setter Bot at ${new Date().toISOString()}`
      );
      editDraft.status = 'approved_edited';
      await sendTelegram(`✅ Edited message sent to <b>${editDraft.contactName}</b>.`);
    }
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', queueLength: draftQueue.length }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Setter bot running on port ${PORT}`);
  scheduleDigests();
  // Run first poll immediately on startup
  console.log('Running initial GHL poll...');
  await pollGHL();
});
