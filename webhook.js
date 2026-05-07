const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_FILE = path.join(__dirname, 'agency_leads.csv');
const QUIZ_LOG_FILE = path.join(__dirname, 'quiz_purchases.csv');
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hello@nodeclear.ai';

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Agency leads CSV ──────────────────────────────────────────────────────
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'timestamp,email,source,ip\n');
}

// ── Quiz purchases CSV ────────────────────────────────────────────────────
if (!fs.existsSync(QUIZ_LOG_FILE)) {
  fs.writeFileSync(QUIZ_LOG_FILE, 'timestamp,name,email,company,tier,score,max,tier_label,answered,flags,ip\n');
}

function appendLead(email, source, ip) {
  const ts = new Date().toISOString();
  const safe = email.replace(/,/g, '').replace(/"/g, '');
  const row = `"${ts}","${safe}","${source || 'landing-page'}","${ip || ''}"\n`;
  fs.appendFileSync(LOG_FILE, row);
}

function appendQuizPurchase(data, ip) {
  const ts = new Date().toISOString();
  const safe = (v) => String(v || '').replace(/"/g, '').replace(/\n/g, ' ');
  const flags = (data.risk?.flags || []).join(' | ');
  const row = [
    ts,
    safe(data.contact?.name),
    safe(data.contact?.email),
    safe(data.contact?.company),
    safe(data.tier),
    safe(data.risk?.score),
    safe(data.risk?.max),
    safe(data.risk?.tier_label),
    safe(data.risk?.answered),
    safe(flags),
    safe(ip),
  ].map(v => `"${v}"`).join(',') + '\n';
  fs.appendFileSync(QUIZ_LOG_FILE, row);
}

async function notifyOwner(email) {
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: NOTIFY_EMAIL,
      subject: 'NodeClear: New agency whitelist signup — ' + email,
      text: `New agency interest:\n\nEmail: ${email}\nTime: ${new Date().toLocaleString('en-GB')}\n\nCheck your leads at:\nhttps://nodeclear-webhook-production.up.railway.app/api/leads?token=YOUR_ADMIN_TOKEN`,
    });
  } catch (err) {
    console.warn('Email notification failed (non-fatal):', err.message);
  }
}

async function notifyQuizPurchase(data) {
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const { contact, tier, risk, answers } = data;
    const flagLines = (risk?.flags || []).map(f => `  • ${f}`).join('\n');
    const answerLines = (answers || []).map((a, i) =>
      `  Q${i + 1} [${a.answer === true ? 'YES' : a.answer === false ? 'NO' : '—'}] ${a.flagged ? '⚠' : ' '} ${a.question}`
    ).join('\n');

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: NOTIFY_EMAIL,
      subject: `NodeClear: New ${tier} purchase — ${contact?.email} — ${risk?.tier_label} risk (${risk?.score}/${risk?.max})`,
      text: `
NEW PRE-PURCHASE RISK PROFILE
─────────────────────────────
Name:    ${contact?.name}
Email:   ${contact?.email}
Company: ${contact?.company || '—'}
Tier:    ${tier}
Time:    ${new Date().toLocaleString('en-GB')}

RISK SCORE: ${risk?.score} / ${risk?.max} — ${risk?.tier_label}
Questions answered: ${risk?.answered} / 12

FLAGGED EXPOSURES:
${flagLines || '  None'}

ALL ANSWERS:
${answerLines}

View all quiz purchases:
https://nodeclear-webhook-production.up.railway.app/api/quiz-leads?token=YOUR_ADMIN_TOKEN
`.trim(),
    });
  } catch (err) {
    console.warn('Quiz purchase email notification failed (non-fatal):', err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'NodeClear Webhook' });
});

// Existing: agency whitelist interest
app.post('/api/agency-interest', async (req, res) => {
  const { email, source } = req.body;
  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ ok: false, error: 'Invalid email address' });
  }
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  try {
    appendLead(email, source, ip);
    console.log(`[${new Date().toISOString()}] Agency lead: ${email}`);
    notifyOwner(email);
    res.json({ ok: true, message: 'Registered. We will be in touch when white-label launches.' });
  } catch (err) {
    console.error('Lead capture error:', err);
    res.status(500).json({ ok: false, error: 'Failed to register — please try again.' });
  }
});

// New: pre-purchase quiz profile capture
app.post('/api/quiz-purchase', async (req, res) => {
  const { contact, tier, risk, answers, timestamp } = req.body;

  if (!contact?.email || !contact.email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Invalid contact email' });
  }
  if (!tier || !['starter', 'standard'].includes(tier)) {
    return res.status(400).json({ ok: false, error: 'Invalid tier' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  try {
    appendQuizPurchase(req.body, ip);
    console.log(`[${new Date().toISOString()}] Quiz purchase: ${contact.email} — ${tier} — ${risk?.tier_label} (${risk?.score}/${risk?.max})`);
    notifyQuizPurchase(req.body);
    res.json({ ok: true, message: 'Risk profile captured.' });
  } catch (err) {
    console.error('Quiz purchase capture error:', err);
    res.status(500).json({ ok: false, error: 'Failed to capture — proceeding to payment.' });
  }
});

// Existing: view agency leads (admin)
app.get('/api/leads', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorised' });
  }
  if (!fs.existsSync(LOG_FILE)) return res.json({ ok: true, leads: [] });
  const raw = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  const leads = lines.filter(l => l.trim()).map(line => {
    const parts = line.split('","');
    return {
      timestamp: parts[0]?.replace('"', ''),
      email: parts[1],
      source: parts[2],
      ip: parts[3]?.replace('"', ''),
    };
  });
  res.json({ ok: true, count: leads.length, leads });
});

// New: view quiz purchase profiles (admin)
app.get('/api/quiz-leads', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorised' });
  }
  if (!fs.existsSync(QUIZ_LOG_FILE)) return res.json({ ok: true, purchases: [] });
  const raw = fs.readFileSync(QUIZ_LOG_FILE, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  const purchases = lines.filter(l => l.trim()).map(line => {
    const parts = line.split('","');
    return {
      timestamp:  parts[0]?.replace('"', ''),
      name:       parts[1],
      email:      parts[2],
      company:    parts[3],
      tier:       parts[4],
      score:      parts[5],
      max:        parts[6],
      tier_label: parts[7],
      answered:   parts[8],
      flags:      parts[9],
      ip:         parts[10]?.replace('"', ''),
    };
  });
  res.json({ ok: true, count: purchases.length, purchases });
});

app.listen(PORT, () => {
  console.log(`NodeClear webhook running on port ${PORT}`);
  console.log(`Agency leads: ${LOG_FILE}`);
  console.log(`Quiz purchases: ${QUIZ_LOG_FILE}`);
});
