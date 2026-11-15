// WhatsApp / SMS notifications.
//
// Messages are written in the recipient's language and logged in the `notifications` table.
// Providers are chosen with environment variables (see README):
//   WHATSAPP_PROVIDER = meta | twilio      SMS_PROVIDER = twilio
// When no provider is configured, messages are only logged (status "not_sent").
const db = require('./db');
const { translator, formatMonth } = require('./i18n');

let fetchImpl = (...args) => fetch(...args);
const TIMEOUT_MS = 15000;

// Convert a typed phone number to international format (+9665xxxxxxxx).
// Saudi numbers written locally (05xxxxxxxx or 5xxxxxxxx) get the +966 country code.
function normalizePhone(raw) {
  let s = String(raw || '').replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^05\d{8}$/.test(s)) return '+966' + s.slice(1);
  if (/^5\d{8}$/.test(s)) return '+966' + s;
  if (/^966\d{9}$/.test(s)) return '+' + s;
  if (/^\+\d{8,15}$/.test(s)) return s;
  return null;
}

async function post(url, { headers, body }) {
  const res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

const providers = {
  // Twilio: SMS and WhatsApp (https://www.twilio.com/docs/messaging/api/message-resource)
  twilio: async ({ channel, to, body }) => {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const form = new URLSearchParams({ Body: body });
    if (channel === 'whatsapp') {
      form.set('To', 'whatsapp:' + to);
      form.set('From', 'whatsapp:' + process.env.TWILIO_WHATSAPP_FROM);
    } else {
      form.set('To', to);
      if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
      else form.set('From', process.env.TWILIO_SMS_FROM);
    }
    await post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  },

  // Meta WhatsApp Cloud API (https://developers.facebook.com/docs/whatsapp/cloud-api/messages)
  // WhatsApp only allows business-started messages through an approved template, so set
  // WHATSAPP_TEMPLATE to a template whose body is a single variable, e.g. "{{1}}".
  meta: async ({ to, body, lang }) => {
    const template = process.env.WHATSAPP_TEMPLATE;
    const message = template
      ? {
        type: 'template',
        template: {
          name: template,
          language: { code: process.env[`WHATSAPP_TEMPLATE_LANG_${lang.toUpperCase()}`] || process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: body }] }],
        },
      }
      : { type: 'text', text: { body } };
    await post(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v21.0'}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace('+', ''), ...message }),
    });
  },
};

function providerFor(channel) {
  const name = channel === 'whatsapp' ? process.env.WHATSAPP_PROVIDER : process.env.SMS_PROVIDER;
  return providers[name] ? name : null;
}

const insert = db.prepare('INSERT INTO notifications (user_id, channel, recipient, body, status, error) VALUES (?,?,?,?,?,?)');
const update = db.prepare('UPDATE notifications SET status = ?, error = ? WHERE id = ?');

// Send a message to a user. `key` is the English message text (translated to the user's
// language); `params` fill its {placeholders}; `link` is an optional site path.
// A param may be { tr: 'English text' } (translated too) or { month: '2026-11' } (shown as a month name).
// Returns a promise that never rejects; failures are recorded in the notifications table.
async function notifyUser(userId, key, params = {}, link = '') {
  try {
    const user = db.prepare('SELECT id, phone, lang, notify_channel FROM users WHERE id = ?').get(userId);
    if (!user || !['whatsapp', 'sms'].includes(user.notify_channel)) return;
    const t = translator(user.lang);
    params = Object.fromEntries(Object.entries(params).map(([k, v]) => [k,
      v && typeof v === 'object' ? (v.tr ? t(v.tr) : formatMonth(v.month, user.lang)) : v]));
    let body = t(key, params);
    if (params.note) body += '\n' + t('Note from company: {note}', { note: params.note });
    if (link && process.env.BASE_URL) body += '\n' + process.env.BASE_URL.replace(/\/$/, '') + link;

    const to = normalizePhone(user.phone);
    const provider = providerFor(user.notify_channel);
    const problem = !to ? 'Phone number is not in international format' : !provider ? `No ${user.notify_channel} provider configured` : null;
    const row = insert.run(user.id, user.notify_channel, to || String(user.phone || ''), body, problem ? 'not_sent' : 'pending', problem);
    if (problem) return;
    try {
      await providers[provider]({ channel: user.notify_channel, to, body, lang: user.lang });
      update.run('sent', null, row.lastInsertRowid);
    } catch (e) {
      update.run('failed', String(e.message).slice(0, 500), row.lastInsertRowid);
    }
  } catch (e) {
    console.error('Notification error:', e);
  }
}

module.exports = { notifyUser, normalizePhone, _setFetch: (fn) => { fetchImpl = fn; } };
