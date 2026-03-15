require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;

const conversations = new Map();
const leads = [];

const COMPANY   = process.env.COMPANY_NAME || 'Premier Plumbing';
const OWNER_NUM = process.env.OWNER_PHONE;
const BOT_NUM   = process.env.TWILIO_PHONE;
const VOICE     = 'Polly.Joanna';

const buildSystemPrompt = () => `
You are an AI phone receptionist for ${COMPANY}.
Greet callers, collect: first name, plumbing issue, urgency, callback number.
Keep responses to 1-2 sentences max — this is a phone call.
If flooding/burst pipe/gas = emergency.

Respond ONLY in this JSON format:
{
  "speak": "<what to say>",
  "collected": {
    "name": "<name or null>",
    "issue": "<issue or null>",
    "callbackPhone": "<phone or null>",
    "urgency": "<emergency|routine|null>"
  },
  "done": <true when you have name+issue+callbackPhone>
}`;

app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  conversations.set(callSid, {
    messages: [], callerPhone: req.body.From,
    collected: { name:null, issue:null, callbackPhone:req.body.From, urgency:null },
    turns: 0
  });
  const gather = twiml.gather({
    input: 'speech', action: '/voice/respond', method: 'POST',
    speechTimeout: 'auto', speechModel: 'phone_call', enhanced: true,
  });
  gather.say({ voice: VOICE }, `Thank you for calling ${COMPANY}! How can I help you today?`);
  twiml.redirect('/voice/no-input');
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/respond', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const convo = conversations.get(callSid);

  if (!convo) {
    twiml.say({ voice: VOICE }, 'Sorry, please call back.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  convo.turns++;
  if (convo.turns > 12 || !speech) {
    await saveLead(convo, callSid, 'done');
    twiml.say({ voice: VOICE }, `Thanks! Someone from ${COMPANY} will call you back shortly.`);
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  convo.messages.push({ role: 'user', content: speech });

  try {
    const aiResponse = await ai.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: buildSystemPrompt(),
      messages: convo.messages,
    });

    const raw = aiResponse.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    } catch {
      parsed = { speak: "Can you tell me your name and the issue?", collected: {}, done: false };
    }

    if (parsed.collected) {
      Object.entries(parsed.collected).forEach(([k, v]) => { if (v) convo.collected[k] = v; });
    }
    convo.messages.push({ role: 'assistant', content: raw });

    if (parsed.done) {
      await saveLead(convo, callSid, 'complete');
      twiml.say({ voice: VOICE }, parsed.speak);
      twiml.say({ voice: VOICE }, `Someone from ${COMPANY} will call you back very soon. Goodbye!`);
      twiml.hangup();
    } else {
      const gather = twiml.gather({
        input: 'speech', action: '/voice/respond', method: 'POST',
        speechTimeout: 'auto', speechModel: 'phone_call', enhanced: true,
      });
      gather.say({ voice: VOICE }, parsed.speak);
      twiml.redirect('/voice/no-input');
    }
  } catch (err) {
    await saveLead(convo, callSid, 'error');
    twiml.say({ voice: VOICE }, `Thanks for calling ${COMPANY}. We'll call you right back!`);
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/no-input', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: VOICE }, `Thanks for calling ${COMPANY}. Please call back anytime — we're here 24/7!`);
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

async function saveLead(convo, callSid, reason) {
  const lead = {
    id: `lead_${Date.now()}`, callSid,
    timestamp: new Date().toISOString(),
    callerPhone: convo.callerPhone,
    name: convo.collected.name || 'Unknown',
    issue: convo.collected.issue || 'Not specified',
    callbackPhone: convo.collected.callbackPhone || convo.callerPhone,
    urgency: convo.collected.urgency || 'routine',
  };
  leads.push(lead);
  conversations.delete(callSid);
  console.log(`NEW LEAD: ${lead.name} | ${lead.callbackPhone} | ${lead.issue}`);
  if (OWNER_NUM && BOT_NUM) {
    try {
      const emergency = lead.urgency === 'emergency';
      await twilioClient.messages.create({
        body: `${emergency ? '🚨 EMERGENCY' : '📋 New Lead'} — ${COMPANY}\n👤 ${lead.name}\n📞 ${lead.callbackPhone}\n🔧 ${lead.issue}`,
        from: BOT_NUM, to: OWNER_NUM,
      });
    } catch (e) { console.error('SMS error:', e.message); }
  }
}

app.get('/api/leads', (req, res) => res.json([...leads].reverse()));
app.get('/api/stats', (req, res) => res.json({
  totalLeads: leads.length,
  leadsToday: leads.filter(l => l.timestamp.startsWith(new Date().toISOString().split('T')[0])).length,
  activeCalls: conversations.size,
}));
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Velox AI running on port ${PORT}`));
