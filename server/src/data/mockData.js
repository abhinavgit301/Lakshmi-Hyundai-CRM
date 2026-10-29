export const demoUsers = [
  {
    id: 'user-admin',
    name: 'Asha Menon',
    email: 'admin@lakshmi.com',
    role: 'Admin',
    ccmId: null,
    status: 'active',
    team: 'Executive Office',
  },
  {
    id: 'user-gm',
    name: 'Rohan Iyer',
    email: 'gm@lakshmi.com',
    role: 'GM',
    ccmId: null,
    status: 'active',
    team: 'Operations',
  },
  {
    id: 'user-ccm-1',
    name: 'Naveen Kumar',
    email: 'ccm@lakshmi.com',
    role: 'CCM',
    ccmId: 'ccm-1',
    status: 'active',
    team: 'Service Care',
  },
  {
    id: 'user-cre-1',
    name: 'Priya S.',
    email: 'cre@lakshmi.com',
    role: 'CRE',
    ccmId: 'ccm-1',
    status: 'active',
    team: 'Customer Care',
  },
];

export const masterCallList = [
  {
    id: 'call-1001',
    customerName: 'Arun Nair',
    mobile: '9876543210',
    vin: '1HGBH41JXMN109186',
    registrationNumber: 'KA01AB1234',
    ccmId: 'ccm-1',
    assigneeId: 'user-cre-1',
    status: 'pending',
  },
  {
    id: 'call-1002',
    customerName: 'Meera Prasad',
    mobile: '9988776655',
    vin: '2T2BK1BA7KC123456',
    registrationNumber: 'KA05CD9876',
    ccmId: 'ccm-1',
    assigneeId: 'user-cre-1',
    status: 'callback',
  },
  {
    id: 'call-1003',
    customerName: 'Vivek Rao',
    mobile: '9123456789',
    vin: 'WBA3B1C52K7F32198',
    registrationNumber: 'KA22EF1357',
    ccmId: 'ccm-2',
    assigneeId: null,
    status: 'review',
  },
];

export const customers = [
  {
    id: 'customer-1',
    name: 'Arun Nair',
    phone: '9876543210',
    email: 'arun@example.com',
    ccmId: 'ccm-1',
  },
  {
    id: 'customer-2',
    name: 'Meera Prasad',
    phone: '9988776655',
    email: 'meera@example.com',
    ccmId: 'ccm-1',
  },
];

export const appointments = [
  {
    id: 'appt-1',
    customerName: 'Arun Nair',
    vehicle: 'Creta',
    date: '2026-10-15',
    slot: '10:30 AM',
    status: 'confirmed',
    ccmId: 'ccm-1',
    assigneeId: 'user-cre-1',
  },
  {
    id: 'appt-2',
    customerName: 'Meera Prasad',
    vehicle: 'Venue',
    date: '2026-10-15',
    slot: '2:00 PM',
    status: 'pending',
    ccmId: 'ccm-1',
    assigneeId: 'user-cre-1',
  },
];

export const importHistory = [
  {
    id: 'import-1',
    fileName: 'monthly_repair_orders_oct.csv',
    createdBy: 'Naveen Kumar',
    recordsProcessed: 240,
    created: 118,
    appended: 22,
    skipped: 8,
    rejected: 3,
    flagged: 4,
    createdAt: '2026-10-01T09:15:00Z',
  },
];

export const dashboardSummary = {
  totalCustomers: 382,
  activeVehicles: 549,
  todaysCalls: 86,
  appointmentCount: 41,
  conversionRate: 28.4,
  pendingFollowUps: 19,
};
