/**
 * NodeClear — Agency Interest Capture Webhook
 *
 * A minimal Node.js/Express server that:
 * 1. Receives agency email submissions from the landing page
 * 2. Appends them to a local CSV log (zero-dependency storage)
 * 3. Sends a notification email to you via nodemailer (optional)
 * 4. Returns CORS-safe JSON responses
 *
 * Deploy on: Railway, Render, Fly.io (all free tier)
 * Or run locally: node webhook.js
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_FILE = path.join(__dirname, 'agency_leads.csv');
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hello@nodeclear.ai';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── CSV log init ──────────────────────────────────────────────────────────────
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'timestamp,email,source,ip\n');
}

function appendLead(email, source, ip) {
  const ts = new Date().toISOString();
  const safe = email.replace(/,/g, '').replace(/"/g, '');
  const row = `"${ts}","${safe}","${source || 'landing-page'}","${ip || ''}"\n`;
  fs.appendFileSync(LOG_FILE, row);
}

// ── Optional: email notification via nodemailer ───────────────────────────────
async function notifyOwner(email) {
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: NOTIFY_EMAIL,
      subject: 'NodeClear: New agency whitelist signup',
      text: `New agency interest registered:\n\nEmail: ${email}\nTime: ${new Date().toLocaleString('en-GB')}\n\nLog file updated on server.`,
    });
  } catch (err) {
    console.warn('Email notification failed (non-fatal):', err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'NodeClear Agency Interest Capture' });
});

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
    res.json({
      ok: true,
      message: 'Registered. We will be in touch when white-label launches.',
    });
  } catch (err) {
    console.error('Lead capture error:', err);
    res.status(500).json({ ok: false, error: 'Failed to register — please try again.' });
  }
});

app.get('/api/leads', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorised' });
  }
  if (!fs.existsSync(LOG_FILE)) {
    return res.json({ ok: true, leads: [] });
  }
  const raw = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  const leads = lines.map(line => {
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

app.listen(PORT, () => {
  console.log(`NodeClear webhook running on port ${PORT}`);
  console.log(`Leads logged to: ${LOG_FILE}`);
});
