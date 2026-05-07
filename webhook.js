const express    = require('express');
const { Pool }   = require('pg');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hello@nodeclear.ai';

// ── Postgres ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agency_leads (
      id         SERIAL PRIMARY KEY,
      timestamp  TIMESTAMPTZ DEFAULT NOW(),
      email      TEXT NOT NULL,
      source     TEXT,
      ip         TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiz_purchases (
      id          SERIAL PRIMARY KEY,
      timestamp   TIMESTAMPTZ DEFAULT NOW(),
      name        TEXT,
      email       TEXT NOT NULL,
      company     TEXT,
      tier        TEXT,
      score       INTEGER,
      max_score   INTEGER,
      tier_label  TEXT,
      answered    INTEGER,
      flags       TEXT[],
      answers     JSONB,
      ip          TEXT
    );
  `);
  console.log('Database tables ready.');
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Email ──────────────────────────────────────────────────────────────────
function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function notifyAgency(email) {
  try {
    await makeTransport().sendMail({
      from: process.env.SMTP_USER,
      to: NOTIFY_EMAIL,
      subject: 'NodeClear: New agency whitelist signup — ' + email,
      text: `New agency interest:\n\nEmail: ${email}\nTime: ${new Date().toLocaleString('en-GB')}\n\nView leads:\nhttps://nodeclear-webhook-production.up.railway.app/api/leads?token=YOUR_ADMIN_TOKEN`,
    });
  } catch (err) {
    console.warn('Agency email failed (non-fatal):', err.message);
  }
}

async function notifyQuizPurchase(data) {
  try {
    const { contact, tier, risk, answers } = data;
    const flagLines   = (risk?.flags || []).map(f => `  • ${f}`).join('\n') || '  None';
    const answerLines = (answers || []).map((a, i) =>
      `  Q${i+1} [${a.answer === true ? 'YES' : a.answer === false ? 'NO' : '—'}] ${a.flagged ? '⚠' : ' '} ${a.question}`
    ).join('\n');

    await makeTransport().sendMail({
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
${flagLines}

ALL ANSWERS:
${answerLines}

View all quiz purchases:
https://nodeclear-webhook-production.up.railway.app/api/quiz-leads?token=YOUR_ADMIN_TOKEN
      `.trim(),
    });
  } catch (err) {
    console.warn('Quiz purchase email failed (non-fatal):', err.message);
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'NodeClear Webhook' });
});

// Agency whitelist interest
app.post('/api/agency-interest', async (req, res) => {
  const { email, source } = req.body;
  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ ok: false, error: 'Invalid email address' });
  }
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  try {
    await pool.query(
      'INSERT INTO agency_leads (email, source, ip) VALUES ($1, $2, $3)',
      [email, source || 'landing-page', ip]
    );
    console.log(`[${new Date().toISOString()}] Agency lead: ${email}`);
    notifyAgency(email);
    res.json({ ok: true, message: 'Registered. We will be in touch when white-label launches.' });
  } catch (err) {
    console.error('Agency lead error:', err);
    res.status(500).json({ ok: false, error: 'Failed to register — please try again.' });
  }
});

// Pre-purchase quiz profile capture
app.post('/api/quiz-purchase', async (req, res) => {
  const { contact, tier, risk, answers } = req.body;
  if (!contact?.email || !contact.email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Invalid contact email' });
  }
  if (!tier || !['starter', 'standard'].includes(tier)) {
    return res.status(400).json({ ok: false, error: 'Invalid tier' });
  }
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  try {
    await pool.query(
      `INSERT INTO quiz_purchases
         (name, email, company, tier, score, max_score, tier_label, answered, flags, answers, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        contact.name,
        contact.email,
        contact.company || null,
        tier,
        risk?.score ?? null,
        risk?.max ?? null,
        risk?.tier_label || null,
        risk?.answered ?? null,
        risk?.flags || [],
        JSON.stringify(answers || []),
        ip,
      ]
    );
    console.log(`[${new Date().toISOString()}] Quiz purchase: ${contact.email} — ${tier} — ${risk?.tier_label} (${risk?.score}/${risk?.max})`);
    notifyQuizPurchase(req.body);
    res.json({ ok: true, message: 'Risk profile captured.' });
  } catch (err) {
    console.error('Quiz purchase error:', err);
    res.status(500).json({ ok: false, error: 'Failed to capture — proceeding to payment.' });
  }
});

// Admin: view agency leads
app.get('/api/leads', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorised' });
  }
  try {
    const result = await pool.query('SELECT * FROM agency_leads ORDER BY timestamp DESC');
    res.json({ ok: true, count: result.rows.length, leads: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin: view quiz purchase profiles
app.get('/api/quiz-leads', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorised' });
  }
  try {
    const result = await pool.query('SELECT * FROM quiz_purchases ORDER BY timestamp DESC');
    res.json({ ok: true, count: result.rows.length, purchases: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`NodeClear webhook running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});
 
     
