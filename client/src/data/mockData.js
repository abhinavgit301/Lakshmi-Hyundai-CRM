export const dashboardStats = [
  { label: 'Total customers', value: '3,482', change: '+8.2%' },
  { label: 'Active vehicles', value: '5,149', change: '+4.7%' },
  { label: 'Calls today', value: '86', change: '+12.1%' },
  { label: 'Appointments', value: '41', change: '+6.5%' },
];

export const callRows = [
  { name: 'Arun Nair', vin: '1HGBH41JXMN109186', mobile: '9876543210', status: 'Pending', ccm: 'CCM-01' },
  { name: 'Meera Prasad', vin: '2T2BK1BA7KC123456', mobile: '9988776655', status: 'Callback', ccm: 'CCM-01' },
  { name: 'Vivek Rao', vin: 'WBA3B1C52K7F32198', mobile: '9123456789', status: 'Review', ccm: 'CCM-02' },
];

export const appointmentRows = [
  { customer: 'Arun Nair', vehicle: 'Creta', time: '10:30 AM', status: 'Confirmed' },
  { customer: 'Meera Prasad', vehicle: 'Venue', time: '2:00 PM', status: 'Pending' },
  { customer: 'Ravindra Singh', vehicle: 'Verna', time: '4:15 PM', status: 'Rescheduled' },
];

export const workflowRows = [
  { name: 'Repair order import', value: '184 rows', tone: 'blue' },
  { name: 'VIN conflict review', value: '4 flagged', tone: 'amber' },
  { name: 'CRE assignments', value: '19 open', tone: 'green' },
  { name: 'Follow-up backlog', value: '11 due', tone: 'slate' },
];
