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

module.exports = { CATEGORIES, DOC_TYPES, CITIES, SALARY_TYPES, APP_STATUS, NATIONALITIES };
