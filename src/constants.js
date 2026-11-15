const CATEGORIES = [
  'General Labour / Helper', 'Construction Worker', 'Mason', 'Carpenter', 'Steel Fixer',
  'Scaffolder', 'Electrician', 'Plumber', 'Welder', 'Painter', 'AC Technician', 'Mechanic',
  'Light Driver', 'Heavy Driver', 'Heavy Equipment Operator', 'Cleaner', 'Security Guard',
  'Cook', 'Waiter / Restaurant Staff', 'Warehouse / Loader', 'Farm Worker', 'Other',
];

const DOC_TYPES = {
  iqama: 'Iqama (Residence ID)',
  passport: 'Passport',
  photo: 'Photograph',
  cv: 'CV / Resume',
  driving_license: 'Driving License',
  medical: 'Medical Certificate',
  experience: 'Experience Certificate',
  trade_certificate: 'Trade / Skill Certificate',
  other: 'Other Document',
};

const CITIES = [
  'Riyadh', 'Jeddah', 'Makkah', 'Madinah', 'Dammam', 'Khobar', 'Jubail', 'Dhahran', 'Taif',
  'Tabuk', 'Abha', 'Khamis Mushait', 'Buraidah', 'Hail', 'Jazan', 'Najran', 'Yanbu', 'Al Ahsa',
  'NEOM', 'Other',
];

const SALARY_TYPES = { hourly: 'per hour', daily: 'per day', monthly: 'per month' };

const APP_STATUS = {
  applied: 'Applied',
  shortlisted: 'Shortlisted',
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

const NATIONALITIES = [
  'Bangladesh', 'India', 'Pakistan', 'Nepal', 'Philippines', 'Sri Lanka', 'Egypt', 'Sudan', 'Yemen',
  'Indonesia', 'Kenya', 'Uganda', 'Ethiopia',
];

// Can the worker's Iqama sponsorship (kafala) be transferred to a new employer?
const KAFALA_OPTIONS = {
  yes: 'Transferable',
  no: 'Not transferable',
  new_visa: 'Outside Saudi Arabia (new visa needed)',
};

const DRIVING_OPTIONS = {
  none: 'No Saudi license',
  light: 'Light vehicle',
  heavy: 'Heavy vehicle',
};

const NOTIFY_CHANNELS = { whatsapp: 'WhatsApp', sms: 'SMS', none: 'No messages' };

const FIELD_TYPES = { text: 'Text', number: 'Number', date: 'Date', yesno: 'Yes / No', select: 'Choice list' };

const TIMESHEET_STATUS = { submitted: 'Waiting for admin check', confirmed: 'Confirmed', rejected: 'Needs correction' };
const PAYMENT_METHODS = { bank: 'Bank transfer', cash: 'Cash' };
const PAYMENT_STATUS = { pending: 'Payment pending', paid: 'Paid' };
const REVIEW_STATUS = { pending: 'Waiting for admin review', published: 'Published', rejected: 'Needs changes' };

module.exports = {
  CATEGORIES, DOC_TYPES, CITIES, SALARY_TYPES, APP_STATUS, NATIONALITIES,
  KAFALA_OPTIONS, DRIVING_OPTIONS, NOTIFY_CHANNELS, FIELD_TYPES,
  TIMESHEET_STATUS, PAYMENT_METHODS, PAYMENT_STATUS, REVIEW_STATUS,
};
