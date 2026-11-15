# ManpowerHub KSA — Digital Manpower Supply Portal

সৌদি আরবের কোম্পানিগুলো অনলাইনে ম্যানপাওয়ার ডিমান্ড দেবে, কর্মীরা ওয়েবসাইটে ডিমান্ড দেখে ডকুমেন্টসহ অ্যাপ্লাই করবে, আর কোম্পানি অনলাইনেই যাচাই করে হায়ার করবে। কাগজের ডিমান্ড লেটার বা সাপ্লায়ারের কাছে ঘোরাঘুরির দরকার নেই।

Companies in Saudi Arabia post manpower demands online, workers browse them and apply with their documents, and companies review and hire — fully digital.

## Features

**Company (কোম্পানি)**
- Register once: company name, CR number, contact person, city
- Post demands: category, number of workers, rate in SAR (hourly / daily / monthly), hours per day, days per week, overtime, duration, city and site, food / accommodation / transport, start date, last date to apply, required documents
- Auto-generated printable **demand letter** for each demand (print or save as PDF)
- Applicant list per demand with filters (New / Shortlisted / Hired / Rejected)
- View each applicant's profile and documents, then Shortlist / Hire / Reject, with a note to the worker
- Tracks hired vs. needed (cannot hire more than the demand quantity); close or re-open a demand

**Worker (কর্মী)**
- Register: name, nationality, Iqama number, passport number, profession, experience, skills
- Upload documents once (Iqama, Passport, Photo, CV, license, medical, certificates) and reuse them for every application
- Browse and search demands by keyword, category and city
- Apply; any missing required document can be uploaded on the apply form
- Dashboard with application status (Applied → Shortlisted → Hired), company notes, withdraw option and recommended jobs

**Admin**
- Verify (approve / reject) companies. Demands become public only after the company is approved.
- Overview of companies, demands, workers and their documents

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

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database location |
| `UPLOAD_DIR` | `./uploads` | Uploaded documents |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@manpower.local` / `admin123` | First admin account |
| `COOKIE_SECURE` | unset | Set to `1` when served over HTTPS |
| `NODE_ENV` | unset | Set to `production` to cache templates |

Back up `DATA_DIR` and `UPLOAD_DIR`; they hold all the data.

## Project layout

```
src/server.js        routes: public pages, auth, company, worker, admin, documents
src/db.js            SQLite schema and the first admin account
src/constants.js     job categories, document types, cities
src/i18n.js          language list and translation lookup
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
- SMS / WhatsApp / email notifications when the status changes
- Mobile app for workers
- Payments: company subscription or per-hire fee
- Attendance and timesheets for hired workers, invoicing to companies
- Worker ratings after a job finishes
