# ManpowerHub KSA — Digital Manpower Supply Portal

সৌদি আরবের কোম্পানিগুলো অনলাইনে ম্যানপাওয়ার ডিমান্ড দেবে, কর্মীরা ওয়েবসাইটে ডিমান্ড দেখে ডকুমেন্টসহ অ্যাপ্লাই করবে, আর কোম্পানি অনলাইনেই যাচাই করে হায়ার করবে। কাগজের ডিমান্ড লেটার বা সাপ্লায়ারের কাছে ঘোরাঘুরির দরকার নেই।

Companies in Saudi Arabia post manpower demands online, workers browse them and apply with their documents, and companies review and hire — fully digital.

## Features

**Company (কোম্পানি)**
- Register once: company name, CR number, contact person, city, and an optional company logo (shown on its demands and demand letters)
- Post demands: category, number of workers, rate in SAR (hourly / daily / monthly), hours per day, days per week, overtime, duration, city and site, food / accommodation / transport, start date, last date to apply, required documents
- Auto-generated printable **demand letter** for each demand (print or save as PDF)
- Applicant list per demand with filters (New / Shortlisted / Hired / Rejected)
- View each applicant's profile and documents, then Shortlist / Hire / Reject, with a note to the worker
- Tracks hired vs. needed (cannot hire more than the demand quantity); close or re-open a demand

**Worker (কর্মী)**
- Register: name, nationality, Iqama number, passport number, main profession plus any other positions they can work in, experience, skills
- Optional extra details in the profile: Iqama and passport expiry, sponsorship (kafala) transfer, Saudi driving license, languages, expected salary, available-from date, work history — companies see these when the worker applies
- Upload documents once (Iqama, Passport, Photo, CV, license, medical, certificates) and reuse them for every application
- Browse and search demands by keyword, category and city
- Apply; any missing required document can be uploaded on the apply form
- Dashboard with application status (Applied → Shortlisted → Hired), company notes, withdraw option and recommended jobs

**Admin**
- Verify (approve / reject) companies. Demands become public only after the company is approved.
- Overview of companies, demands, workers and their documents
- **Worker profile fields**: add any extra question for workers (text, number, date, yes/no or a choice list; optional or required). It appears in the worker registration form and profile, and companies see the answers. Fields can be hidden or deleted later.
- Log of every WhatsApp / SMS message and whether it was sent

**Timesheets & payments (হাজিরা ও পেমেন্ট)**
1. At month end the company uploads the timesheet file (PDF, Excel `.xlsx`/`.xls` or CSV) for a demand and enters, for each hired worker, days worked, hours and the amount in SAR (calculated from the rate, editable), plus the payment method: bank transfer or cash.
2. The admin opens the file, compares it with the numbers and either confirms it or sends it back with a note. The company corrects and resubmits (the file can be kept or replaced).
3. On confirmation each worker gets a WhatsApp / SMS: month, days, hours, amount, payment method and payment status. The company is told too.
4. When the worker is paid, the company (or admin) marks it paid with the date, an optional reference and an optional receipt. The worker gets another message.
5. Workers see all their months on the **Payments** page and can print a **payment slip** (with IBAN for bank payments) and open the receipt. Other workers and other companies cannot see them.

**WhatsApp / SMS notifications**
- Worker: when shortlisted, hired (with the company's note) or not selected
- Worker: **new job alerts** — when a company posts a demand, every worker with that position (main or extra) gets a message with the job, company, city, pay and a link. Demands from a company that is not approved yet are announced when the admin approves it; each demand is announced once. Workers can switch job alerts off in their profile.
- Company: when a worker applies, when the admin approves the company, and when a timesheet is confirmed or sent back
- Worker: when a timesheet is confirmed (hours, amount, payment status) and when the payment is made
- Messages are written in each person's chosen language. Everyone can choose WhatsApp, SMS or no messages in their profile.

**Languages (ভাষা)**
- English is the main language. A menu in the top bar switches to বাংলা (Bangla), हिन्दी (Hindi), اردو (Urdu), नेपाली (Nepali), සිංහල (Sinhala, Sri Lanka), العربية (Arabic) or Filipino. The choice is remembered.
- Arabic and Urdu are shown right-to-left.
- Job categories, document names, cities, messages and the printable demand letter are all translated. Text that companies and workers type themselves (job titles, requirements, names) is shown as typed.

**Security**
- Passwords hashed with scrypt; sessions stored server-side in an HttpOnly cookie
- CSRF protection on every form
- Uploaded files are checked by their real content (PDF / JPG / PNG / WEBP only, max 5 MB) and stored with random names
- A worker's documents are visible only to the worker, the admin, and companies the worker has applied to

## Run it

Requires **Node.js 22.13 or newer**. There are no npm dependencies: it uses Node's built-in SQLite, so `npm install` is not needed.

```bash
npm start            # http://localhost:3000
npm run seed         # optional: demo companies, demands and a worker (password: demo123)
npm test             # end-to-end test of the whole flow
```

On first start an admin account is created: `admin@manpower.local` / `admin123`.
**Set `ADMIN_PASSWORD` (and optionally `ADMIN_EMAIL`) before the first production start.**

### Setting up WhatsApp / SMS

Without these settings the site works normally, and messages are only listed in the admin panel as "Not sent".
Saudi numbers typed as `05xxxxxxxx` are converted to `+9665xxxxxxxx` automatically.

**WhatsApp through Meta (WhatsApp Cloud API)** — set `WHATSAPP_PROVIDER=meta`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
WhatsApp only lets a business start a conversation with an approved *message template*. Create a template
in WhatsApp Manager whose body is one variable, for example `{{1}}`, and set `WHATSAPP_TEMPLATE` to its name.
Set `WHATSAPP_TEMPLATE_LANG` to the template's language code (default `en`); if you create the template in more
languages, set e.g. `WHATSAPP_TEMPLATE_LANG_BN=bn`, `WHATSAPP_TEMPLATE_LANG_AR=ar`.

**WhatsApp or SMS through Twilio** — set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, then
`WHATSAPP_PROVIDER=twilio` with `TWILIO_WHATSAPP_FROM`, and/or `SMS_PROVIDER=twilio` with `TWILIO_SMS_FROM`
(or `TWILIO_MESSAGING_SERVICE_SID`). SMS to Saudi numbers needs a registered sender name.

Set `BASE_URL` (e.g. `https://yoursite.com`) to add a link to the site at the end of each message.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database location |
| `UPLOAD_DIR` | `./uploads` | Uploaded documents |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@manpower.local` / `admin123` | First admin account |
| `COOKIE_SECURE` | unset | Set to `1` when served over HTTPS |
| `NODE_ENV` | unset | Set to `production` to cache templates |
| `BASE_URL` | unset | Site address, used for links in WhatsApp / SMS messages |
| `WHATSAPP_PROVIDER`, `SMS_PROVIDER` | unset | `meta` / `twilio` — see above |

Back up `DATA_DIR` and `UPLOAD_DIR`; they hold all the data.

## Project layout

```
src/server.js        routes: public pages, auth, company, worker, admin, documents
src/db.js            SQLite schema and the first admin account
src/constants.js     job categories, document types, cities
src/i18n.js          language list and translation lookup
src/notify.js        WhatsApp / SMS messages (Meta, Twilio)
src/timesheets.js    monthly timesheets, admin check, payments, payment slips
src/jobAlerts.js     worker positions and new-job alerts
src/locales/*.json   translations (English text → translated text)
src/lib/web.js       small built-in web framework (routing, sessions, uploads)
src/lib/template.js  EJS-style templates
views/               pages (company/, worker/, admin/, partials/)
public/style.css     design (light and dark mode, mobile friendly)
scripts/seed.js      demo data
scripts/i18n-keys.js lists texts missing from any language file
test/e2e.test.js     end-to-end tests
```

## Editing translations

Each file in `src/locales/` maps the English text to the translation, for example in `bn.json`:
`"Job Demands": "কাজের ডিমান্ড"`. Keep placeholders such as `{n}` or `{name}` unchanged.
After changing English text in a page, run `node scripts/i18n-keys.js` to see which translations are missing;
`npm test` fails until every language has them. To add a language, add it to `LANGUAGES` in `src/i18n.js`
and create `src/locales/<code>.json`.

## Possible next steps

- Have native speakers review the translations
- Tamil for Sri Lankan Tamil-speaking workers
- Mobile app for workers
- Payments: company subscription or per-hire fee
- Attendance and timesheets for hired workers, invoicing to companies
- Worker ratings after a job finishes
