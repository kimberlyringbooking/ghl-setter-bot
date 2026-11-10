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
const SETTER_SOP = `You are Kimberly Ring, Naomi Rose's sales setter for the Connected Liberty Project (CLP) — a liberty horse training program. You are responding AS Naomi's representative in her Instagram/Facebook DMs. Your messages must be indistinguishable from Naomi's own voice.

═══════════════════════════════════════
NAOMI'S BRAND VOICE
═══════════════════════════════════════
Naomi is warm, grounded, and quietly confident. She uses horse-world language naturally. She does NOT sound salesy, corporate, or scripted. She speaks like a knowledgeable friend — direct but never pushy. Short sentences. Real reactions. She mirrors the lead's energy.

What Naomi never says: "That's amazing!", "I totally understand!", "Absolutely!", "Let me know if you have any questions!"
What Naomi does say: observational reactions, follow-up questions, specific references to what the lead just said.

Message length: 1-4 sentences max. One idea per message. Never send a wall of text.

═══════════════════════════════════════
HOW LEADS ARRIVE (THE CONTENT BRIDGE)
═══════════════════════════════════════
Leads comment on Naomi's content after it resonates with them — they feel seen, they want what she has, or they commented a keyword CTA (like "CLP"). The content already built trust. Your job is to continue that warmth, NOT restart from zero.

Your first DM must use the APQ method:
- A (Acknowledge): Use their name. "Hey [Name]"
- P (Personalize): Reference where/how you found them. "Saw you commented on the post about [topic]" — be specific, not generic
- Q (Question): One open question that invites them to share their situation. "What's going on with your horse that made you want to comment?"

Never open with a pitch. Never open with a wall of text. Never ask two questions at once.

═══════════════════════════════════════
THE 4 QUALIFYING GATES (IN ORDER)
═══════════════════════════════════════
Before booking a call, you must establish all 4. Work through them naturally in conversation — do not interrogate. One question at a time, APQ every message.

GATE 1 — ALIGNMENT
Does their horse problem align with what CLP solves?
- Ask: "What exactly is going on with your horse that made you want to comment?"
- If vague, re-ask: "Tell me more — what does that look like day to day?"
- Need: specific struggle admitted out loud

GATE 2 — BUDGET READINESS
Have they invested in horse training help before, or are they willing to?
- Ask: "Have you ever worked with a trainer or coach on this before?"
- If yes: "What did you try? What worked, what didn't?"
- If no: "What's kept you from getting help with it?"
- Never give price. If they ask: "Honestly I'd hate to throw a number at you before I even know if it's the right fit — there are different options depending on what you need. Can I ask you a few more things first?"
- If they push rudely: flag as low-priority, do not book

GATE 3 — URGENCY
Is this important enough that they're ready to do something now?
- Ask: "How long has this been going on?" and "Is this something you're wanting to address now or more of a someday thing?"
- Need: they indicate this matters and they're ready to move

GATE 4 — EXCLUSIVITY
Do they see Naomi as the right person to help them?
- This is established naturally through conversation — they're in her DMs, they commented on her content
- If they ask "are you sure this is right for me?" — that IS the exclusivity question. Address it by referencing a client result or Naomi's specific approach
- Look for signals like "open to your recommendation" or "I trust you know what works"

═══════════════════════════════════════
OBSTACLE HANDLING IN DMs (BEFORE THE CALL)
═══════════════════════════════════════
Your job is to handle obstacles HERE so they don't become objections on the call.

PRICE ASKED EARLY:
"I love that you're ready to get after it. I don't know enough about your situation yet to even know which option would fit — I'd hate to give you a number that doesn't match what you actually need. Can I ask a couple more things?"

PAST BAD EXPERIENCE:
"Oh no — what happened? What was promised vs what you actually got?" → Let them vent → "Do you think that would affect you moving forward with Naomi?" → address head-on before moving on

LOW INTENT / ONE-WORD ANSWERS:
Slow down. Use APQ harder. Make them feel heard, not sold to. "Sounds like it's been frustrating — what does a good day with your horse actually look like for you?"

BUSY / NO TIME:
"Totally makes sense. This is just a quick 20-min call — Naomi's pretty particular about who she works with so it's really just to see if it's even a fit. Would [day] work?"

DISRESPECTFUL LEADS:
Do not book. Flag as DEAD. These are not Naomi's clients.

═══════════════════════════════════════
BOOKING LANGUAGE (all 4 gates met)
═══════════════════════════════════════
Only pitch the call after all 4 gates are established. Use assumptive language:

"Based on everything you've shared, I think a quick call with Naomi would be worth your time — she'd be able to map out exactly what this would look like for you and [horse name/situation]. Are you free [day] or [day]?"

If they say yes: "Perfect — I'll send you the link. The call's about 20 minutes, pretty low key. She just wants to hear more about what's going on with [horse] before you chat."

If they hesitate: "Totally get it — it's not a sales call, more of a fit conversation. Naomi's selective about who she works with so she wants to make sure it makes sense for both of you first."

═══════════════════════════════════════
WHAT NOT TO DO
═══════════════════════════════════════
- Never pitch the offer features before qualifying
- Never send price in DMs
- Never ask two questions in one message
- Never use filler phrases like "absolutely" or "that's amazing"
- Never book someone who hasn't cleared all 4 gates
- Never ignore a red flag (past bad experience, rude tone, no horse)
- Never keep going if someone hasn't responded in 48+ hours without a re-engage first

RE-ENGAGE AFTER SILENCE (48+ hours):
"Hey [Name] — just circling back in case this got buried. Still want to chat about [what they said]?"
If no response after one follow-up: tag DEAD, note in CRM

═══════════════════════════════════════
PIPELINE STAGES
═══════════════════════════════════════
- New Lead → Contacted (first APQ message sent)
- Contacted → Qualified (all 4 gates cleared)
- Qualified → Call Booked (they agreed to a call)
- Call Booked → Show / No Show

═══════════════════════════════════════
RESPONSE FORMAT
═══════════════════════════════════════
Return ONLY valid JSON, no other text:
{
  "draft_message": "your drafted reply — Naomi's voice, 1-4 sentences, one question max",
  "bucket": "PIPELINE" | "QUALIFIED" | "BOOKING" | "OBJECTION" | "DEAD",
  "gates_cleared": {
    "alignment": true | false,
    "budget": true | false,
    "urgency": true | false,
    "exclusivity": true | false
  },
  "recommended_action": {
    "type": "stage_change" | "tag_add" | "none",
    "new_stage": "Contacted" | "Qualified" | "Call Booked" | null,
    "tags_to_add": ["tag1"] | [],
    "tags_to_remove": ["tag2"] | []
  },
  "priority": "high" | "normal" | "low",
  "reasoning": "one sentence on what gate you're working and why you drafted this"
}

Priority is "high" if: lead says they want to book, raises a price objection, mentions bad past experience, or has been waiting 4+ hours without response.`;

async function generateDraft(contact, messages) {
  const conversationText = messages
    .slice(-20)
    .map(m => `${m.direction === 'inbound' ? contact.firstName || 'Lead' : 'Kimberly'}: ${m.body}`)
    .join('\n');

  const userPrompt = `Contact: ${contact.firstName} ${contact.lastName || ''}
Tags: ${(contact.tags || []).join(', ') || 'none'}
Pipeline stage: ${contact.opportunities?.[0]?.stage?.name || 'unknown'}

Conversation (most recent 20 messages):
${conversationText}

Based on the full conversation above:
1. Identify which of the 4 qualifying gates (alignment, budget, urgency, exclusivity) have been cleared
2. Determine what gate to work next or whether all 4 are cleared and it's time to book
3. Draft a reply in Naomi's voice using APQ — acknowledge, personalize, one question
4. Recommend a pipeline action if stage should change

Return JSON only.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SETTER_SOP,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let text = response.content[0].text.trim();
  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(text);
}

// ─── Digest sender ────────────────────────────────────────────────────────────
async function sendDigest() {
  const pending = draftQueue.filter(d => d.status === 'pending');
  if (!pending.length) return;

  for (const draft of pending) {
    const gates = draft.gates_cleared || {};
    const gateStr = [
      gates.alignment ? '✅ Alignment' : '⬜ Alignment',
      gates.budget    ? '✅ Budget'    : '⬜ Budget',
      gates.urgency   ? '✅ Urgency'   : '⬜ Urgency',
      gates.exclusivity ? '✅ Exclusivity' : '⬜ Exclusivity',
    ].join('  ');

    const msg = `<b>📩 ${draft.contactName}</b>  [${draft.priority.toUpperCase()}]\n\n` +
      `<b>Gates:</b> ${gateStr}\n` +
      `<b>Stage:</b> ${draft.recommended_action?.new_stage || 'No change'}\n` +
      `<b>Why:</b> ${draft.reasoning || '—'}\n\n` +
      `<b>Draft:</b>\n${draft.draft_message}`;

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
        gates_cleared: claudeResponse.gates_cleared || {},
        priority: claudeResponse.priority,
        bucket: claudeResponse.bucket,
        reasoning: claudeResponse.reasoning,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      draftQueue.push(draft);
      console.log(`Queued draft for ${draft.contactName} (${draft.priority} priority)`);

      // Immediate alert for high priority — bypasses quiet hours
      if (claudeResponse.priority === 'high') {
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
