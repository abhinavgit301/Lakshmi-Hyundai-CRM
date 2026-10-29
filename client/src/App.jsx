import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { Activity, ArrowLeft, BarChart3, CalendarCheck, CalendarClock, CalendarDays, CalendarPlus2, ChevronDown, ClipboardList, Clock3, Download, FileUp, Gift, LayoutDashboard, ListFilter, LogOut, PhoneCall, Plus, Save, ShieldCheck, Trash2, Upload, UserCog, UserRoundPlus, UsersRound, X } from 'lucide-react';
import api from './lib/api.js';
import { getMasterRepairTypePresentation, MASTER_REPAIR_TYPE_ORDER } from './utils/repairTypes.js';

const WorkshopServicePerformance = lazy(() => import('./components/WorkshopServicePerformance.jsx'));

const navItems = ['Dashboard', 'Customers', 'Follow-ups', 'Appointments', 'Allocations', 'Imports', 'Reports'];
const routeByView = {
  Dashboard: '/dashboard',
  Customers: '/customers',
  Appointments: '/appointments',
  Allocations: '/allocations',
  Imports: '/imports',
  Reports: '/reports',
  'Master list': '/master-call-list',
  Performance: '/performance',
  'Performance Board': '/performance-board',
  'Workshop Performance': '/workshop-performance',
  'User Management': '/user-management',
  'Due 1-Year': '/customers/due-1-year',
  'Due 6-Month': '/customers/due-6-month',
  'Free Service': '/customers/free-service',
  Warranty: '/customers/warranty',
  'Follow-up Service': '/follow-ups/service',
  'Follow-up Free Service': '/follow-ups/free-service',
  'Follow-up Warranty': '/follow-ups/warranty',
  'Free-Service Import': '/free-service/import',
  'Free-Service Customer · 2 Months': '/free-service/customers/2-months',
  'Free-Service Customer · 1 Year': '/free-service/customers/1-year',
  'Free-Service Customer · 2 Years': '/free-service/customers/2-years',
  'Free-Service Follow-up · 2 Months': '/free-service/follow-ups/2-months',
  'Free-Service Follow-up · 1 Year': '/free-service/follow-ups/1-year',
  'Free-Service Follow-up · 2 Years': '/free-service/follow-ups/2-years',
};
const viewByRoute = Object.fromEntries(Object.entries(routeByView).map(([view, path]) => [path, view]));

function resolveRoute(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  const monthlyDataMatch = path.match(/^\/monthly-data(?:\/([^/]+))?$/);
  if (monthlyDataMatch) {
    let ccmId = monthlyDataMatch[1] || '';
    try {
      ccmId = decodeURIComponent(ccmId);
    } catch {
      ccmId = '';
    }
    return { view: 'CcmProfile', ccmId };
  }
  return { view: viewByRoute[path] || 'Dashboard', ccmId: '' };
}

function pathForView(view, ccmId = '') {
  if (view === 'CcmProfile') return ccmId ? `/monthly-data/${encodeURIComponent(ccmId)}` : '/monthly-data';
  return routeByView[view] || routeByView.Dashboard;
}

function canAccessRoute(view, role, user, ccmId = '') {
  const teamRoles = ['CCM', 'CRE'];
  const commonRoutes = ['Dashboard'];
  if (commonRoutes.includes(view)) return true;
  if (view === 'Master list') return teamRoles.includes(role);
  if (view === 'Customers') return teamRoles.includes(role);
  if (view === 'Appointments') return ['CCM', 'CRE', 'FREE_SERVICE_CRE'].includes(role);
  if (view === 'Allocations') return ['ADMIN', 'CCM'].includes(role);
  if (view === 'Imports') return ['ADMIN', 'GM', 'CCM'].includes(role);
  if (view === 'Reports') return ['ADMIN', 'GM'].includes(role);
  if (view === 'Workshop Performance') return ['ADMIN', 'GM', 'CCM'].includes(role);
  if (view === 'Performance') return ['CCM', 'CRE', 'FREE_SERVICE_CRE'].includes(role);
  if (view === 'Performance Board') return role === 'CCM';
  if (view === 'User Management') return role === 'ADMIN';
  if (view in dueViews) {
    if (!teamRoles.includes(role)) return false;
    if (role !== 'CRE') return true;
    if (view === 'Free Service') return user?.freeServiceEnabled === true;
    if (view === 'Warranty') return user?.warrantyEnabled === true;
    return true;
  }
  if (view in followUpViews) {
    if (!teamRoles.includes(role)) return false;
    if (role !== 'CRE') return true;
    if (view === 'Follow-up Free Service') return user?.freeServiceEnabled === true;
    if (view === 'Follow-up Warranty') return user?.warrantyEnabled === true;
    return true;
  }
  if (view === 'Free-Service Import' || view.startsWith('Free-Service Customer ·') || view.startsWith('Free-Service Follow-up ·')) {
    return role === 'FREE_SERVICE_CRE';
  }
  if (view === 'CcmProfile') {
    return Boolean(ccmId) && (role === 'ADMIN' || role === 'GM' || (role === 'CCM' && ccmId === user?.ccmId));
  }
  return false;
}

const navIcons = {
  Dashboard: LayoutDashboard,
  Import: Upload,
  Customer: UsersRound,
  'Follow-up': Clock3,
  'Master list': ListFilter,
  Customers: UsersRound,
  'Follow-ups': Clock3,
  Appointments: CalendarDays,
  Allocations: ClipboardList,
  Imports: Upload,
  Reports: BarChart3,
  Performance: Activity,
  'Workshop Performance': Activity,
  'User Management': UserCog,
  'Monthly Data': ClipboardList,
};

// Customer lists under the Customers accordion. `kind` selects the data source; `callSource` tags the calls and follow-ups made from it.
const dueViews = {
  'Due 1-Year': { kind: 'due', window: '1y', label: '1-Year Due', icon: CalendarClock, callSource: 'SERVICE' },
  'Due 6-Month': { kind: 'due', window: '6m', label: '6-Month Due', icon: Clock3, callSource: 'SERVICE' },
  'Free Service': { kind: 'free', label: 'Free Service', icon: Gift, callSource: 'FREE_SERVICE' },
  Warranty: { kind: 'warranty', label: 'Warranty', icon: ShieldCheck, callSource: 'WARRANTY' },
};

// Follow-up queues under the Follow-ups accordion; each shows only follow-ups created from its own list.
const followUpViews = {
  'Follow-up Service': { source: 'SERVICE', label: 'Service', icon: Clock3 },
  'Follow-up Free Service': { source: 'FREE_SERVICE', label: 'Free Service', icon: Gift },
  'Follow-up Warranty': { source: 'WARRANTY', label: 'Warranty', icon: ShieldCheck },
};

const dailyTargetLabels = { callsMade: 'Calls made', callsPickedUp: 'Calls picked up' };

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

function formatOutcome(outcome) {
  return outcome ? outcome.replaceAll('_', ' ').toLowerCase() : '';
}

const monthOptions = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const masterCsvFields = [
  ['serialNo', 'S NO', 'text'],
  ['roNumber', 'Repair Order No', 'text'],
  ['visitDate', 'R/O Date', 'date'],
  ['closingDate', 'Closing Date', 'date'],
  ['gpDate', 'G.P Date', 'date'],
  ['workType', 'Work Type', 'text'],
  ['serviceStatus', 'Status', 'text'],
  ['serviceAdvisor', 'Service Advisor', 'text'],
  ['vin', 'Vehicle VIN', 'text'],
  ['registrationNumber', 'Reg No', 'text'],
  ['model', 'Model', 'text'],
  ['mileage', 'Mileage', 'number'],
  ['saleDealer', 'Sale Dealer', 'text'],
  ['saleDate', 'Sale Date', 'date'],
  ['ucSaleDealer', 'UC Sale Dealer', 'text'],
  ['ucSaleDate', 'UC Sale Date', 'date'],
  ['customerName', 'Customer Name', 'text'],
  ['address', 'Address', 'text'],
  ['email', 'E-mail', 'email'],
  ['city', 'City', 'text'],
  ['pin', 'PIN', 'text'],
  ['mobileNumber', 'Mobile', 'tel'],
  ['office', 'Office', 'text'],
  ['technician', 'Tech.', 'text'],
  ['specialMessage', 'Special Msg.', 'text'],
  ['visitType', 'Visit Type', 'text'],
  ['demands', 'Demands', 'text'],
];

const masterCsvLabels = Object.fromEntries(masterCsvFields.map(([key, label]) => [key, label]));
const manualEntryExcludedFields = ['serialNo', 'gpDate', 'ucSaleDate', 'specialMessage', 'visitType', 'demands'];

function formatVehicleAge(totalMonths) {
  if (totalMonths == null) return '—';
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  return `${years} yr ${months} mo`;
}

function ImportErrors({ errors }) {
  return (
    <ul className="import-error-list">
      {errors.map((error, index) => (
        <li key={`${error.rowNumber}-${error.errorCode}-${index}`}>
          <strong className={`import-status ${error.status || 'rejected'}`}>{error.status || error.errorCode}</strong>
          <span>Row {error.rowNumber}{error.vin ? ` · ${error.vin}` : ''}: {error.errorMessage}</span>
        </li>
      ))}
    </ul>
  );
}

function localDateKey(value) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildUserTree(users) {
  const gms = users.filter((user) => user.role === 'GM');
  const ccms = users.filter((user) => user.role === 'CCM');
  const cres = users.filter((user) => user.role === 'CRE');
  const freeServiceCres = users.filter((user) => user.role === 'FREE_SERVICE_CRE');
  const rows = [];
  const placedCcms = new Set();
  const placedCres = new Set();
  const placedFreeServiceCres = new Set();

  function addCcm(ccm, depth) {
    placedCcms.add(ccm.id);
    rows.push({ user: ccm, depth });
    cres.filter((cre) => ccm.ccmId && cre.ccmId === ccm.ccmId).forEach((cre) => {
      placedCres.add(cre.id);
      rows.push({ user: cre, depth: depth + 1 });
    });
    freeServiceCres.filter((cre) => ccm.ccmId && cre.ccmId === ccm.ccmId).forEach((cre) => {
      placedFreeServiceCres.add(cre.id);
      rows.push({ user: cre, depth: depth + 1 });
    });
  }

  gms.forEach((gm) => {
    rows.push({ user: gm, depth: 0 });
    ccms.filter((ccm) => ccm.gmId === gm.id).forEach((ccm) => addCcm(ccm, 1));
  });
  ccms.filter((ccm) => !placedCcms.has(ccm.id)).forEach((ccm) => addCcm(ccm, 0));
  cres.filter((cre) => !placedCres.has(cre.id)).forEach((cre) => rows.push({ user: cre, depth: 0 }));
  freeServiceCres.filter((cre) => !placedFreeServiceCres.has(cre.id)).forEach((cre) => rows.push({ user: cre, depth: 0 }));
  users.filter((user) => !['GM', 'CCM', 'CRE', 'FREE_SERVICE_CRE'].includes(user.role)).forEach((user) => rows.push({ user, depth: 0 }));
  return rows;
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const activeView = resolveRoute(location.pathname).view;
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [summary, setSummary] = useState([]);
  const [calls, setCalls] = useState([]);
  const [masterListLoading, setMasterListLoading] = useState(false);
  const [masterListError, setMasterListError] = useState('');
  const [masterListMessage, setMasterListMessage] = useState('');
  const [masterListCres, setMasterListCres] = useState([]);
  const [masterListCcms, setMasterListCcms] = useState([]);
  const [masterListSavingId, setMasterListSavingId] = useState(null);
  const [masterEntryFormOpen, setMasterEntryFormOpen] = useState(false);
  const [masterEntrySaving, setMasterEntrySaving] = useState(false);
  const [selectedMasterRecordId, setSelectedMasterRecordId] = useState(null);
  const [masterEntryForm, setMasterEntryForm] = useState({
    serialNo: '',
    roNumber: '',
    visitDate: '',
    closingDate: '',
    gpDate: '',
    workType: '',
    serviceStatus: '',
    serviceAdvisor: '',
    vin: '',
    registrationNumber: '',
    model: '',
    mileage: '',
    saleDealer: '',
    saleDate: '',
    ucSaleDealer: '',
    ucSaleDate: '',
    customerName: '',
    address: '',
    email: '',
    city: '',
    pin: '',
    mobileNumber: '',
    office: '',
    technician: '',
    specialMessage: '',
    visitType: '',
    demands: '',
    ccmId: '',
  });
  const [appointments, setAppointments] = useState([]);
  const [allocationCres, setAllocationCres] = useState([]);
  const [freeServiceCres, setFreeServiceCres] = useState([]);
  const [allocationsLoading, setAllocationsLoading] = useState(false);
  const [allocationFormOpen, setAllocationFormOpen] = useState(false);
  const [allocationSaving, setAllocationSaving] = useState(false);
  const [allocationError, setAllocationError] = useState('');
  const [allocationMessage, setAllocationMessage] = useState('');
  const [allocationForm, setAllocationForm] = useState({ vehicleId: '', creId: '', serviceType: '', category: '' });
  const [customers, setCustomers] = useState([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [callLogs, setCallLogs] = useState([]);
  const [callLogsLoading, setCallLogsLoading] = useState(false);
  const [callForm, setCallForm] = useState({ customerId: '', vehicleId: '', outcome: 'CONTACTED', notes: '', nextAction: 'none', scheduledAt: '' });
  const [customerPanel, setCustomerPanel] = useState({ customerId: null, mode: 'options' });
  const [customersMenuOpen, setCustomersMenuOpen] = useState(false);
  const [freeServiceCustomerMenuOpen, setFreeServiceCustomerMenuOpen] = useState(false);
  const [freeServiceFollowUpMenuOpen, setFreeServiceFollowUpMenuOpen] = useState(false);
  const [dueRecords, setDueRecords] = useState([]);
  const [dueLoading, setDueLoading] = useState(false);
  const [dueError, setDueError] = useState('');
  const [dueSearch, setDueSearch] = useState('');
  const [followUpSearch, setFollowUpSearch] = useState('');
  const [followUpListRecords, setFollowUpListRecords] = useState([]);
  const [allocationSearch, setAllocationSearch] = useState('');
  const [dueIssues, setDueIssues] = useState([]);
  const [followUpMenuOpen, setFollowUpMenuOpen] = useState(false);
  const [performanceMenuOpen, setPerformanceMenuOpen] = useState(false);
  const [quotaNotices, setQuotaNotices] = useState(null);
  const [board, setBoard] = useState(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState('');
  const [boardDate, setBoardDate] = useState('');
  const [dashboardData, setDashboardData] = useState(null);
  const [appointmentConfirmDelete, setAppointmentConfirmDelete] = useState(null);
  const [appointmentDeletingId, setAppointmentDeletingId] = useState(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [masterListTeam, setMasterListTeam] = useState('');
  const [wpYear, setWpYear] = useState(new Date().getFullYear());
  const [wpMonth, setWpMonth] = useState(new Date().getMonth() + 1);
  const [wpCcmId, setWpCcmId] = useState('');
  const [wpCreId, setWpCreId] = useState('');
  const [wpData, setWpData] = useState(null);
  const [wpLoading, setWpLoading] = useState(false);
  const [wpError, setWpError] = useState('');
  const [selectedDay, setSelectedDay] = useState(() => localDateKey(new Date()));
  const [callSaving, setCallSaving] = useState(false);
  const [callError, setCallError] = useState('');
  const [callMessage, setCallMessage] = useState('');
  const [performance, setPerformance] = useState(null);
  const [performanceLoading, setPerformanceLoading] = useState(false);
  const [performanceError, setPerformanceError] = useState('');
  const [performanceYear, setPerformanceYear] = useState(new Date().getFullYear());
  const [performanceMonth, setPerformanceMonth] = useState(new Date().getMonth() + 1);
  const [performanceCreId, setPerformanceCreId] = useState('');
  const [followUps, setFollowUps] = useState([]);
  const [followUpsLoading, setFollowUpsLoading] = useState(false);
  const [followUpError, setFollowUpError] = useState('');
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  const [appointmentFormOpen, setAppointmentFormOpen] = useState(false);
  const [appointmentSaving, setAppointmentSaving] = useState(false);
  const [appointmentError, setAppointmentError] = useState('');
  const [appointmentMessage, setAppointmentMessage] = useState('');
  const [appointmentForm, setAppointmentForm] = useState({ customerId: '', vehicleId: '', customerName: '', vehicleName: '', scheduledAt: '' });
  const [imports, setImports] = useState([]);
  const [importsLoading, setImportsLoading] = useState(false);
  const [importUploading, setImportUploading] = useState(false);
  const [importError, setImportError] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [importResult, setImportResult] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const [importRollbackBatch, setImportRollbackBatch] = useState(null);
  const [importRollbackError, setImportRollbackError] = useState('');
  const [importRollbackSaving, setImportRollbackSaving] = useState(false);
  const [importRecoverySaving, setImportRecoverySaving] = useState(false);
  const [importCcmId, setImportCcmId] = useState('');
  const [customerFormOpen, setCustomerFormOpen] = useState(false);
  const [customerSaving, setCustomerSaving] = useState(false);
  const [customerMessage, setCustomerMessage] = useState('');
  const [customerError, setCustomerError] = useState('');
  const [customerForm, setCustomerForm] = useState({
    fullName: '',
    mobileNumber: '',
    email: '',
    ccmId: '',
    vehicles: [{ vin: '', registrationNumber: '', model: '', year: '' }],
  });
  const [managedUsers, setManagedUsers] = useState([]);
  const [managedTeams, setManagedTeams] = useState({ gms: [], ccms: [], cres: [] });
  const [managedUsersLoading, setManagedUsersLoading] = useState(false);
  const [managedUsersError, setManagedUsersError] = useState('');
  const [managedUsersMessage, setManagedUsersMessage] = useState('');
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [userFormClosing, setUserFormClosing] = useState(false);
  const [editingUserId, setEditingUserId] = useState(null);
  const [userSaving, setUserSaving] = useState(false);
  const [passwordUnlocked, setPasswordUnlocked] = useState(false);
  const [userForm, setUserForm] = useState({ name: '', username: '', password: '', phone: '', role: 'CRE', ccmId: '', gmId: '', dealerCode: '', freeServiceEnabled: false, warrantyEnabled: false });
  const [selectedCcm, setSelectedCcm] = useState(null);
  const [ccmProfile, setCcmProfile] = useState(null);
  const [monthlyYear, setMonthlyYear] = useState(new Date().getFullYear());
  const [monthlyMonth, setMonthlyMonth] = useState(new Date().getMonth() + 1);
  const [monthlyEntries, setMonthlyEntries] = useState([]);
  const [monthlyImports, setMonthlyImports] = useState([]);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyError, setMonthlyError] = useState('');
  const [monthlyMessage, setMonthlyMessage] = useState('');
  const [monthlyForm, setMonthlyForm] = useState({ customerName: '', mobileNumber: '', email: '', vin: '', registrationNumber: '', model: '', vehicleYear: '', serviceType: '', lastVisitDate: '', nextServiceDueDate: '', notes: '' });
  const [monthlyFile, setMonthlyFile] = useState(null);
  const [monthlyPreview, setMonthlyPreview] = useState(null);
  const [monthlyBusy, setMonthlyBusy] = useState(false);
  const routeActionsRef = useRef({});
  const userFormDialogRef = useRef(null);
  const userFormCloseButtonRef = useRef(null);
  const userFormCloseTimerRef = useRef(null);
  const previousUserFormFocusRef = useRef(null);
  const userSavingRef = useRef(false);
  const importRequestKeyRef = useRef(null);
  const lastLoadedRouteKeyRef = useRef('');

  function setActiveView(view, options = {}) {
    const ccmId = options.ccmId || selectedCcm?.ccmId || currentUser?.ccmId || '';
    const targetPath = pathForView(view, ccmId);
    if (location.pathname !== targetPath) navigate(targetPath, { replace: options.replace === true });
  }

  function closeUserForm({ force = false } = {}) {
    if (userSavingRef.current && !force) return;
    if (userFormCloseTimerRef.current) window.clearTimeout(userFormCloseTimerRef.current);
    setUserFormClosing(true);
    userFormCloseTimerRef.current = window.setTimeout(() => {
      setUserFormOpen(false);
      setUserFormClosing(false);
      setEditingUserId(null);
      userFormCloseTimerRef.current = null;
    }, 140);
  }

  useEffect(() => {
    let isMounted = true;

    async function loadDashboard() {
      setLoading(true);
      try {
        const userResponse = await api.get('/auth/me');
        if (!isMounted) return;
        setCurrentUser(userResponse.data.user);

        // Non-blocking: the dashboard renders without it if the notices cannot load.
        if (String(userResponse.data.user?.role || '').toUpperCase() === 'CCM') {
          api.get('/notifications/quota').then((response) => { if (isMounted) setQuotaNotices(response.data); }).catch(() => {});
        } else {
          setQuotaNotices(null);
        }
        const [summaryResponse, appointmentResponse] = await Promise.all([
          api.get('/dashboard/summary'),
          ['CCM', 'CRE', 'FREE_SERVICE_CRE', 'GM', 'ADMIN'].includes(String(userResponse.data.user?.role || '').toUpperCase())
            ? api.get('/appointments')
            : Promise.resolve({ data: { appointments: [] } }),
        ]);

        if (!isMounted) {
          return;
        }

        setDashboardData(summaryResponse.data);

        const nextSummary = [
          { label: 'Total customers', value: summaryResponse.data.totalCustomers, change: 'Current total' },
          { label: 'Active vehicles', value: summaryResponse.data.activeVehicles, change: 'Current total' },
          { label: 'Calls today', value: summaryResponse.data.todaysCalls, change: `${summaryResponse.data.pendingFollowUps} follow-ups pending` },
          { label: 'Appointments', value: summaryResponse.data.appointmentCount, change: 'Today' },
        ];

        setSummary(nextSummary);
        setAppointments(appointmentResponse.data.appointments || []);
      } catch (error) {
        if (error.response?.status !== 401) {
          console.error('Dashboard load failed.', error);
          setSummary([
            { label: 'Total customers', value: 0, change: 'Current total' },
            { label: 'Active vehicles', value: 0, change: 'Current total' },
            { label: 'Calls today', value: 0, change: 'Today' },
            { label: 'Appointments', value: 0, change: 'Today' },
          ]);
          setCalls([]);
          setAppointments([]);
        }
        setCurrentUser(null);
      } finally {
        if (isMounted) {
          setAuthChecked(true);
          setLoading(false);
        }
      }
    }

    loadDashboard();

    return () => {
      isMounted = false;
    };
  }, [sessionVersion]);

  async function submitLogin(event) {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError('');
    try {
      await api.post('/auth/login', loginForm);
      setAuthChecked(false);
      setSessionVersion((version) => version + 1);
      setLoginForm((current) => ({ ...current, password: '' }));
    } catch (error) {
      setLoginError(error.response?.data?.message || 'Unable to sign in. Check your credentials and try again.');
    } finally {
      setLoginBusy(false);
    }
  }

  async function signOut() {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      console.warn('Server sign-out request failed; clearing the local session.', error);
    } finally {
      setCurrentUser(null);
      setAuthChecked(true);
      setLoading(false);
      navigate('/login', { replace: true });
      setCustomersMenuOpen(false);
      setFollowUpMenuOpen(false);
      setPerformanceMenuOpen(false);
      setQuotaNotices(null);
      setPerformance(null);
      setPerformanceCreId('');
      setCalls([]);
      setAppointments([]);
    }
  }

  async function openCustomers() {
    setActiveView('Customers');
    setCustomerPanel({ customerId: null, mode: 'options' });
    setCustomersLoading(true);
    setCustomerError('');
    try {
      const response = await api.get('/customers');
      setCustomers(response.data.customers || []);
    } catch (error) {
      setCustomerError(error.response?.data?.message || 'Could not load customers. Sign in and try again.');
    } finally {
      setCustomersLoading(false);
    }
  }

  async function loadReports(year, month, ccmId, creId) {
    setWpLoading(true);
    setWpError('');
    try {
      const params = new URLSearchParams({ year: String(year), month: String(month), tzOffset: String(new Date().getTimezoneOffset()) });
      if (ccmId) params.set('ccmId', ccmId);
      if (creId) params.set('creId', creId);
      const response = await api.get(`/performance/workshop?${params}`);
      setWpData(response.data);
    } catch (error) {
      setWpError(error.response?.data?.message || 'Could not load workshop performance.');
    } finally {
      setWpLoading(false);
    }
  }

  async function openReports() {
    setActiveView('Reports');
    setWpLoading(true);
    setWpError('');
    try {
      const teamsResponse = await api.get('/teams');
      const ccms = teamsResponse.data.ccms || [];
      const cres = teamsResponse.data.cres || [];
      const selectedCcmId = ccms.some((ccm) => ccm.ccmId === wpCcmId) ? wpCcmId : '';
      const selectedCreId = cres.some((cre) => cre.id === wpCreId && (!selectedCcmId || cre.ccmId === selectedCcmId))
        ? wpCreId
        : '';
      setMasterListCres(cres);
      setMasterListCcms(ccms);
      setWpCcmId(selectedCcmId);
      setWpCreId(selectedCreId);
      await loadReports(wpYear, wpMonth, selectedCcmId, selectedCreId);
    } catch (error) {
      setWpError(error.response?.data?.message || 'Could not load teams.');
      setWpData(null);
      setWpLoading(false);
    }
  }

  function changeWorkshopFilter(next) {
    const ccmChanged = Object.hasOwn(next, 'ccmId') && next.ccmId !== wpCcmId;
    const filter = {
      year: wpYear,
      month: wpMonth,
      ccmId: wpCcmId,
      creId: wpCreId,
      ...next,
    };
    if (ccmChanged) filter.creId = '';
    else if (!Object.hasOwn(next, 'creId')) filter.creId = wpCreId;
    setWpYear(filter.year);
    setWpMonth(filter.month);
    setWpCcmId(filter.ccmId);
    setWpCreId(filter.creId);
    loadReports(filter.year, filter.month, filter.ccmId, filter.creId);
  }

  async function openMasterList() {
    setActiveView('Master list');
    setMasterListLoading(true);
    setMasterListError('');
    try {
      const requests = [api.get('/call-list')];
      if (String(currentUser?.role || '').toUpperCase() === 'CCM') {
        requests.push(api.get('/teams'));
      } else if (['ADMIN', 'GM'].includes(String(currentUser?.role || '').toUpperCase())) {
        requests.push(api.get('/teams'));
      }
      const [recordsResponse, teamsResponse] = await Promise.all(requests);
      setCalls(recordsResponse.data.records || []);
      setMasterListCres(teamsResponse?.data?.cres || []);
      setMasterListCcms(teamsResponse?.data?.ccms || []);
    } catch (error) {
      setMasterListError(error.response?.data?.message || 'Could not load the master call list.');
    } finally {
      setMasterListLoading(false);
    }
  }

  async function changeMasterListAssignee(recordId, assigneeId) {
    setMasterListSavingId(recordId);
    setMasterListError('');
    try {
      const response = await api.patch(`/allocations/master-call-list/${recordId}/assignee`, { assigneeId });
      setCalls((current) => current.map((record) => record.id === recordId
        ? { ...record, ...response.data.record }
        : record));
      // Due, Free Service and Warranty rows carry their master-list record id as `recordId` (or `id`).
      setDueRecords((current) => current.map((record) => (record.recordId || record.id) === recordId
        ? { ...record, assigneeId: response.data.record.assigneeId, assigneeName: response.data.record.assigneeName }
        : record));
    } catch (error) {
      setMasterListError(error.response?.data?.message || 'Could not update the CRE assignment.');
    } finally {
      setMasterListSavingId(null);
    }
  }

  async function submitMasterEntry(event) {
    event.preventDefault();
    setMasterEntrySaving(true);
    setMasterListError('');
    setMasterListMessage('');
    try {
      const payload = {
        ...masterEntryForm,
        year: masterEntryForm.year || undefined,
        ccmId: currentRole === 'CCM' ? currentUser.ccmId : masterEntryForm.ccmId,
        visitDate: masterEntryForm.visitDate || undefined,
        totalLaborCost: masterEntryForm.totalLaborCost || undefined,
        totalPartsCost: masterEntryForm.totalPartsCost || undefined,
      };
      const response = await api.post('/call-list', payload);
      const record = response.data.record;
      setCalls((current) => [record, ...current.filter((existing) => existing.id !== record.id)]);
      setMasterEntryForm({
        serialNo: '',
        roNumber: '',
        visitDate: '',
        closingDate: '',
        gpDate: '',
        workType: '',
        serviceStatus: '',
        serviceAdvisor: '',
        vin: '',
        registrationNumber: '',
        model: '',
        mileage: '',
        saleDealer: '',
        saleDate: '',
        ucSaleDealer: '',
        ucSaleDate: '',
        customerName: '',
        address: '',
        email: '',
        city: '',
        pin: '',
        mobileNumber: '',
        office: '',
        technician: '',
        specialMessage: '',
        visitType: '',
        demands: '',
        ccmId: currentRole === 'CCM' ? currentUser.ccmId : '',
      });
      setMasterEntryFormOpen(false);
      setMasterListMessage('Customer added to the master call list.');
    } catch (error) {
      setMasterListError(error.response?.data?.message || 'Could not add the customer to the master call list.');
    } finally {
      setMasterEntrySaving(false);
    }
  }

  async function openUserManagement() {
    setActiveView('User Management');
    setManagedUsersLoading(true);
    setManagedUsersError('');
    try {
      const [response, teamsResponse] = await Promise.all([api.get('/users'), api.get('/teams')]);
      setManagedUsers(response.data.users || []);
      setManagedTeams(teamsResponse.data || { gms: [], ccms: [], cres: [] });
    } catch (error) {
      setManagedUsersError(error.response?.data?.message || 'Could not load user accounts.');
    } finally {
      setManagedUsersLoading(false);
    }
  }

  async function startUserEdit(user = null) {
    let account = user;
    if (user?.id) {
      setManagedUsersLoading(true);
      setManagedUsersError('');
      try {
        const response = await api.get(`/users/${user.id}`);
        account = response.data.user;
        setManagedUsers((current) => current.map((entry) => entry.id === account.id ? account : entry));
      } catch (error) {
        setManagedUsersError(error.response?.data?.message || 'Could not load the latest account settings.');
        return;
      } finally {
        setManagedUsersLoading(false);
      }
    }

    if (userFormCloseTimerRef.current) {
      window.clearTimeout(userFormCloseTimerRef.current);
      userFormCloseTimerRef.current = null;
    }
    setEditingUserId(account?.id || null);
    setUserFormClosing(false);
    setPasswordUnlocked(false);
    setUserForm({
      name: account?.name || '',
      username: account?.username || '',
      password: '',
      role: account?.role || 'CRE',
      ccmId: account?.ccmId || '',
      gmId: account?.gmId || '',
      phone: account?.phone || '',
      dealerCode: account?.dealerCode || '',
      freeServiceEnabled: account?.freeServiceEnabled === true,
      warrantyEnabled: account?.warrantyEnabled === true,
    });
    setUserFormOpen(true);
    setManagedUsersError('');
    setManagedUsersMessage('');
  }

  async function refreshDashboardSummary() {
    try {
      const summaryRes = await api.get('/dashboard/summary');
      setDashboardData(summaryRes.data);
      const nextSummary = [
        { label: 'Total customers', value: summaryRes.data.totalCustomers, change: 'Current total' },
        { label: 'Active vehicles', value: summaryRes.data.activeVehicles, change: 'Current total' },
        { label: 'Calls today', value: summaryRes.data.todaysCalls, change: `${summaryRes.data.pendingFollowUps} follow-ups pending` },
        { label: 'Appointments', value: summaryRes.data.appointmentCount, change: 'Today' },
      ];
      setSummary(nextSummary);
    } catch (e) {
      console.error('Failed to refresh dashboard summary', e);
    }
  }

  async function submitManagedUser(event) {
    event.preventDefault();
    setUserSaving(true);
    setManagedUsersError('');
    setManagedUsersMessage('');
    const payload = {
      ...userForm,
      ccmId: userForm.ccmId || undefined,
      gmId: userForm.gmId || undefined,
      phone: userForm.phone || null,
      dealerCode: userForm.dealerCode || null,
      password: userForm.password || undefined,
    };
    if (!editingUserId && !payload.password) {
      setManagedUsersError('A password of at least 8 characters is required for new accounts.');
      setUserSaving(false);
      return;
    }
    try {
      const response = editingUserId
        ? await api.patch(`/users/${editingUserId}`, payload)
        : await api.post('/users', payload);
      setManagedUsers((current) => editingUserId
        ? current.map((user) => user.id === editingUserId ? response.data.user : user)
        : [response.data.user, ...current]);
      closeUserForm({ force: true });
      setManagedUsersMessage(editingUserId ? 'Account updated.' : 'Account created.');
      await refreshDashboardSummary();
    } catch (error) {
      setManagedUsersError(error.response?.data?.message || 'Could not save user account.');
    } finally {
      setUserSaving(false);
    }
  }

  async function toggleManagedUserStatus(user) {
    setManagedUsersError('');
    setManagedUsersMessage('');
    const status = user.status === 'active' ? 'inactive' : 'active';
    try {
      const response = await api.patch(`/users/${user.id}/status`, { status });
      setManagedUsers((current) => current.map((entry) => entry.id === user.id ? response.data.user : entry));
      await refreshDashboardSummary();
    } catch (error) {
      setManagedUsersError(error.response?.data?.message || 'Could not update account status.');
    }
  }

  async function deleteManagedAccount(user) {
    const confirmation = ['CRE', 'FREE_SERVICE_CRE'].includes(user.role)
      ? `Permanently delete ${user.username} (${user.role === 'CRE' ? 'CRE' : 'Free-Service CRE'})? Their assigned customers will be redistributed to active CREs, or left unassigned if none are available. Repair and call history will be retained.`
      : `Delete ${user.username} (${user.role})? This cannot be undone.`;
    if (!window.confirm(confirmation)) return;
    setManagedUsersError('');
    setManagedUsersMessage('');
    try {
      const response = await api.delete(`/users/${user.id}`);
      if (response.data.softDeleted) {
        setManagedUsers((current) => current.map((entry) => entry.id === user.id ? { ...entry, status: 'inactive' } : entry));
        setManagedUsersMessage('Account deactivated and any customer assignments redistributed. Historical records are retained.');
      } else {
        setManagedUsers((current) => current.filter((entry) => entry.id !== user.id));
        setManagedUsersMessage(['CRE', 'FREE_SERVICE_CRE'].includes(user.role)
          ? 'Account permanently deleted. Assigned customers were redistributed where possible; repair, call, and appointment records are retained.'
          : 'Account deleted. Historical customer and monthly records are retained.');
      }
      await refreshDashboardSummary();
    } catch (error) {
      setManagedUsersError(error.response?.data?.message || 'Could not delete account.');
    }
  }

  async function openOwnMonthlyData() {
    if (!currentUser?.ccmId) return;
    const ccm = managedTeams.ccms.find((item) => item.ccmId === currentUser.ccmId);
    const selected = {
      ccmId: currentUser.ccmId,
      name: ccm?.name || `CCM ${currentUser.ccmId}`,
    };
    setSelectedCcm(selected);
    setCcmProfile(null);
    setActiveView('CcmProfile', { ccmId: selected.ccmId });
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    setMonthlyYear(year);
    setMonthlyMonth(month);
    setMonthlyError('');
    setMonthlyMessage('');
    await loadMonthlyData(selected.ccmId, year, month);
  }

  async function openCcmProfile(user) {
    setSelectedCcm(user);
    setActiveView('CcmProfile', { ccmId: user.ccmId });
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    setMonthlyYear(year);
    setMonthlyMonth(month);
    setMonthlyError('');
    setMonthlyMessage('');
    setMonthlyLoading(true);
    try {
      const response = await api.get(`/ccms/${user.ccmId}/profile`);
      setCcmProfile(response.data);
    } catch (error) {
      setMonthlyError(error.response?.data?.message || 'Could not load the CCM profile.');
    } finally {
      setMonthlyLoading(false);
    }
    await loadMonthlyData(user.ccmId, year, month);
  }

  async function loadMonthlyData(ccmId = selectedCcm?.ccmId, year = monthlyYear, month = monthlyMonth) {
    if (!ccmId) return;
    setMonthlyLoading(true);
    setMonthlyError('');
    try {
      const query = `?year=${year}&month=${month}`;
      const [dataResponse, historyResponse] = await Promise.all([
        api.get(`/ccms/${ccmId}/monthly-customer-data${query}`),
        api.get(`/ccms/${ccmId}/monthly-customer-data/history${query}`),
      ]);
      setMonthlyEntries(dataResponse.data.entries || []);
      setMonthlyImports(historyResponse.data.imports || []);
    } catch (error) {
      setMonthlyError(error.response?.data?.message || 'Could not load monthly customer data.');
    } finally {
      setMonthlyLoading(false);
    }
  }

  async function changeMonthlyPeriod(year, month) {
    setMonthlyYear(year);
    setMonthlyMonth(month);
    setMonthlyPreview(null);
    setMonthlyMessage('');
    await loadMonthlyData(selectedCcm?.ccmId, year, month);
  }

  async function submitMonthlyEntry(event) {
    event.preventDefault();
    if (!selectedCcm) return;
    setMonthlyBusy(true);
    setMonthlyError('');
    setMonthlyMessage('');
    const payload = {
      ...monthlyForm,
      vehicleYear: monthlyForm.vehicleYear || undefined,
      lastVisitDate: monthlyForm.lastVisitDate || undefined,
      nextServiceDueDate: monthlyForm.nextServiceDueDate || undefined,
    };
    try {
      const response = await api.post(`/ccms/${selectedCcm.ccmId}/monthly-customer-data?year=${monthlyYear}&month=${monthlyMonth}`, payload);
      setMonthlyEntries((current) => [response.data.entry, ...current]);
      setMonthlyForm({ customerName: '', mobileNumber: '', email: '', vin: '', registrationNumber: '', model: '', vehicleYear: '', serviceType: '', lastVisitDate: '', nextServiceDueDate: '', notes: '' });
      setMonthlyMessage('Customer added to the selected month.');
    } catch (error) {
      setMonthlyError(error.response?.data?.message || 'Could not add monthly customer data.');
    } finally {
      setMonthlyBusy(false);
    }
  }

  async function previewMonthlyImport(event) {
    event.preventDefault();
    if (!monthlyFile || !selectedCcm) return;
    setMonthlyBusy(true);
    setMonthlyError('');
    setMonthlyMessage('');
    try {
      let content;
      if (monthlyFile.name.toLowerCase().endsWith('.csv')) {
        content = await monthlyFile.text();
      } else {
        const bytes = new Uint8Array(await monthlyFile.arrayBuffer());
        let binary = '';
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        content = btoa(binary);
      }
      const response = await api.post(`/ccms/${selectedCcm.ccmId}/monthly-customer-data/preview?year=${monthlyYear}&month=${monthlyMonth}`, { fileName: monthlyFile.name, content });
      setMonthlyPreview(response.data);
    } catch (error) {
      setMonthlyError(error.response?.data?.message || 'Could not preview the selected file.');
    } finally {
      setMonthlyBusy(false);
    }
  }

  async function commitMonthlyImport() {
    if (!monthlyFile || !monthlyPreview || !selectedCcm) return;
    setMonthlyBusy(true);
    setMonthlyError('');
    try {
      let content;
      if (monthlyFile.name.toLowerCase().endsWith('.csv')) content = await monthlyFile.text();
      else {
        const bytes = new Uint8Array(await monthlyFile.arrayBuffer());
        let binary = '';
        for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        content = btoa(binary);
      }
      const response = await api.post(`/ccms/${selectedCcm.ccmId}/monthly-customer-data/import?year=${monthlyYear}&month=${monthlyMonth}`, { fileName: monthlyFile.name, content });
      setMonthlyMessage(`Import complete: ${response.data.import.addedRows} added, ${response.data.import.skippedRows} skipped, ${response.data.import.rejectedRows} rejected.`);
      setMonthlyPreview(null);
      setMonthlyFile(null);
      await loadMonthlyData(selectedCcm.ccmId);
      const profileResponse = await api.get(`/ccms/${selectedCcm.ccmId}/profile`);
      setCcmProfile(profileResponse.data);
      const callListResponse = await api.get('/call-list');
      setCalls(callListResponse.data.records || []);
    } catch (error) {
      setMonthlyError(error.response?.data?.message || 'Could not import monthly customer data.');
    } finally {
      setMonthlyBusy(false);
    }
  }

  function openCustomerPanel(customer) {
    setCallError('');
    setCallMessage('');
    setCustomerPanel({ customerId: customer.id, mode: 'options' });
  }

  function startCall(customer, vehicleId, { callSource = 'SERVICE', milestoneId = '' } = {}) {
    setCallError('');
    setCallMessage('');
    setCallForm({ customerId: customer.id, vehicleId: vehicleId || customer.vehicles?.[0]?.id || '', outcome: 'CONTACTED', notes: '', nextAction: 'none', scheduledAt: '', callSource, milestoneId });
    setCustomerPanel({ customerId: customer.id, mode: 'call' });
  }

  async function startCallFromMasterRecord(record) {
    setCallError('');
    setCallMessage('');
    if (!record.customerId || record.assigneeId !== currentUser?.id) {
      setCallError('You can only call customers assigned to you.');
      return;
    }

    let customer = customers.find((entry) => entry.id === record.customerId);
    if (!customer) {
      try {
        const response = await api.get('/customers');
        const records = response.data.customers || [];
        setCustomers(records);
        customer = records.find((entry) => entry.id === record.customerId);
      } catch (error) {
        setCallError(error.response?.data?.message || 'Could not load this assigned customer.');
        return;
      }
    }
    if (!customer) {
      setCallError('This assigned customer is not available. Reload the Master Call List and try again.');
      return;
    }
    startCall(customer, record.vehicleId, { callSource: 'SERVICE' });
  }

  async function loadDueData(viewName) {
    const view = dueViews[viewName];
    setDueLoading(true);
    setDueError('');
    try {
      const endpoint = view.kind === 'free' ? '/free-service' : view.kind === 'warranty' ? '/warranty' : `/call-list/due?window=${view.window}`;
      const requests = [api.get(endpoint), api.get('/customers')];
      if (currentRole === 'CCM') requests.push(api.get('/teams'));
      const [dueResponse, customerResponse, teamResponse] = await Promise.all(requests);
      setDueRecords(dueResponse.data.records || []);
      setDueIssues(dueResponse.data.dataIssues || []);
      setCustomers(customerResponse.data.customers || []);
      if (teamResponse) {
        setAllocationCres(teamResponse.data.cres || []);
        setMasterListCcms(teamResponse.data.ccms || []);
      }
    } catch (error) {
      setDueError(error.response?.data?.message || 'Could not load this customer list.');
    } finally {
      setDueLoading(false);
    }
  }

  async function openDueList(viewName) {
    if ((viewName === 'Free Service' && !canAccessFreeService) || (viewName === 'Warranty' && !canAccessWarranty)) return;
    setActiveView(viewName);
    setCustomersMenuOpen(true);
    setDueSearch('');
    setDueRecords([]);
    setDueIssues([]);
    setCustomerPanel({ customerId: null, mode: 'options' });
    setCallError('');
    setCallMessage('');
    await loadDueData(viewName);
  }

  async function openDueCustomer(record, mode) {
    const customer = customers.find((entry) => entry.id === record.customerId);
    if (!customer) {
      setDueError('This customer is not available. Reload the list and try again.');
      return;
    }
    setDueError('');
    if (mode === 'call') {
      startCall(customer, record.vehicleId, {
        callSource: record.callSource || dueViews[activeView]?.callSource || 'SERVICE',
        milestoneId: record.milestoneId || '',
      });
    } else await openCustomerProfile(customer);
    setTimeout(() => document.querySelector('.customer-action-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }

  async function openCustomerProfile(customer) {
    setCustomerPanel({ customerId: customer.id, mode: 'profile' });
    setCallLogsLoading(true);
    try {
      const response = await api.get('/call-logs');
      setCallLogs(response.data.callLogs || []);
    } catch (error) {
      setCallError(error.response?.data?.message || 'Could not load call history.');
    } finally {
      setCallLogsLoading(false);
    }
  }

  function callFromFollowUp(followUp, vehicleId) {
    openDueCustomer({
      customerId: followUp.customer.id,
      vehicleId: followUp.vehicleId || vehicleId,
      callSource: followUp.source,
      milestoneId: followUp.milestoneId || '',
    }, 'call');
  }

  async function submitCall(event) {
    event.preventDefault();
    setCallSaving(true);
    setCallError('');
    setCallMessage('');
    const scheduledAt = callForm.scheduledAt ? new Date(callForm.scheduledAt).toISOString() : undefined;
    const outcome = callForm.nextAction === 'followup' ? 'FOLLOW_UP_LATER' : callForm.nextAction === 'appointment' ? 'APPOINTMENT_SET' : callForm.outcome;
    let callSaved = false;
    try {
      const response = await api.post('/call-logs', {
        customerId: callForm.customerId,
        vehicleId: callForm.vehicleId || undefined,
        outcome,
        callSource: callForm.callSource || 'SERVICE',
        milestoneId: callForm.milestoneId || undefined,
        notes: callForm.notes || undefined,
        followUpAt: callForm.nextAction === 'followup' ? scheduledAt : undefined,
      });
      callSaved = true;
      setCallLogs((current) => [response.data.callLog, ...current]);
      if (activeView === 'Master list') {
        try {
          const [recordsResponse, summaryResponse] = await Promise.all([
            api.get('/call-list'),
            api.get('/dashboard/summary'),
          ]);
          setCalls(recordsResponse.data.records || []);
          setDashboardData(summaryResponse.data);
        } catch (error) {
          setCallError(`Call saved, but the list or dashboard could not refresh: ${error.response?.data?.message || 'Please reload to see the latest activity.'}`);
        }
      }
      if (callForm.nextAction === 'appointment') {
        const appointmentResponse = await api.post('/appointments', {
          customerId: callForm.customerId,
          vehicleId: callForm.vehicleId || undefined,
          scheduledAt,
        });
        const created = appointmentResponse.data.appointment;
        setAppointments((current) => [...current, {
          id: created.id,
          customer: created.customer?.fullName || created.customerName,
          customerId: created.customerId,
          vehicle: created.vehicle?.model || created.vehicleName,
          vehicleId: created.vehicleId,
          scheduledAt: created.scheduledAt,
          status: created.status,
          assigneeName: currentUser?.name,
        }].sort((left, right) => new Date(left.scheduledAt) - new Date(right.scheduledAt)));
      }
      setCallMessage(callForm.nextAction === 'followup' ? 'Call saved and follow-up scheduled.' : callForm.nextAction === 'appointment' ? 'Call saved and appointment booked.' : 'Call saved.');
      setCustomerPanel({ customerId: null, mode: 'options' });
      if (activeView in followUpViews) loadFollowUps(followUpViews[activeView].source);
      else if (activeView in dueViews) loadDueData(activeView);
    } catch (error) {
      const reason = error.response?.data?.message || 'Check the details and try again.';
      setCallError(callSaved
        ? callForm.nextAction === 'appointment'
          ? `Call saved, but the appointment could not be booked: ${reason}`
          : `Call saved, but the interface could not refresh: ${reason}`
        : `Could not save the call. ${reason}`);
      if (callSaved) setCustomerPanel({ customerId: null, mode: 'options' });
    } finally {
      setCallSaving(false);
    }
  }

  function deleteAppointment(appointment) {
    setAppointmentConfirmDelete(appointment);
  }

  async function confirmDeleteAppointment(appointment) {
    if (!appointment || appointmentDeletingId) return;
    setAppointmentDeletingId(appointment.id);
    setAppointmentError('');
    setAppointmentMessage('');
    try {
      await api.delete(`/appointments/${appointment.id}`);
      setAppointments((current) => current.filter((entry) => entry.id !== appointment.id));
      setAppointmentMessage('Appointment deleted successfully.');
      setAppointmentConfirmDelete(null);
      setDashboardData((prev) => {
        if (!prev) return prev;
        const copy = { ...prev };
        if (copy.appointmentCount) copy.appointmentCount = Math.max(0, copy.appointmentCount - 1);
        if (copy.cre?.todayAppointments) {
          copy.cre = {
            ...copy.cre,
            todayAppointments: copy.cre.todayAppointments.filter((a) => a.id !== appointment.id),
          };
        }
        if (copy.ccm?.todayAppointments) {
          copy.ccm = {
            ...copy.ccm,
            todayAppointments: copy.ccm.todayAppointments.filter((a) => a.id !== appointment.id),
          };
        }
        if (copy.gm?.todayAppointments) {
          copy.gm = {
            ...copy.gm,
            todayAppointments: copy.gm.todayAppointments.filter((a) => a.id !== appointment.id),
          };
        }
        return copy;
      });
    } catch (error) {
      setAppointmentError(error.response?.data?.message || 'Could not delete the appointment.');
    } finally {
      setAppointmentDeletingId(null);
    }
  }

  async function loadFollowUps(source) {
    setFollowUpsLoading(true);
    setFollowUpError('');
    try {
      const requests = [
        api.get(`/follow-ups?source=${source}`),
        api.get('/call-list'),
        api.get('/customers'),
      ];
      if (source === 'FREE_SERVICE') requests.push(api.get('/free-service'));
      if (source === 'WARRANTY') requests.push(api.get('/warranty'));
      const [followUpResponse, recordsResponse, customerResponse, sourceListResponse] = await Promise.all(requests);
      setFollowUps(followUpResponse.data.followUps || []);
      setCalls(recordsResponse.data.records || []);
      setCustomers(customerResponse.data.customers || []);
      setFollowUpListRecords(sourceListResponse?.data.records || []);
    } catch (error) {
      setFollowUpError(error.response?.data?.message || 'Could not load follow-ups. Sign in and try again.');
    } finally {
      setFollowUpsLoading(false);
    }
  }

  async function openFollowUpList(viewName) {
    if ((viewName === 'Follow-up Free Service' && !canAccessFreeService) || (viewName === 'Follow-up Warranty' && !canAccessWarranty)) return;
    setActiveView(viewName);
    setFollowUpMenuOpen(true);
    setFollowUps([]);
    setFollowUpSearch('');
    setDueError('');
    setCustomerPanel({ customerId: null, mode: 'options' });
    setCallError('');
    setCallMessage('');
    await loadFollowUps(followUpViews[viewName].source);
  }

  async function openDashboard() {
    navigate(routeByView.Dashboard, { replace: true });
    setLoading(true);
    try {
      const [summaryRes, apptRes] = await Promise.all([
        api.get('/dashboard/summary'),
        ['CCM', 'CRE', 'GM', 'ADMIN'].includes(currentRole)
          ? api.get('/appointments')
          : Promise.resolve({ data: { appointments: [] } }),
      ]);
      setDashboardData(summaryRes.data);
      setAppointments(apptRes.data.appointments || []);
      if (currentRole === 'CCM') {
        api.get('/notifications/quota').then((res) => setQuotaNotices(res.data)).catch(() => {});
      }
    } catch (e) {
      console.error('Failed to reload dashboard', e);
    } finally {
      setLoading(false);
    }
  }

  async function exportWorkshopPerformancePdf() {
    setExportingPdf(true);
    try {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonthKey = `${currentYear}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const params = new URLSearchParams({
        startMonth: `${currentYear - 1}-01`,
        endMonth: currentMonthKey,
        serviceType: 'All',
        ...(currentRole === 'CCM' ? {} : wpCcmId ? { ccmId: wpCcmId } : {}),
      });

      const response = await api.get(`/export/workshop-performance/pdf?${params}`, {
        responseType: 'blob',
      });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const dateStr = now.toISOString().slice(0, 10);
      link.download = `Workshop_Performance_${dateStr}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('PDF export failed:', error);
      alert(error.response?.data?.message || 'Could not export Workshop Performance PDF.');
    } finally {
      setExportingPdf(false);
    }
  }

  async function exportReportsPdf() {
    setExportingPdf(true);
    try {
      const now = new Date();
      const params = new URLSearchParams({
        year: String(wpYear),
        month: String(wpMonth),
        tzOffset: String(now.getTimezoneOffset()),
        ...(wpCcmId ? { ccmId: wpCcmId } : {}),
        ...(wpCreId ? { creId: wpCreId } : {}),
      });

      const response = await api.get(`/export/reports/pdf?${params}`, {
        responseType: 'blob',
      });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const dateStr = now.toISOString().slice(0, 10);
      link.download = `Reports_${dateStr}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Reports PDF export failed:', error);
      alert(error.response?.data?.message || 'Could not export Reports PDF.');
    } finally {
      setExportingPdf(false);
    }
  }

  async function loadBoard(dateKey) {
    setBoardLoading(true);
    setBoardError('');
    try {
      const response = await api.get('/performance/board', { params: dateKey ? { date: dateKey } : {} });
      setBoard(response.data);
      setBoardDate(response.data.date);
    } catch (error) {
      setBoardError(error.response?.data?.message || 'Could not load the performance board.');
    } finally {
      setBoardLoading(false);
    }
  }

  async function openPerformanceBoard() {
    setActiveView('Performance Board');
    setPerformanceMenuOpen(true);
    await loadBoard('');
  }

  async function loadPerformance(year, month, creId, freeServiceSelected) {
    setPerformanceLoading(true);
    setPerformanceError('');
    try {
      const params = new URLSearchParams({ year: String(year), month: String(month) });
      if (creId) params.set('creId', creId);
      const isFreeServiceCre = freeServiceSelected ?? (currentRole === 'FREE_SERVICE_CRE' || freeServiceCres.some((user) => user.id === creId));
      const response = await api.get(`/performance/${isFreeServiceCre ? 'free-service' : 'summary'}?${params}`);
      setPerformance(response.data);
    } catch (error) {
      setPerformanceError(error.response?.data?.message || 'Could not load the performance summary.');
      setPerformance(null);
    } finally {
      setPerformanceLoading(false);
    }
  }

  function changePerformancePeriod(year, month, creId = performanceCreId) {
    setPerformanceYear(year);
    setPerformanceMonth(month);
    if (currentRole === 'CRE' || currentRole === 'FREE_SERVICE_CRE' || creId) loadPerformance(year, month, creId);
    else setPerformance(null);
  }

  function changePerformanceCre(creId) {
    setPerformanceCreId(creId);
    if (creId) loadPerformance(performanceYear, performanceMonth, creId);
    else setPerformance(null);
  }

  async function openPerformance() {
    setActiveView('Performance');
    const now = new Date();
    setPerformanceYear(now.getFullYear());
    setPerformanceMonth(now.getMonth() + 1);
    if (currentRole === 'CCM') {
      let teamFreeServiceCres = freeServiceCres;
      if (allocationCres.length === 0 || freeServiceCres.length === 0) {
        try {
          const teamsResponse = await api.get('/teams');
          setAllocationCres(teamsResponse.data.cres || []);
          teamFreeServiceCres = teamsResponse.data.freeServiceCres || [];
          setFreeServiceCres(teamFreeServiceCres);
        } catch (error) {
          setPerformanceError(error.response?.data?.message || 'Could not load your CRE team.');
        }
      }
      if (performanceCreId) {
        await loadPerformance(
          now.getFullYear(),
          now.getMonth() + 1,
          performanceCreId,
          teamFreeServiceCres.some((user) => user.id === performanceCreId),
        );
      }
      else setPerformance(null);
      return;
    }
    await loadPerformance(now.getFullYear(), now.getMonth() + 1, '');
  }

  async function changeFollowUpStatus(followUpId, status) {
    setFollowUpError('');
    try {
      await api.patch(`/follow-ups/${followUpId}/status`, { status });
      setFollowUps((current) => current.filter((followUp) => followUp.id !== followUpId));
    } catch (error) {
      setFollowUpError(error.response?.data?.message || 'Could not update follow-up.');
    }
  }

  async function openAppointments() {
    setActiveView('Appointments');
    setAppointmentsLoading(true);
    setAppointmentError('');
    try {
      const requests = [api.get('/appointments')];
      if (currentRole !== 'FREE_SERVICE_CRE') requests.push(api.get('/customers'));
      const [appointmentResponse, customerResponse] = await Promise.all(requests);
      setAppointments(appointmentResponse.data.appointments || []);
      setCustomers(customerResponse?.data?.customers || []);
    } catch (error) {
      setAppointmentError(error.response?.data?.message || 'Could not load appointments. Sign in and try again.');
    } finally {
      setAppointmentsLoading(false);
    }
  }

  async function openAllocations() {
    setActiveView('Allocations');
    setAllocationSearch('');
    setAllocationsLoading(true);
    setAllocationError('');
    setMasterListError('');
    try {
      const requests = [api.get('/call-list'), api.get('/customers')];
      if (['ADMIN', 'GM', 'CCM'].includes(String(currentUser?.role || '').toUpperCase())) requests.push(api.get('/teams'));
      const [recordsResponse, customerResponse, teamResponse] = await Promise.all(requests);
      setCalls(recordsResponse.data.records || []);
      setCustomers(customerResponse.data.customers || []);
      setAllocationCres(teamResponse?.data?.cres || []);
      setMasterListCcms(teamResponse?.data?.ccms || []);
    } catch (error) {
      setAllocationError(error.response?.data?.message || 'Could not load allocations. Sign in and try again.');
    } finally {
      setAllocationsLoading(false);
    }
  }

  async function submitAllocation(event) {
    event.preventDefault();
    setAllocationSaving(true);
    setAllocationError('');
    setAllocationMessage('');
    try {
      await api.post('/allocations', allocationForm);
      const recordsResponse = await api.get('/call-list');
      setCalls(recordsResponse.data.records || []);
      setAllocationForm({ vehicleId: '', creId: '', serviceType: '', category: '' });
      setAllocationFormOpen(false);
      setAllocationMessage('Vehicle assigned.');
    } catch (error) {
      setAllocationError(error.response?.data?.message || 'Could not assign vehicle. Check the details and try again.');
    } finally {
      setAllocationSaving(false);
    }
  }

  async function openImports() {
    setActiveView('Imports');
    setImportsLoading(true);
    setImportError('');
    try {
      const requests = [api.get('/imports/history')];
      if (['ADMIN', 'GM'].includes(String(currentUser?.role || '').toUpperCase())) {
        requests.push(api.get('/teams'));
      }
      const [response, teamsResponse] = await Promise.all(requests);
      setImports(response.data.imports || []);
      if (teamsResponse) {
        const ccms = teamsResponse.data.ccms || [];
        setMasterListCcms(ccms);
        if (!ccms.some((ccm) => ccm.ccmId === importCcmId)) setImportCcmId(ccms.length === 1 ? ccms[0].ccmId : '');
      } else {
        setImportCcmId(currentUser?.ccmId || '');
      }
    } catch (error) {
      setImportError(error.response?.data?.message || 'Could not load import history. Sign in and try again.');
    } finally {
      setImportsLoading(false);
    }
  }

  async function submitImport(event) {
    event.preventDefault();
    if (!importFile) {
      setImportError('Choose a CSV file to import.');
      return;
    }
    if (importFile.size > 1_800_000) {
      setImportError('CSV file must be smaller than 1.8 MB.');
      return;
    }

    setImportUploading(true);
    setImportError('');
    setImportMessage('');
    setImportResult(null);
    try {
      const response = await api.post('/imports/repair-orders', {
        fileName: importFile.name,
        content: await importFile.text(),
        ccmId: importCcmId || undefined,
      }, {
        headers: { 'Idempotency-Key': importRequestKeyRef.current || (importRequestKeyRef.current = window.crypto.randomUUID()) },
      });
      setImportResult(response.data);
      setImportFile(null);
      importRequestKeyRef.current = null;
      const history = await api.get('/imports/history');
      setImports(history.data.imports || []);
      const callListResponse = await api.get('/call-list');
      setCalls(callListResponse.data.records || []);
    } catch (error) {
      setImportError(error.response?.data?.message || 'Import failed. Review the file and try again.');
    } finally {
      setImportUploading(false);
    }
  }

  async function rollbackImport(batch) {
    if (!batch || importRollbackSaving) return;
    setImportRollbackSaving(true);
    setImportRollbackError('');
    setImportMessage('');
    let rollbackCommitted = false;
    try {
      const response = await api.delete(`/imports/${encodeURIComponent(batch.id)}`);
      rollbackCommitted = response.data.status === 'rolled_back';
      if (!rollbackCommitted) throw new Error('The server did not confirm the rollback.');
      importRequestKeyRef.current = null;
      setImportRollbackBatch(null);
      setImportMessage(`Import ${batch.fileName} was rolled back successfully. Reversed ${response.data.reversedChanges} recorded changes.`);
      const [historyResponse, callListResponse, customersResponse] = await Promise.all([
        api.get('/imports/history'),
        api.get('/call-list'),
        api.get('/customers'),
      ]);
      setImports(historyResponse.data.imports || []);
      setCalls(callListResponse.data.records || []);
      setCustomers(customersResponse.data.customers || []);
      await refreshDashboardSummary();
    } catch (error) {
      const message = error.response?.data?.message || 'Could not refresh data after rollback.';
      if (rollbackCommitted) {
        setImportMessage(`Rollback committed, but some interface data could not refresh: ${message}`);
      } else {
        setImportRollbackError(message);
      }
    } finally {
      setImportRollbackSaving(false);
    }
  }

  async function recoverImport(batch) {
    if (!batch || importRecoverySaving) return;
    setImportRecoverySaving(true);
    setImportError('');
    setImportMessage('');
    try {
      const response = await api.post(`/imports/${encodeURIComponent(batch.id)}/recover`);
      await openImports();
      setImportMessage(response.data.message);
    } catch (error) {
      const message = error.response?.data?.message || 'Could not recover this import.';
      await openImports();
      setImportError(message);
    } finally {
      setImportRecoverySaving(false);
    }
  }

  function downloadImportTemplate() {
    const headers = [
      'S NO', 'Repair Order No', 'R/O Date', 'Closing Date', 'G.P Date', 'Work Type',
      'Status', 'Service Advisor', 'Vehicle VIN', 'Reg No', 'Model', 'Mileage',
      'Sale Dealer', 'Sale Date', 'UC Sale Dealer', 'UC Sale Date', 'Customer Name',
      'Address', 'E-mail', 'City', 'PIN', 'Mobile', 'Office', 'Tech.',
      'Special Msg.', 'Visit Type', 'Demands',
    ];
    const file = new Blob([`${headers.join(',')}\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'repair-orders-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  function getMasterDetailLabel(key) {
    return masterCsvLabels[key] || key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/^./, (character) => character.toUpperCase());
  }

  async function submitAppointment(event) {
    event.preventDefault();
    setAppointmentSaving(true);
    setAppointmentError('');
    setAppointmentMessage('');
    try {
      const response = await api.post('/appointments', {
        ...(currentRole === 'FREE_SERVICE_CRE'
          ? { customerName: appointmentForm.customerName, vehicleName: appointmentForm.vehicleName || undefined }
          : { customerId: appointmentForm.customerId }),
        vehicleId: appointmentForm.vehicleId || undefined,
        scheduledAt: new Date(appointmentForm.scheduledAt).toISOString(),
      });
      const created = response.data.appointment;
      setAppointments((current) => [...current, {
        id: created.id,
        customer: created.customer?.fullName || created.customerName,
        customerId: created.customerId,
        vehicle: created.vehicle?.model || created.vehicleName,
        vehicleId: created.vehicleId,
        scheduledAt: created.scheduledAt,
        date: new Date(created.scheduledAt).toISOString().slice(0, 10),
        time: new Date(created.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: created.status,
        confirmationCall: created.confirmationCall,
      }].sort((left, right) => new Date(left.scheduledAt) - new Date(right.scheduledAt)));
      setAppointmentForm({ customerId: '', vehicleId: '', customerName: '', vehicleName: '', scheduledAt: '' });
      setAppointmentFormOpen(false);
      setAppointmentMessage('Appointment booked.');
    } catch (error) {
      setAppointmentError(error.response?.data?.message || 'Could not book appointment. Check the details and try again.');
    } finally {
      setAppointmentSaving(false);
    }
  }

  async function changeAppointmentStatus(appointmentId, status) {
    setAppointmentError('');
    try {
      await api.patch(`/appointments/${appointmentId}`, { status });
      setAppointments((current) => current.map((appointment) =>
        appointment.id === appointmentId ? { ...appointment, status } : appointment,
      ));
    } catch (error) {
      setAppointmentError(error.response?.data?.message || 'Could not update appointment status.');
    }
  }

  function updateCustomerField(field, value) {
    setCustomerForm((current) => ({ ...current, [field]: value }));
  }

  function updateVehicleField(index, field, value) {
    setCustomerForm((current) => ({
      ...current,
      vehicles: current.vehicles.map((vehicle, vehicleIndex) =>
        vehicleIndex === index ? { ...vehicle, [field]: value } : vehicle,
      ),
    }));
  }

  async function submitCustomer(event) {
    event.preventDefault();
    setCustomerSaving(true);
    setCustomerError('');
    setCustomerMessage('');

    const payload = {
      fullName: customerForm.fullName,
      mobileNumber: customerForm.mobileNumber || undefined,
      email: customerForm.email || undefined,
      ccmId: customerForm.ccmId || undefined,
      vehicles: customerForm.vehicles
        .filter((vehicle) => vehicle.vin.trim())
        .map((vehicle) => ({
          vin: vehicle.vin,
          registrationNumber: vehicle.registrationNumber || undefined,
          model: vehicle.model || undefined,
          year: vehicle.year || undefined,
        })),
    };

    try {
      const response = await api.post('/customers', payload);
      const created = response.data.customer;
      setCustomers((current) => [{
        ...created,
        name: created.fullName,
        mobile: created.mobileNumber,
        vehicleCount: created.vehicles?.length || 0,
      }, ...current]);
      setCustomerForm({
        fullName: '',
        mobileNumber: '',
        email: '',
        ccmId: '',
        vehicles: [{ vin: '', registrationNumber: '', model: '', year: '' }],
      });
      setCustomerFormOpen(false);
      setCustomerMessage('Customer record created.');
    } catch (error) {
      setCustomerError(error.response?.data?.message || 'Could not create customer. Check the details and try again.');
    } finally {
      setCustomerSaving(false);
    }
  }

  const canCreateCustomer = ['ADMIN', 'GM', 'CCM'].includes(String(currentUser?.role || '').toUpperCase());
  const canImport = canCreateCustomer;
  const allocationVehicles = customers.flatMap((customer) => (customer.vehicles || []).map((vehicle) => ({
    ...vehicle,
    customerName: customer.name || customer.fullName,
    customerCcmId: customer.ccmId,
  })));
  const selectedAllocationVehicle = allocationVehicles.find((vehicle) => vehicle.id === allocationForm.vehicleId);
  const allocationTeamId = selectedAllocationVehicle?.ccmId || selectedAllocationVehicle?.customerCcmId;
  const currentRole = String(currentUser?.role || '').toUpperCase();
  const canAccessFreeService = currentRole !== 'CRE' || currentUser?.freeServiceEnabled === true;
  const canAccessWarranty = currentRole !== 'CRE' || currentUser?.warrantyEnabled === true;
  const viewingFreeServicePerformance = currentRole === 'FREE_SERVICE_CRE' || freeServiceCres.some((user) => user.id === performanceCreId);
  useEffect(() => {
    if (currentRole !== 'CRE' || !currentUser?.id) return undefined;

    let active = true;
    const refreshServicePermissions = async () => {
      try {
        const response = await api.get('/auth/me');
        if (!active || response.data.user?.id !== currentUser.id) return;
        setCurrentUser((user) => user?.id === currentUser.id
          ? {
            ...user,
            freeServiceEnabled: response.data.user.freeServiceEnabled === true,
            warrantyEnabled: response.data.user.warrantyEnabled === true,
          }
          : user);
        const freeServiceEnabled = response.data.user.freeServiceEnabled === true;
        const warrantyEnabled = response.data.user.warrantyEnabled === true;
        if ((activeView === 'Free Service' && !freeServiceEnabled)
          || (activeView === 'Follow-up Free Service' && !freeServiceEnabled)
          || (activeView === 'Warranty' && !warrantyEnabled)
          || (activeView === 'Follow-up Warranty' && !warrantyEnabled)) {
          navigate(routeByView.Dashboard, { replace: true });
          setDueRecords([]);
          setFollowUps([]);
          setFollowUpListRecords([]);
        }
      } catch (error) {
        if (error.response?.status !== 401) console.error('Failed to refresh CRE permissions.', error);
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshServicePermissions();
    };
    const intervalId = window.setInterval(refreshServicePermissions, 30000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [currentRole, currentUser?.id, activeView, navigate]);

  useEffect(() => {
    userSavingRef.current = userSaving;
  }, [userSaving]);

  useEffect(() => () => {
    if (userFormCloseTimerRef.current) window.clearTimeout(userFormCloseTimerRef.current);
  }, []);

  useEffect(() => {
    if (!userFormOpen) return undefined;

    previousUserFormFocusRef.current = document.activeElement;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    userFormCloseButtonRef.current?.focus();

    function handleDialogKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!userSavingRef.current) closeUserForm();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...(userFormDialogRef.current?.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ) || [])].filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) {
        event.preventDefault();
        userFormDialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      document.removeEventListener('keydown', handleDialogKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      previousUserFormFocusRef.current?.focus?.();
    };
  }, [userFormOpen]);

  useEffect(() => {
    if (!importRollbackBatch) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !importRollbackSaving) setImportRollbackBatch(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [importRollbackBatch, importRollbackSaving]);

  const visibleDueViews = Object.fromEntries(Object.entries(dueViews).filter(([view]) => (
    (view !== 'Free Service' || canAccessFreeService) && (view !== 'Warranty' || canAccessWarranty)
  )));
  const visibleFollowUpViews = Object.fromEntries(Object.entries(followUpViews).filter(([view]) => (
    (view !== 'Follow-up Free Service' || canAccessFreeService) && (view !== 'Follow-up Warranty' || canAccessWarranty)
  )));
  const selectedMasterRecord = calls.find((record) => record.id === selectedMasterRecordId);
  const masterRecords = masterListTeam ? calls.filter((record) => record.ccmId === masterListTeam) : calls;
  const wpCres = masterListCres.filter((cre) => !wpCcmId || cre.ccmId === wpCcmId);
  const wpMaxDaily = Math.max(1, ...(wpData?.daily || []).map((entry) => Math.max(entry.calls, entry.appointments)));
  const wpMaxOutcome = Math.max(1, ...(wpData?.outcomes || []).map((entry) => entry.count));
  const wpMaxBreakdown = Math.max(1, ...(wpData?.breakdown || []).map((entry) => entry.calls));
  const wpNow = new Date();
  const wpYears = [wpNow.getFullYear(), wpNow.getFullYear() - 1, wpNow.getFullYear() - 2];
  const visibleNavItems = [
    ...(currentRole === 'FREE_SERVICE_CRE'
      ? ['Dashboard', 'Import', 'Customer', 'Follow-up', 'Appointments', 'Performance']
      : currentRole === 'CRE'
      ? ['Dashboard', 'Master list', ...navItems.filter((item) => !['Dashboard', 'Allocations', 'Imports', 'Reports'].includes(item)), 'Performance']
      : currentRole === 'CCM'
        ? ['Dashboard', 'Master list', ...navItems.filter((item) => !['Dashboard', 'Reports'].includes(item)), 'Performance', 'Workshop Performance']
        : ['ADMIN', 'GM'].includes(currentRole)
          ? navItems.filter((item) => !['Customers', 'Follow-ups', 'Appointments', ...(currentRole === 'GM' ? ['Allocations'] : [])].includes(item)).flatMap((item) => item === 'Reports' ? [item, 'Workshop Performance'] : [item])
          : navItems.filter((item) => item !== 'Reports')),
    ...(currentRole === 'ADMIN' ? ['User Management'] : []),
  ];
  const panelCustomer = customers.find((customer) => customer.id === customerPanel.customerId);
  const isTeamRole = currentRole === 'CRE' || currentRole === 'CCM';
  const isFreeServiceRole = currentRole === 'FREE_SERVICE_CRE';
  // Sidebar entries that expand into sub-pages; the parent only toggles, the children navigate.
  const navAccordions = {
    ...(isFreeServiceRole ? {
      Customer: {
        open: customersMenuOpen,
        toggle: () => setCustomersMenuOpen((open) => !open),
        items: [{
          view: 'Free-Service Customer',
          label: 'Free Service',
          icon: Gift,
          open: () => setFreeServiceCustomerMenuOpen((open) => !open),
          expanded: freeServiceCustomerMenuOpen,
          children: ['2 Months', '1 Year', '2 Years'].map((label) => ({
            view: `Free-Service Customer · ${label}`,
            label,
            open: () => setActiveView(`Free-Service Customer · ${label}`),
          })),
        }],
      },
      'Follow-up': {
        open: followUpMenuOpen,
        toggle: () => setFollowUpMenuOpen((open) => !open),
        items: [{
          view: 'Free-Service Follow-up',
          label: 'Free Service',
          icon: Gift,
          open: () => setFreeServiceFollowUpMenuOpen((open) => !open),
          expanded: freeServiceFollowUpMenuOpen,
          children: ['2 Months', '1 Year', '2 Years'].map((label) => ({
            view: `Free-Service Follow-up · ${label}`,
            label,
            open: () => setActiveView(`Free-Service Follow-up · ${label}`),
          })),
        }],
      },
    } : {}),
    ...(isTeamRole ? {
      Customers: {
        open: customersMenuOpen,
        toggle: () => setCustomersMenuOpen((open) => !open),
        items: Object.entries(visibleDueViews).map(([view, config]) => ({ view, label: config.label, icon: config.icon, open: () => openDueList(view) })),
      },
      'Follow-ups': {
        open: followUpMenuOpen,
        toggle: () => setFollowUpMenuOpen((open) => !open),
        items: Object.entries(visibleFollowUpViews).map(([view, config]) => ({ view, label: config.label, icon: config.icon, open: () => openFollowUpList(view) })),
      },
    } : {}),
    ...(currentRole === 'CCM' ? {
      Performance: {
        open: performanceMenuOpen,
        toggle: () => setPerformanceMenuOpen((open) => !open),
        items: [
          { view: 'Performance', label: 'Individual Performance', icon: Activity, open: openPerformance },
          { view: 'Performance Board', label: 'Performance Board', icon: BarChart3, open: openPerformanceBoard },
        ],
      },
    } : {}),
  };
  const dueSearchTerm = dueSearch.trim().toLowerCase();
  const visibleDueRecords = dueSearchTerm
    ? dueRecords.filter((record) => [record.name, record.mobile, record.vin, record.model, record.registrationNumber, record.milestoneName].some((value) => String(value || '').toLowerCase().includes(dueSearchTerm)))
    : dueRecords;
  const allocationSearchTerm = allocationSearch.trim().toLowerCase();
  const allocationRecords = currentRole === 'CCM' ? masterRecords.filter((record) => Boolean(record.assigneeId)) : masterRecords;
  const visibleAllocationRecords = allocationSearchTerm
    ? allocationRecords.filter((record) => [record.type, record.dueDate, record.name, record.mobile, record.model, record.vin, record.registrationNumber, record.status, record.assigneeName]
      .some((value) => String(value || '').toLowerCase().includes(allocationSearchTerm)))
    : allocationRecords;
  const followUpSearchTerm = followUpSearch.trim().toLowerCase();
  const activeFollowUpSource = followUpViews[activeView]?.source;
  const followUpServiceKind = activeFollowUpSource === 'FREE_SERVICE' ? 'free' : activeFollowUpSource === 'WARRANTY' ? 'warranty' : null;
  const followUpTableRecords = followUpServiceKind ? followUps.map((followUp) => {
    const sourceRecord = (followUp.vehicleId && followUpListRecords.find((entry) => entry.vehicleId === followUp.vehicleId))
      || (followUp.vehicleId && calls.find((entry) => entry.vehicleId === followUp.vehicleId))
      || followUpListRecords.find((entry) => entry.customerId === followUp.customer.id)
      || calls.find((entry) => entry.customerId === followUp.customer.id);
    const fallbackExpiry = sourceRecord?.saleDate ? new Date(sourceRecord.saleDate) : null;
    if (fallbackExpiry && !Number.isNaN(fallbackExpiry.getTime())) fallbackExpiry.setFullYear(fallbackExpiry.getFullYear() + 3);
    const expiry = sourceRecord?.warrantyExpiryDate || (fallbackExpiry && !Number.isNaN(fallbackExpiry.getTime()) ? fallbackExpiry : null);
    const fallbackWindowStart = expiry ? new Date(expiry.getFullYear(), expiry.getMonth() - 1, 1) : null;
    const fallbackWindowEnd = expiry ? new Date(expiry.getFullYear(), expiry.getMonth(), 0) : null;
    return {
      ...sourceRecord,
      id: followUp.id,
      followUpId: followUp.id,
      recordId: sourceRecord?.recordId || sourceRecord?.id,
      customerId: followUp.customer.id,
      vehicleId: followUp.vehicleId || sourceRecord?.vehicleId,
      name: followUp.customer.fullName || sourceRecord?.name,
      mobile: followUp.customer.mobileNumber || sourceRecord?.mobile,
      model: followUp.vehicle?.model || sourceRecord?.model,
      registrationNumber: followUp.vehicle?.registrationNumber || sourceRecord?.registrationNumber,
      vin: followUp.vehicle?.vin || sourceRecord?.vin,
      milestoneName: sourceRecord?.milestoneName || (followUp.milestone?.milestone ? `${['', 'First', 'Second', 'Third'][followUp.milestone.milestone]} free service` : 'Free service'),
      dueDate: followUp.milestone?.dueDate || sourceRecord?.dueDate,
      warrantyExpiryDate: expiry,
      callingWindow: sourceRecord?.callingWindow || (fallbackWindowStart ? { start: fallbackWindowStart, end: fallbackWindowEnd } : null),
      contactStatus: sourceRecord?.contactStatus || 'Not contacted',
      callStatus: sourceRecord?.callStatus || (sourceRecord?.lastCall ? 'Called' : 'Not called'),
      assigneeName: sourceRecord?.assigneeName || followUp.cre?.name || null,
      followUp: { id: followUp.id, followUpAt: followUp.followUpAt },
      callSource: followUp.source,
    };
  }) : [];
  const visibleFollowUpTableRecords = followUpSearchTerm
    ? followUpTableRecords.filter((record) => [record.name, record.mobile, record.vin, record.model, record.registrationNumber, record.milestoneName, record.assigneeName]
      .some((value) => String(value || '').toLowerCase().includes(followUpSearchTerm)))
    : followUpTableRecords;
  const weekDays = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return {
      key: localDateKey(date),
      weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
      label: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    };
  });
  const dayAppointments = appointments.filter((appointment) => localDateKey(appointment.scheduledAt) === selectedDay);
  const userTree = buildUserTree(managedUsers);

  function renderAssigneeSelect(record, recordId, loading) {
    return (
      <select
        className="status-select master-list-assignee"
        aria-label={`Allocated CRE for ${record.name || record.customerName}`}
        value={record.assigneeId || ''}
        disabled={masterListSavingId === recordId || loading}
        onChange={(event) => changeMasterListAssignee(recordId, event.target.value)}
      >
        {record.assigneeId && !allocationCres.some((cre) => cre.id === record.assigneeId) && (
          <option value={record.assigneeId}>{record.assigneeName || 'Former CRE'} (inactive)</option>
        )}
        {allocationCres.filter((cre) => cre.ccmId === record.ccmId).map((cre) => (
          <option key={cre.id} value={cre.id}>{cre.name}</option>
        ))}
      </select>
    );
  }

  // Free Service and Warranty lists. CREs get a call icon; CCMs see/assign the allocated CRE.
  function renderServiceListTable(kind, records = visibleDueRecords, followUpQueue = false) {
    const isFree = kind === 'free';
    const lastColumn = currentRole === 'CCM' ? 'Allocated CRE' : 'Call';
    const columnCount = 11;
    return (
      <div className="table-scroll">
        <table className="master-call-list-table service-list-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Number</th>
              <th>Regd no.</th>
              <th>VIN</th>
              <th>Sale date</th>
              {isFree ? (
                <>
                  <th>Milestone</th>
                  <th>Due date</th>
                  <th>Calling from</th>
                  <th>Call status</th>
                </>
              ) : (
                <>
                  <th>Warranty expiry</th>
                  <th>Calling month</th>
                  <th>Previous call</th>
                  <th>Contact status</th>
                </>
              )}
              <th>Follow-up</th>
              <th>{lastColumn}</th>
              {followUpQueue && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td><button type="button" className="text-link" onClick={() => openDueCustomer(record, 'profile')}>{record.name || '—'}</button></td>
                <td>{record.mobile || '—'}</td>
                <td>{record.registrationNumber || '—'}</td>
                <td>{record.vin || '—'}</td>
                <td>{formatDate(record.saleDate)}</td>
                {isFree ? (
                  <>
                    <td>{record.milestoneName}</td>
                    <td>{formatDate(record.dueDate)}</td>
                    <td>{formatDate(record.callingStartDate)}</td>
                    <td>{record.lastCall ? `${formatDate(record.lastCall.createdAt)} · ${formatOutcome(record.lastCall.outcome)}` : record.callStatus}</td>
                  </>
                ) : (
                  <>
                    <td>{formatDate(record.warrantyExpiryDate)}</td>
                    <td>{record.callingWindow?.start ? new Date(record.callingWindow.start).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : '—'}</td>
                    <td>{record.lastCall ? `${formatDate(record.lastCall.createdAt)} · ${formatOutcome(record.lastCall.outcome)}` : '—'}</td>
                    <td><span className={`badge ${record.contactStatus === 'Contacted' ? 'badge-blue' : 'badge-neutral'}`}>{record.contactStatus}</span></td>
                  </>
                )}
                <td>{record.followUp ? `Scheduled ${new Date(record.followUp.followUpAt).toLocaleString()}` : '—'}</td>
                <td>
                  {currentRole === 'CCM' ? record.assigneeName || 'Unassigned' : (
                    <button type="button" className="icon-btn call-icon-btn" aria-label={`Call ${record.name}`} title="Call customer" disabled={!record.customerId} onClick={() => openDueCustomer({ ...record, callSource: isFree ? 'FREE_SERVICE' : 'WARRANTY' }, 'call')}>
                      <PhoneCall size={17} aria-hidden="true" />
                    </button>
                  )}
                </td>
                {followUpQueue && <td>
                  <div className="inline-actions">
                    <button type="button" className="outline-btn compact-btn" onClick={() => changeFollowUpStatus(record.followUpId, 'completed')}>Complete</button>
                    <button type="button" className="outline-btn compact-btn" onClick={() => changeFollowUpStatus(record.followUpId, 'cancelled')}>Cancel</button>
                  </div>
                </td>}
              </tr>
            ))}
            {!dueLoading && records.length === 0 && (
              <tr><td colSpan={columnCount + (followUpQueue ? 1 : 0)} className="empty-state">{followUpQueue ? `No ${isFree ? 'free service' : 'warranty'} follow-ups scheduled.` : isFree ? 'No free-service customers are ready to call.' : 'No warranties are in their calling month.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  function renderMasterRepairTypeBadge(type) {
    const presentation = getMasterRepairTypePresentation(type);
    return (
      <span className={`repair-type-badge ${presentation.className}`} title={type || 'Others'}>
        {presentation.short}
      </span>
    );
  }

  function renderMasterRepairTypeLegend() {
    return (
      <div className="repair-type-legend" aria-label="Repair type color legend">
        <span className="repair-type-legend-title">Repair types:</span>
        {MASTER_REPAIR_TYPE_ORDER.map((type) => {
          const presentation = getMasterRepairTypePresentation(type);
          return (
            <span className="repair-type-legend-item" key={type}>
              <span className={`repair-type-dot ${presentation.className}`} aria-hidden="true" />
              <span><strong>{presentation.short}</strong> {type}</span>
            </span>
          );
        })}
      </div>
    );
  }

  function renderMasterCallTable(records, loading, { assignable = false, showDetails = false } = {}) {
    const showCallColumn = currentRole === 'CRE' && activeView === 'Master list' && !assignable;
    return (
      <div className="master-list-table-wrap">
        {renderMasterRepairTypeLegend()}
        <div className="table-scroll">
          <table className="master-call-list-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Due</th>
                <th>Name</th>
                <th>Number</th>
                <th>Model name</th>
                <th>VIN</th>
                <th>Veh age</th>
                <th>Regd no.</th>
                <th>Status</th>
                <th>Scheduled apt</th>
                <th>{showCallColumn ? 'Call' : 'Allocated CRE'}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>{renderMasterRepairTypeBadge(record.type)}</td>
                  <td className={record.dueDate && new Date(record.dueDate) < new Date() ? 'due-overdue' : undefined}>{record.dueDate ? new Date(record.dueDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—'}</td>
                  <td>{showDetails ? (
                    <button
                      type="button"
                      className="text-link"
                      aria-expanded={selectedMasterRecordId === record.id}
                      onClick={() => setSelectedMasterRecordId((selectedId) => selectedId === record.id ? null : record.id)}
                    >{record.name || record.customerName || '—'}</button>
                  ) : record.name || record.customerName || '—'}</td>
                  <td>{record.mobile || '—'}</td>
                  <td>{record.model || '—'}</td>
                  <td>{record.vin || '—'}</td>
                  <td>{formatVehicleAge(record.vehicleAgeMonths)}</td>
                  <td>{record.registrationNumber || '—'}</td>
                  <td><span className="badge badge-neutral">{record.status || 'pending'}</span></td>
                  <td>{record.scheduledAppointment ? new Date(record.scheduledAppointment.scheduledAt).toLocaleString() : '—'}</td>
                  <td>{assignable ? renderAssigneeSelect(record, record.id, loading) : showCallColumn ? (
                    <button
                      type="button"
                      className="icon-btn call-icon-btn"
                      aria-label={`Call ${record.name || record.customerName || 'customer'}`}
                      title={record.assigneeId === currentUser?.id ? 'Call customer' : 'This customer is not assigned to you'}
                      disabled={loading || !record.customerId || record.assigneeId !== currentUser?.id}
                      onClick={() => startCallFromMasterRecord(record)}
                    >
                      <PhoneCall size={17} aria-hidden="true" />
                    </button>
                  ) : record.assigneeName || 'Unassigned'}</td>
                </tr>
              ))}
              {!loading && records.length === 0 && <tr><td colSpan="11" className="empty-state">No master call list records found.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  useEffect(() => {
    routeActionsRef.current = {
      Dashboard: openDashboard,
      Customers: openCustomers,
      Appointments: openAppointments,
      Allocations: openAllocations,
      Imports: openImports,
      Reports: openReports,
      'Master list': openMasterList,
      Performance: openPerformance,
      'Performance Board': openPerformanceBoard,
      'User Management': openUserManagement,
      'Due 1-Year': () => openDueList('Due 1-Year'),
      'Due 6-Month': () => openDueList('Due 6-Month'),
      'Free Service': () => openDueList('Free Service'),
      Warranty: () => openDueList('Warranty'),
      'Follow-up Service': () => openFollowUpList('Follow-up Service'),
      'Follow-up Free Service': () => openFollowUpList('Follow-up Free Service'),
      'Follow-up Warranty': () => openFollowUpList('Follow-up Warranty'),
      CcmProfile: (ccmId) => {
        if (currentRole === 'CCM') {
          openOwnMonthlyData();
        } else if (ccmId) {
          const ccm = managedTeams.ccms.find((team) => team.ccmId === ccmId);
          openCcmProfile(ccm || { ccmId, name: `CCM ${ccmId}` });
        }
      },
    };
  });

  useEffect(() => {
    if (!authChecked) return;
    if (!currentUser) {
      if (location.pathname !== '/login') navigate('/login', { replace: true });
      return;
    }

    const route = resolveRoute(location.pathname);
    const canonicalPath = pathForView(route.view, route.ccmId);
    if (location.pathname === '/' || location.pathname === '/login' || canonicalPath !== location.pathname) {
      navigate(route.view === 'CcmProfile' && !route.ccmId ? '/dashboard' : canonicalPath, { replace: true });
      return;
    }
    if (!canAccessRoute(route.view, currentRole, currentUser, route.ccmId)) {
      navigate(routeByView.Dashboard, { replace: true });
      return;
    }
    const routeKey = `${location.key}:${route.view}`;
    if (navigationType === 'POP'
      && (route.view !== 'Dashboard' || location.key !== 'default')
      && lastLoadedRouteKeyRef.current !== routeKey) {
      lastLoadedRouteKeyRef.current = routeKey;
      routeActionsRef.current[route.view]?.(route.ccmId);
    }
  }, [
    authChecked,
    currentRole,
    currentUser,
    location.key,
    location.pathname,
    navigate,
    navigationType,
  ]);

  if (!authChecked) {
    return <main className="auth-loading" aria-live="polite">Checking session…</main>;
  }

  if (!currentUser) {
    return (
      <main className="auth-shell">
        <section className="auth-brand-panel">
          <img className="brand-mark" src="/favicon.png" alt="Lakshmi Hyundai logo" />
          <p className="eyebrow">Workshop CRM</p>
          <h1>Lakshmi Hyundai</h1>
          <p className="auth-caption">Service operations</p>
        </section>
        <form className="auth-form" onSubmit={submitLogin}>
          <p className="eyebrow">Team access</p>
          <h2>Sign in</h2>
          <p className="auth-intro">Enter your credentials to access your service workspace.</p>
          {loginError && <p className="form-alert error" role="alert">{loginError}</p>}
          <label>Username<input required autoComplete="username" value={loginForm.username} onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value.toLowerCase() })} /></label>
          <label>Password<input required type="password" autoComplete="current-password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} /></label>
          <button type="submit" className="primary-btn" disabled={loginBusy}>{loginBusy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <img className="brand-mark" src="/favicon.png" alt="Lakshmi Hyundai logo" />
          <div>
            <p className="eyebrow">Workshop CRM</p>
            <h1>Lakshmi Hyundai</h1>
          </div>
        </div>

        <nav className="nav-list" aria-label="Sidebar navigation">
          {visibleNavItems.map((item) => {
            const NavIcon = navIcons[item];
            const accordion = navAccordions[item];
            const accordionOpen = Boolean(accordion) && accordion.open;
            return (
              <Fragment key={item}>
              <button
                type="button"
                title={item}
                aria-current={item === activeView && !accordion ? 'page' : undefined}
                aria-expanded={accordion ? accordionOpen : undefined}
                onClick={() => accordion ? accordion.toggle() : item === 'Dashboard' ? openDashboard() : item === 'Import' ? setActiveView('Free-Service Import') : item === 'Master list' ? openMasterList() : item === 'Customers' ? openCustomers() : item === 'Appointments' ? openAppointments() : item === 'Allocations' ? openAllocations() : item === 'Imports' ? openImports() : item === 'User Management' ? openUserManagement() : item === 'Monthly Data' ? openOwnMonthlyData() : item === 'Performance' ? openPerformance() : item === 'Reports' ? openReports() : setActiveView(item)}
                className={item === activeView && !accordion ? 'nav-item active' : 'nav-item'}
              >
                <NavIcon size={18} strokeWidth={1.8} aria-hidden="true" />
                <span>{item}</span>
                {accordion && <ChevronDown className={accordionOpen ? 'nav-chevron open' : 'nav-chevron'} size={15} aria-hidden="true" />}
              </button>
              {accordionOpen && accordion.items.map((child) => {
                const SubIcon = child.icon;
                return (
                  <Fragment key={child.view}>
                    <button
                      type="button"
                      title={child.label}
                      aria-current={child.view === activeView ? 'page' : undefined}
                      aria-expanded={child.children ? child.expanded : undefined}
                      onClick={child.open}
                      className={child.view === activeView ? 'nav-item nav-subitem active' : 'nav-item nav-subitem'}
                    >
                      <SubIcon size={16} strokeWidth={1.8} aria-hidden="true" />
                      <span>{child.label}</span>
                      {child.children && <ChevronDown className={child.expanded ? 'nav-chevron open' : 'nav-chevron'} size={15} aria-hidden="true" />}
                    </button>
                    {child.expanded && child.children?.map((nested) => (
                      <button
                        key={nested.view}
                        type="button"
                        title={nested.label}
                        aria-current={nested.view === activeView ? 'page' : undefined}
                        onClick={nested.open}
                        className={nested.view === activeView ? 'nav-item nav-subitem nav-subitem-nested active' : 'nav-item nav-subitem nav-subitem-nested'}
                      >
                        <span>{nested.label}</span>
                      </button>
                    ))}
                  </Fragment>
                );
              })}
              </Fragment>
            );
          })}
          <button type="button" className="nav-item nav-signout" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={18} strokeWidth={1.8} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </nav>

        <div className="sidebar-card">
          <p className="eyebrow">Signed in</p>
          <strong>{currentUser.name}</strong>
          <span>{currentRole === 'FREE_SERVICE_CRE' ? 'Free-Service CRE' : currentUser.role} · {currentUser.username}</span>
          <button type="button" className="outline-btn" onClick={signOut}>Sign out</button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeView === 'Free-Service Import' ? 'Free Service' : activeView.startsWith('Free-Service Customer') ? 'Free-Service customers' : activeView.startsWith('Free-Service Follow-up') ? 'Free-Service follow-up' : activeView in dueViews ? 'Service follow-up' : activeView in followUpViews ? 'Next actions' : activeView === 'Performance Board' ? 'Team activity' : activeView === 'User Management' ? 'Administration' : activeView === 'CcmProfile' ? 'CCM profile' : activeView === 'Master list' ? 'Customer follow-up' : activeView === 'Customers' ? 'Customer records' : activeView === 'Follow-ups' ? 'Next actions' : activeView === 'Appointments' ? 'Workshop schedule' : activeView === 'Allocations' ? 'CRE workload' : activeView === 'Imports' ? 'Repair orders' : activeView === 'Performance' ? 'Your activity' : activeView === 'Reports' ? 'CRM activity' : activeView === 'Workshop Performance' ? 'Service analytics' : 'Overview'}</p>
            <h2>{activeView === 'Free-Service Import' ? 'Import' : activeView.startsWith('Free-Service Customer') ? activeView.replace('Free-Service Customer · ', '') : activeView.startsWith('Free-Service Follow-up') ? `Follow-up · ${activeView.replace('Free-Service Follow-up · ', '')}` : activeView in dueViews ? dueViews[activeView].label : activeView in followUpViews ? `Follow-ups · ${followUpViews[activeView].label}` : activeView === 'Performance Board' ? 'Performance Board' : activeView === 'User Management' ? 'User Management' : activeView === 'CcmProfile' ? selectedCcm?.name || 'Monthly Customer Data' : activeView === 'Master list' ? 'Master call list' : activeView === 'Customers' ? 'Customers and vehicles' : activeView === 'Follow-ups' ? 'Follow-up queue' : activeView === 'Appointments' ? 'Appointments' : activeView === 'Allocations' ? 'Vehicle allocations' : activeView === 'Imports' ? 'Repair-order imports' : activeView === 'Performance' ? 'Performance' : activeView === 'Reports' ? 'Reports' : activeView === 'Workshop Performance' ? 'Workshop Performance' : 'Service operations dashboard'}</h2>
          </div>
          {activeView === 'User Management' ? (
            <button type="button" className="primary-btn" onClick={() => startUserEdit()}><Plus size={16} aria-hidden="true" />New Account</button>
          ) : activeView === 'CcmProfile' ? (
            <button type="button" className="outline-btn" onClick={() => setActiveView(currentRole === 'ADMIN' ? 'User Management' : 'Dashboard')}><ArrowLeft size={16} aria-hidden="true" />{currentRole === 'ADMIN' ? 'Users' : 'Dashboard'}</button>
          ) : activeView in followUpViews ? (
            <span className="live-indicator">{followUpsLoading ? 'Loading…' : `${followUps.length} pending`}</span>
          ) : activeView === 'Allocations' ? (
            ['ADMIN', 'GM'].includes(String(currentUser?.role || '').toUpperCase()) && <button type="button" className="primary-btn" onClick={() => { setAllocationFormOpen((open) => !open); setAllocationMessage(''); setAllocationError(''); }}>
              <ClipboardList size={17} aria-hidden="true" />
              {allocationFormOpen ? 'Close form' : 'Assign vehicle'}
            </button>
          ) : activeView === 'Imports' ? (
            canImport && <button type="button" className="outline-btn" onClick={downloadImportTemplate}>
              <Download size={16} aria-hidden="true" /> CSV template
            </button>
          ) : activeView === 'Appointments' ? (
            <button type="button" className="primary-btn" onClick={() => { setAppointmentFormOpen((open) => !open); setAppointmentMessage(''); setAppointmentError(''); }}>
              <CalendarPlus2 size={17} aria-hidden="true" />
              {appointmentFormOpen ? 'Close form' : 'New appointment'}
            </button>
          ) : activeView === 'Customers' ? (
            canCreateCustomer && <button type="button" className="primary-btn" onClick={() => { setCustomerFormOpen((open) => !open); setCustomerMessage(''); setCustomerError(''); }}>
              <UserRoundPlus size={17} aria-hidden="true" />
              {customerFormOpen ? 'Close form' : 'New customer'}
            </button>
          ) : activeView in dueViews ? (
            <span className="live-indicator">{dueLoading ? 'Loading…' : `${dueRecords.length} customers`}</span>
          ) : activeView === 'Dashboard' ? (
            <span className="header-date"><CalendarDays size={16} aria-hidden="true" />{new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}{loading ? ' · Updating…' : ''}</span>
          ) : activeView === 'Performance Board' ? (
            <div className="header-actions performance-period-picker">
              <label className="inline-filter">Day
                <input type="date" value={boardDate} max={new Date().toLocaleDateString('en-CA')} onChange={(event) => event.target.value && loadBoard(event.target.value)} />
              </label>
              <span className="live-indicator">{boardLoading ? 'Updating…' : ''}</span>
            </div>
          ) : activeView === 'Performance' ? (
            <div className="header-actions performance-period-picker">
              {currentRole === 'CCM' && (
                <select aria-label="Select CRE" value={performanceCreId} onChange={(event) => changePerformanceCre(event.target.value)}>
                  <option value="">Select CRE</option>
                  <optgroup label="Regular CRE">
                    {allocationCres.map((cre) => <option key={cre.id} value={cre.id}>{cre.name}</option>)}
                  </optgroup>
                  <optgroup label="Free-Service CRE">
                    {freeServiceCres.map((cre) => <option key={cre.id} value={cre.id}>{cre.name} · Free-Service CRE</option>)}
                  </optgroup>
                </select>
              )}
              <select aria-label="Month" value={performanceMonth} onChange={(event) => changePerformancePeriod(performanceYear, Number(event.target.value))}>
                {monthOptions.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
              </select>
              <select aria-label="Year" value={performanceYear} onChange={(event) => changePerformancePeriod(Number(event.target.value), performanceMonth)}>
                {Array.from({ length: 5 }, (_, index) => new Date().getFullYear() - index).map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
              <span className="live-indicator">{performanceLoading ? 'Updating…' : ''}</span>
            </div>
          ) : activeView === 'Workshop Performance' && ['ADMIN', 'GM', 'CCM'].includes(currentRole) ? (
            <div className="header-actions">
              <button
                type="button"
                className="outline-btn export-pdf-btn"
                disabled={exportingPdf}
                onClick={exportWorkshopPerformancePdf}
              >
                <Download size={16} aria-hidden="true" />
                {exportingPdf ? 'Generating PDF…' : 'Export PDF'}
              </button>
            </div>
          ) : activeView === 'Reports' && ['ADMIN', 'GM'].includes(currentRole) ? (
            <div className="header-actions">
              <button
                type="button"
                className="outline-btn export-pdf-btn"
                disabled={exportingPdf}
                onClick={exportReportsPdf}
              >
                <Download size={16} aria-hidden="true" />
                {exportingPdf ? 'Generating PDF…' : 'Export PDF'}
              </button>
            </div>
          ) : activeView === 'Master list' ? (
            <button
              type="button"
              className="primary-btn"
              onClick={() => {
                setMasterEntryFormOpen((open) => !open);
                setMasterListError('');
                setMasterListMessage('');
              }}
            >
              <UserRoundPlus size={16} aria-hidden="true" />
              {masterEntryFormOpen ? 'Close form' : 'Add customer'}
            </button>
          ) : (
            <div className="header-actions">
              <span className="live-indicator">{currentUser.dealerCode || currentUser.role}</span>
            </div>
          )}
        </header>

        {activeView === 'User Management' ? (
          <section className="customer-workspace">
            {!userFormOpen && managedUsersError && <p className="form-alert error" role="alert">{managedUsersError}</p>}
            {managedUsersMessage && <p className="form-alert success" role="status">{managedUsersMessage}</p>}
            {userFormOpen && (
              <div
                className={`user-modal-backdrop${userFormClosing ? ' is-closing' : ''}`}
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget && !userSaving) closeUserForm();
                }}
              >
                <section
                  className="user-modal-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="user-form-dialog-title"
                  aria-describedby="user-form-dialog-description"
                  tabIndex={-1}
                  ref={userFormDialogRef}
                >
                  <form className="user-modal-form" onSubmit={submitManagedUser}>
                    <header className="user-modal-header">
                      <div>
                        <h3 id="user-form-dialog-title">{editingUserId ? 'Edit User' : 'Create New Account'}</h3>
                        <p id="user-form-dialog-description">Admin, GM, CCM, CRE, and Free-Service CRE accounts</p>
                      </div>
                      <button
                        ref={userFormCloseButtonRef}
                        type="button"
                        className="user-modal-close"
                        aria-label="Close user form"
                        title="Close"
                        disabled={userSaving}
                        onClick={() => closeUserForm()}
                      >
                        <X size={19} aria-hidden="true" />
                      </button>
                    </header>
                    {managedUsersError && <p className="form-alert error user-modal-error" role="alert">{managedUsersError}</p>}
                    <fieldset className="user-modal-fields" disabled={userSaving}>
                      <div className="form-grid">
                  <label>Full name<input required maxLength="200" value={userForm.name} onChange={(event) => setUserForm({ ...userForm, name: event.target.value })} /></label>
                  <label>Username<input required minLength="3" maxLength="40" autoComplete="off" name="managed-username" value={userForm.username} onChange={(event) => setUserForm({ ...userForm, username: event.target.value.toLowerCase().replace(/[^a-z0-9@._-]/g, '') })} /></label>
                  <label>Password<input required={!editingUserId} minLength="8" type="password" autoComplete="new-password" name="managed-password" readOnly={!passwordUnlocked} onFocus={() => setPasswordUnlocked(true)} value={userForm.password} onChange={(event) => setUserForm({ ...userForm, password: event.target.value })} placeholder={editingUserId ? 'Leave empty to keep current password' : 'At least 8 characters'} /></label>
                  <label><span>Phone no. <span className="field-optional">(Optional)</span></span><input inputMode="tel" value={userForm.phone} onChange={(event) => setUserForm({ ...userForm, phone: event.target.value })} /></label>
                  <label>Role<select value={userForm.role} onChange={(event) => setUserForm({ ...userForm, role: event.target.value, ccmId: '', gmId: '' })}><option value="ADMIN">ADMIN</option><option value="GM">GM</option><option value="CCM">CCM</option><option value="CRE">CRE</option><option value="FREE_SERVICE_CRE">Free-Service CRE</option></select></label>
                  <label>Dealer code<input value={userForm.dealerCode} onChange={(event) => setUserForm({ ...userForm, dealerCode: event.target.value })} /></label>
                  {userForm.role === 'CCM' && <label>GM team<select required value={userForm.gmId} onChange={(event) => setUserForm({ ...userForm, gmId: event.target.value })}><option value="">Select GM</option>{managedTeams.gms.map((gm) => <option key={gm.id} value={gm.id}>{gm.name}{gm.dealerCode ? ` · ${gm.dealerCode}` : ''}</option>)}</select></label>}
                  {['CRE', 'FREE_SERVICE_CRE'].includes(userForm.role) && <label>CCM team<select required value={userForm.ccmId} onChange={(event) => setUserForm({ ...userForm, ccmId: event.target.value })}><option value="">Select CCM</option>{managedTeams.ccms.map((ccm) => <option key={ccm.id} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}</select></label>}
                  {userForm.role === 'CRE' && (
                    <fieldset className="full-width-field service-permissions">
                      <legend>Service list access</legend>
                      <div className="service-permission-toggle">
                        <span>Free Service</span>
                        <button type="button" role="switch" aria-checked={userForm.freeServiceEnabled} aria-label="Free Service access" className={`permission-switch ${userForm.freeServiceEnabled ? 'is-on' : ''}`} onClick={() => setUserForm((current) => ({ ...current, freeServiceEnabled: !current.freeServiceEnabled }))}>
                          <span />
                        </button>
                      </div>
                      <div className="service-permission-toggle">
                        <span>Warranty</span>
                        <button type="button" role="switch" aria-checked={userForm.warrantyEnabled} aria-label="Warranty access" className={`permission-switch ${userForm.warrantyEnabled ? 'is-on' : ''}`} onClick={() => setUserForm((current) => ({ ...current, warrantyEnabled: !current.warrantyEnabled }))}>
                          <span />
                        </button>
                      </div>
                    </fieldset>
                  )}
                      </div>
                    </fieldset>
                    <div className="form-actions user-modal-actions">
                      <button type="button" className="outline-btn" disabled={userSaving} onClick={() => closeUserForm()}>Cancel</button>
                      <button type="submit" className="primary-btn" disabled={userSaving}>
                        <Save size={16} aria-hidden="true" />
                        {userSaving ? 'Saving…' : editingUserId ? 'Save account' : 'Create account'}
                      </button>
                    </div>
                  </form>
                </section>
              </div>
            )}
            <section className="panel customer-list-panel">
              <div className="panel-header"><h3>Managed accounts</h3><span>{managedUsersLoading ? 'Loading…' : `${managedUsers.length} accounts`}</span></div>
              <div className="table-scroll"><table><thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Role</th><th>Dealer code</th><th>Reports to</th><th>Status</th><th>Actions</th></tr></thead><tbody>
                {userTree.map(({ user, depth }) => <tr key={user.id} className={`user-row depth-${depth}`}>
                  <td><span className="user-name-cell">{depth > 0 && <span className="tree-branch" aria-hidden="true">└</span>}{user.role === 'CCM' ? <button type="button" className="text-link" onClick={() => openCcmProfile(user)}>{user.name}</button> : user.name}</span></td>
                  <td>{user.username}</td><td>{user.phone || '—'}</td><td>{user.role === 'FREE_SERVICE_CRE' ? 'Free-Service CRE' : user.role}</td><td>{user.dealerCode || '—'}</td>
                  <td>{user.role === 'CCM' ? managedTeams.gms.find((gm) => gm.id === user.gmId)?.name || '—' : ['CRE', 'FREE_SERVICE_CRE'].includes(user.role) ? managedTeams.ccms.find((ccm) => ccm.ccmId === user.ccmId)?.name || '—' : '—'}</td>
                  <td><span className={`badge ${user.status === 'active' ? 'badge-blue' : 'badge-neutral'}`}>{user.status}</span></td>
                  <td><div className="inline-actions"><button type="button" className="outline-btn compact-btn" onClick={() => startUserEdit(user)}>Edit</button>{!(currentRole === 'ADMIN' && user.id === currentUser.id) && <><button type="button" className="outline-btn compact-btn" onClick={() => toggleManagedUserStatus(user)}>{user.status === 'active' ? 'Deactivate' : 'Activate'}</button><button type="button" className="danger-outline-btn compact-btn" onClick={() => deleteManagedAccount(user)}>Delete</button></>}</div></td>
                </tr>)}
                {!managedUsersLoading && managedUsers.length === 0 && <tr><td colSpan="8" className="empty-state">No managed accounts found.</td></tr>}
              </tbody></table></div>
            </section>
          </section>
        ) : activeView === 'CcmProfile' ? (
          <section className="customer-workspace">
            {monthlyError && <p className="form-alert error" role="alert">{monthlyError}</p>}
            {monthlyMessage && <p className="form-alert success" role="status">{monthlyMessage}</p>}
            {ccmProfile && <section className="stats-grid profile-stats">
              {[['CCM', ccmProfile.ccm.name], ['Customers', ccmProfile.customerCount], ['Vehicles', ccmProfile.vehicleCount], ['Saved months', ccmProfile.monthlyDatasets.length]].map(([label, value]) => <article key={label} className="stat-card"><p>{label}</p><strong>{value}</strong></article>)}
            </section>}
            <section className="panel customer-list-panel">
              <div className="panel-header"><h3>Monthly Customer Data</h3><span>{monthlyLoading ? 'Loading…' : `${monthlyEntries.length} records`}</span></div>
              <div className="period-controls">
                <label>Month<select value={monthlyMonth} onChange={(event) => changeMonthlyPeriod(monthlyYear, Number(event.target.value))}>{monthOptions.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label>
                <label>Year<select value={monthlyYear} onChange={(event) => changeMonthlyPeriod(Number(event.target.value), monthlyMonth)}>{Array.from({ length: 7 }, (_, index) => new Date().getFullYear() - 5 + index).map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
              </div>
              <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Mobile</th><th>VIN</th><th>Vehicle</th><th>Service</th><th>Last visit</th><th>Next due</th><th>Source</th></tr></thead><tbody>
                {monthlyEntries.map((entry) => <tr key={entry.id}><td>{entry.customerName}</td><td>{entry.mobileNumber}</td><td>{entry.vin || '—'}</td><td>{[entry.model, entry.registrationNumber].filter(Boolean).join(' / ') || '—'}</td><td>{entry.serviceType || '—'}</td><td>{entry.lastVisitDate ? new Date(entry.lastVisitDate).toLocaleDateString() : '—'}</td><td>{entry.nextServiceDueDate ? new Date(entry.nextServiceDueDate).toLocaleDateString() : '—'}</td><td>{entry.source}</td></tr>)}
                {!monthlyLoading && monthlyEntries.length === 0 && <tr><td colSpan="8" className="empty-state">No customer data for this month yet.</td></tr>}
              </tbody></table></div>
            </section>
            <form className="panel customer-form" onSubmit={submitMonthlyEntry}>
              <div className="panel-header"><h3>Manual entry</h3><span>Added to {monthOptions[monthlyMonth - 1]} {monthlyYear}</span></div>
              <div className="form-grid">
                <label>Customer name<input required maxLength="200" value={monthlyForm.customerName} onChange={(event) => setMonthlyForm({ ...monthlyForm, customerName: event.target.value })} /></label>
                <label>Mobile number<input required inputMode="tel" value={monthlyForm.mobileNumber} onChange={(event) => setMonthlyForm({ ...monthlyForm, mobileNumber: event.target.value })} /></label>
                <label>Email<input type="email" value={monthlyForm.email} onChange={(event) => setMonthlyForm({ ...monthlyForm, email: event.target.value })} /></label>
                <label>VIN<input value={monthlyForm.vin} onChange={(event) => setMonthlyForm({ ...monthlyForm, vin: event.target.value })} /></label>
                <label>Registration<input value={monthlyForm.registrationNumber} onChange={(event) => setMonthlyForm({ ...monthlyForm, registrationNumber: event.target.value })} /></label>
                <label>Model<input value={monthlyForm.model} onChange={(event) => setMonthlyForm({ ...monthlyForm, model: event.target.value })} /></label>
                <label>Vehicle year<input type="number" min="1950" max={new Date().getFullYear() + 1} value={monthlyForm.vehicleYear} onChange={(event) => setMonthlyForm({ ...monthlyForm, vehicleYear: event.target.value })} /></label>
                <label>Service type<input value={monthlyForm.serviceType} onChange={(event) => setMonthlyForm({ ...monthlyForm, serviceType: event.target.value })} /></label>
                <label>Last visit<input type="date" value={monthlyForm.lastVisitDate} onChange={(event) => setMonthlyForm({ ...monthlyForm, lastVisitDate: event.target.value })} /></label>
                <label>Next service due<input type="date" value={monthlyForm.nextServiceDueDate} onChange={(event) => setMonthlyForm({ ...monthlyForm, nextServiceDueDate: event.target.value })} /></label>
                <label className="full-width-field">Notes<textarea rows="2" maxLength="2000" value={monthlyForm.notes} onChange={(event) => setMonthlyForm({ ...monthlyForm, notes: event.target.value })} /></label>
              </div>
              <div className="form-actions"><button type="submit" className="primary-btn" disabled={monthlyBusy}><Save size={16} aria-hidden="true" />{monthlyBusy ? 'Saving…' : 'Add to month'}</button></div>
            </form>
            <form className="panel import-form" onSubmit={previewMonthlyImport}>
              <div className="panel-header"><h3>CSV / Excel import</h3><span>CSV or XLSX, up to 7 MB</span></div>
              <p className="import-columns">Required columns: Customer Name and Mobile. Optional: Email, VIN, Registration, Make, Model, Year, Service Type, Last Visit Date, Next Service Due Date, Notes.</p>
              <div className="upload-row"><label className="file-picker"><FileUp size={18} aria-hidden="true" /><span>{monthlyFile?.name || 'Choose CSV or XLSX file'}</span><input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setMonthlyFile(event.target.files?.[0] || null); setMonthlyPreview(null); }} /></label><button type="submit" className="outline-btn" disabled={!monthlyFile || monthlyBusy}>{monthlyBusy ? 'Validating…' : 'Preview import'}</button></div>
              {monthlyPreview && <div className="monthly-preview">
                <div className="import-counts"><div><span>Total</span><strong>{monthlyPreview.totalRows}</strong></div><div><span>Ready</span><strong>{monthlyPreview.addedRows}</strong></div><div><span>Duplicates</span><strong>{monthlyPreview.skippedRows}</strong></div><div><span>Invalid</span><strong>{monthlyPreview.rejectedRows}</strong></div></div>
                <div className="table-scroll"><table><thead><tr><th>Row</th><th>Customer</th><th>Mobile</th><th>VIN</th><th>Result</th><th>Validation</th></tr></thead><tbody>{monthlyPreview.rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.row.customerName || '—'}</td><td>{row.row.mobileNumber || '—'}</td><td>{row.row.vin || '—'}</td><td>{row.status}</td><td>{row.error || 'Ready to import'}</td></tr>)}</tbody></table></div>
                <div className="form-actions"><button type="button" className="primary-btn" disabled={monthlyBusy || monthlyPreview.addedRows === 0} onClick={commitMonthlyImport}>{monthlyBusy ? 'Importing…' : `Import ${monthlyPreview.addedRows} rows`}</button></div>
              </div>}
            </form>
            <section className="panel customer-list-panel">
              <div className="panel-header"><h3>Import history</h3><span>{monthlyImports.length} files this month</span></div>
              <div className="table-scroll"><table><thead><tr><th>File</th><th>Imported by</th><th>Date</th><th>Total</th><th>Added</th><th>Skipped</th><th>Rejected</th><th>State</th></tr></thead><tbody>
                {monthlyImports.map((item) => <tr key={item.id}><td>{item.fileName}{item.rowErrors?.length > 0 && <details className="row-error-details"><summary>{item.rowErrors.length} row issues</summary><ImportErrors errors={item.rowErrors.map((error) => ({ ...error, status: error.errorCode === 'DUPLICATE' ? 'skipped' : 'rejected' }))} /></details>}</td><td>{item.importedBy?.name || 'Deleted account'}</td><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.totalRows}</td><td>{item.addedRows}</td><td>{item.skippedRows}</td><td>{item.rejectedRows}</td><td>{item.status}</td></tr>)}
                {!monthlyLoading && monthlyImports.length === 0 && <tr><td colSpan="8" className="empty-state">No imports for this month.</td></tr>}
              </tbody></table></div>
            </section>
          </section>
        ) : activeView === 'Performance Board' ? (
          <section className="customer-workspace" aria-busy={boardLoading}>
            {boardError && <p className="form-alert error" role="alert">{boardError}</p>}
            <section className="panel customer-list-panel">
              <div className="panel-header">
                <h3>Daily quota · {board?.date ? formatDate(`${board.date}T12:00:00`) : '—'}</h3>
                <span>{boardLoading ? 'Loading…' : `${board?.rows?.length ?? 0} CREs`}</span>
              </div>
              <div className="table-scroll">
                <table className="performance-board-table">
                  <thead>
                    <tr>
                      <th>CRE</th>
                      <th>{dailyTargetLabels.callsMade}</th>
                      <th>{dailyTargetLabels.callsPickedUp}</th>
                      <th>Calls-made target</th>
                      <th>Calls-picked-up target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(board?.rows || []).map((row) => (
                      <tr key={row.creId}>
                        <td>{row.creName}</td>
                        <td>{row.callsMade} / {row.callsMadeTarget}</td>
                        <td>{row.callsPickedUp} / {row.callsPickedUpTarget}</td>
                        <td><span className={`badge ${row.callsMadeMet ? 'badge-blue' : 'badge-danger'}`}>{row.callsMadeMet ? 'Target met' : `${row.callsMadeShortfall} short`}</span></td>
                        <td><span className={`badge ${row.callsPickedUpMet ? 'badge-blue' : 'badge-danger'}`}>{row.callsPickedUpMet ? 'Target met' : `${row.callsPickedUpShortfall} short`}</span></td>
                      </tr>
                    ))}
                    {!boardLoading && (board?.rows || []).length === 0 && <tr><td colSpan="5" className="empty-state">No active CREs report to you yet.</td></tr>}
                  </tbody>
                </table>
              </div>
              <p className="performance-note">Warranty calls are not counted. A call is picked up when the customer answered.</p>
            </section>
          </section>
        ) : activeView === 'Performance' ? (
          <section className="performance-workspace" aria-busy={performanceLoading}>
            {performanceError && <p className="form-alert error" role="alert">{performanceError}</p>}
            {currentRole === 'CCM' && !performanceCreId ? (
              <p className="form-alert info" role="status">Select a CRE above to view their performance.</p>
            ) : viewingFreeServicePerformance ? (
              <>
                <section className="performance-kpis" aria-label="Free-Service CRE performance metrics">
                  {[
                    ['Calls made today', performance?.dailyTargets?.callsMade, 120],
                    ['Pickups achieved today', performance?.dailyTargets?.callsPickedUp, 80],
                  ].map(([label, metric, target]) => {
                    const actual = metric?.actual ?? 0;
                    const percent = Math.min(100, Math.round((actual / target) * 100));
                    return <article key={label} className="performance-kpi teal">
                      <div className="performance-kpi-heading"><span>{label}</span><PhoneCall size={17} aria-hidden="true" /></div>
                      <strong>{actual} / {target}</strong>
                      <small>{percent}% of daily target</small>
                      <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
                    </article>;
                  })}
                  <article className="performance-kpi coral">
                    <div className="performance-kpi-heading"><span>Calls this month</span><Activity size={17} aria-hidden="true" /></div>
                    <strong>{performance?.callsThisMonth ?? 0}</strong>
                    <small>Persisted Free-Service call activity</small>
                  </article>
                </section>
                <section className="panel customer-list-panel">
                  <div className="panel-header"><h3>Historical daily activity</h3><span>{monthOptions[performanceMonth - 1]} {performanceYear}</span></div>
                  <div className="table-scroll"><table><thead><tr><th>Date</th><th>Calls made</th><th>Pickups achieved</th></tr></thead><tbody>
                    {(performance?.dailyPerformance || []).map((entry) => <tr key={entry.date}><td>{formatDate(`${entry.date}T12:00:00`)}</td><td>{entry.callsMade}</td><td>{entry.callsPickedUp}</td></tr>)}
                    {!performanceLoading && !(performance?.dailyPerformance || []).length && <tr><td colSpan="3" className="empty-state">No Free-Service call activity is recorded for this month.</td></tr>}
                  </tbody></table></div>
                </section>
              </>
            ) : (
            <>
            <section className="performance-kpis" aria-label="Performance metrics">
              {[
                { label: 'Calls made today', value: performance?.dailyTargets ? `${performance.dailyTargets.callsMade.actual} / ${performance.dailyTargets.callsMade.target}` : performance ? 'N/A' : '—', detail: performance?.dailyTargets ? (performance.dailyTargets.callsMade.actual >= performance.dailyTargets.callsMade.target ? 'Daily target met' : `${performance.dailyTargets.callsMade.target - performance.dailyTargets.callsMade.actual} short of today's target`) : 'Shown for the current day only', icon: PhoneCall, tone: 'coral' },
                { label: 'Calls picked up today', value: performance?.dailyTargets ? `${performance.dailyTargets.callsPickedUp.actual} / ${performance.dailyTargets.callsPickedUp.target}` : performance ? 'N/A' : '—', detail: performance?.dailyTargets ? (performance.dailyTargets.callsPickedUp.actual >= performance.dailyTargets.callsPickedUp.target ? 'Daily target met' : `${performance.dailyTargets.callsPickedUp.target - performance.dailyTargets.callsPickedUp.actual} short of today's target`) : 'Shown for the current day only', icon: PhoneCall, tone: 'teal' },
                { label: 'Calls this month', value: performance?.callsThisMonth ?? '—', detail: 'Since latest monthly-data load', icon: Activity, tone: 'teal' },
                ...(currentRole === 'CRE' ? [{
                  label: 'Appointment Conversion Rate',
                  value: performance?.appointmentConversionRatePercent == null ? '—' : `${performance.appointmentConversionRatePercent}%`,
                  detail: performance
                    ? `${performance.lifetimeAppointments} appointments from ${performance.lifetimeCalls} calls ever logged`
                    : 'Lifetime totals',
                  icon: CalendarCheck,
                  tone: 'green',
                }] : []),
                { label: 'Assigned customers', value: performance?.assignedCustomerCount ?? '—', detail: performance?.assignedBreakdown ? [
                  `${performance.assignedBreakdown.oneYear} 1-year`,
                  `${performance.assignedBreakdown.sixMonth} 6-month`,
                  ...(performance.assignedBreakdown.freeService == null ? [] : [`${performance.assignedBreakdown.freeService} free service`]),
                ].join(' · ') : `1-Year, 6-Month${canAccessFreeService ? ' and Free Service' : ''}`, icon: UsersRound, tone: 'gold' },
                { label: 'Follow-ups pending', value: performance?.pendingFollowUps ?? '—', detail: 'Still needing action', icon: Clock3, tone: 'green' },
                { label: 'Due services', value: performance?.dueServicesCount ?? '—', detail: 'Overdue on the master call list now', icon: CalendarClock, tone: 'coral' },
                ...(canAccessWarranty ? [{ label: 'Missed warranty customers', value: performance?.missedWarrantyCount ?? '—', detail: 'Warranty lapsed this month with no contact', icon: ShieldCheck, tone: 'gold' }] : []),
              ].map(({ label, value, detail, icon: MetricIcon, tone }) => (
                <article key={label} className={`performance-kpi ${tone}`}>
                  <div className="performance-kpi-heading"><span>{label}</span><MetricIcon size={17} aria-hidden="true" /></div>
                  <strong>{value}</strong>
                  <small>{detail}</small>
                </article>
              ))}
            </section>

            <section className="performance-detail-grid">
              <article className="panel reach-panel">
                <div className="panel-header"><h3>Customer reach this month</h3><span>{performance?.customerReachPercent ?? 0}%</span></div>
                <div className="reach-count"><strong>{performance?.customersReachedThisMonth ?? '—'}</strong><span>of {performance?.assignedCustomerCount ?? '—'} assigned customers called</span></div>
                <div className="progress-track" role="progressbar" aria-label="Assigned customers reached this month" aria-valuemin="0" aria-valuemax="100" aria-valuenow={performance?.customerReachPercent ?? 0}>
                  <span style={{ width: `${performance?.customerReachPercent ?? 0}%` }} />
                </div>
                <p className="performance-note">Each customer is counted once. This cycle starts with the latest monthly-data import that added customers, or on the first day of the month when there is no import yet.</p>
              </article>
              <article className="panel appointment-performance">
                <div className="panel-header"><h3>Appointments set</h3><CalendarDays size={18} aria-hidden="true" /></div>
                <strong>{performance?.appointmentsSetThisMonth ?? '—'}</strong>
                <span>from calls logged this month</span>
              </article>
            </section>

            <section className="panel customer-list-panel performance-activity">
              <div className="panel-header"><h3>Recent call activity</h3><span>{performanceLoading ? 'Loading…' : 'Latest 6'}</span></div>
              <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Vehicle</th><th>Outcome</th><th>When</th></tr></thead><tbody>
                {(performance?.recentCalls || []).map((call) => <tr key={call.id}>
                  <td>{call.customer?.fullName || 'Customer'}</td>
                  <td>{call.vehicle?.model || call.vehicle?.registrationNumber || call.vehicle?.vin || '—'}</td>
                  <td><span className="badge badge-neutral">{call.outcome.replaceAll('_', ' ')}</span></td>
                  <td>{new Date(call.createdAt).toLocaleString()}</td>
                </tr>)}
                {!performanceLoading && !performanceError && (performance?.recentCalls || []).length === 0 && <tr><td colSpan="4" className="empty-state">No calls logged yet.</td></tr>}
              </tbody></table></div>
            </section>
            </>
            )}
          </section>
        ) : activeView === 'Allocations' ? (
          <section className="customer-workspace">
            {allocationError && <p className="form-alert error" role="alert">{allocationError}</p>}
            {allocationMessage && <p className="form-alert success" role="status">{allocationMessage}</p>}
            {allocationFormOpen && ['ADMIN', 'GM'].includes(currentRole) && (
              <form className="panel customer-form" onSubmit={submitAllocation}>
                <div className="panel-header"><h3>Assign vehicle to CRE</h3><span>Assignments are limited to the vehicle&apos;s CCM team</span></div>
                <div className="form-grid">
                  <label>Vehicle
                    <select required value={allocationForm.vehicleId} onChange={(event) => setAllocationForm({ ...allocationForm, vehicleId: event.target.value })}>
                      <option value="">Choose vehicle</option>
                      {allocationVehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{[vehicle.customerName, vehicle.model, vehicle.registrationNumber || vehicle.vin].filter(Boolean).join(' · ')}</option>)}
                    </select>
                  </label>
                  <label>CRE
                    <select required value={allocationForm.creId} onChange={(event) => setAllocationForm({ ...allocationForm, creId: event.target.value })}>
                      <option value="">Choose CRE</option>
                      {allocationCres.filter((cre) => allocationTeamId ? cre.ccmId === allocationTeamId : currentUser.role !== 'CCM' || cre.ccmId === currentUser.ccmId).map((cre) => <option key={cre.id} value={cre.id}>{cre.name}</option>)}
                    </select>
                  </label>
                  <label>Service type<input required maxLength="100" value={allocationForm.serviceType} onChange={(event) => setAllocationForm({ ...allocationForm, serviceType: event.target.value })} placeholder="Periodic service" /></label>
                  <label>Category<input maxLength="100" value={allocationForm.category} onChange={(event) => setAllocationForm({ ...allocationForm, category: event.target.value })} placeholder="Due service" /></label>
                </div>
                <div className="form-actions"><button type="button" className="outline-btn" onClick={() => setAllocationFormOpen(false)}>Cancel</button><button type="submit" className="primary-btn" disabled={allocationSaving || !customers.some((customer) => customer.vehicles?.length) || allocationCres.length === 0}>{allocationSaving ? 'Assigning…' : 'Assign vehicle'}</button></div>
              </form>
            )}
            {masterListError && <p className="form-alert error" role="alert">{masterListError}</p>}
            <section className="panel customer-list-panel">
              <div className="panel-header">
                <h3>{currentRole === 'CCM' ? 'Allocated customers' : 'Allocation queue'}</h3>
                {['ADMIN', 'GM'].includes(currentRole) && (
                  <label className="inline-filter">Team
                    <select value={masterListTeam} onChange={(event) => setMasterListTeam(event.target.value)}>
                      <option value="">All teams</option>
                      {masterListCcms.map((ccm) => <option key={ccm.ccmId} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}
                    </select>
                  </label>
                )}
                <label className="inline-filter">Search
                  <input type="search" value={allocationSearch} placeholder="Name, number, VIN, model or reg. no." onChange={(event) => setAllocationSearch(event.target.value)} />
                </label>
                <span>{allocationsLoading ? 'Loading…' : `${visibleAllocationRecords.length} records`}</span>
              </div>
              {renderMasterCallTable(visibleAllocationRecords, allocationsLoading, { assignable: currentRole === 'CCM' })}
            </section>
          </section>
        ) : activeView === 'Reports' ? (
          <section className="customer-workspace">
            {wpError && <p className="form-alert error" role="alert">{wpError}</p>}
            <section className="panel wp-filters">
              <label>Month
                <select value={wpMonth} onChange={(event) => changeWorkshopFilter({ month: Number(event.target.value) })}>
                  {monthOptions.map((name, index) => <option key={name} value={index + 1} disabled={wpYear === wpNow.getFullYear() && index > wpNow.getMonth()}>{name}</option>)}
                </select>
              </label>
              <label>Year
                <select value={wpYear} onChange={(event) => {
                  const year = Number(event.target.value);
                  changeWorkshopFilter({ year, month: year === wpNow.getFullYear() ? Math.min(wpMonth, wpNow.getMonth() + 1) : wpMonth });
                }}>
                  {wpYears.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
              </label>
              <label>Team (CCM + CREs)
                <select value={wpCcmId} onChange={(event) => changeWorkshopFilter({ ccmId: event.target.value, creId: '' })}>
                  <option value="">All teams</option>
                  {masterListCcms.map((ccm) => <option key={ccm.ccmId} value={ccm.ccmId}>{ccm.name}</option>)}
                </select>
              </label>
              <label>Individual CRE
                <select value={wpCreId} onChange={(event) => changeWorkshopFilter({ creId: event.target.value })}>
                  <option value="">{wpCcmId ? 'Whole Team (All CREs)' : 'Whole workshop'}</option>
                  {wpCcmId && wpCres.length === 0 && <option disabled value="__none__">No CREs assigned to this CCM</option>}
                  {wpCres.map((cre) => <option key={cre.id} value={cre.id}>{cre.name}</option>)}
                </select>
              </label>
            </section>

            {wpData && (
              <>
                <p className="wp-scope">Showing <strong>{wpData.scope.name}</strong> · {monthOptions[wpData.period.month - 1]} {wpData.period.year}{wpLoading ? ' · Updating…' : ''}</p>
                <section className="stats-grid">
                  {[
                    ['Calls made', wpData.totals.calls],
                    ['Customers reached', wpData.totals.customersReached],
                    ['Appointments booked', wpData.totals.appointmentsBooked],
                    ['Call-to-appointment', `${wpData.totals.conversionPercent}%`],
                    ['Assigned records', wpData.totals.assignedRecords],
                    ['Reach of assigned', `${wpData.totals.reachPercent}%`],
                  ].map(([label, value]) => <article key={label} className="stat-card"><p>{label}</p><strong>{value}</strong></article>)}
                </section>

                <section className="panel">
                  <div className="panel-header"><h3>Daily activity</h3><span className="wp-legend"><i className="swatch calls" />Calls <i className="swatch appts" />Appointments</span></div>
                  <div className="wp-daily-chart" role="img" aria-label="Daily calls and appointments">
                    {wpData.daily.map((entry) => (
                      <div key={entry.date} className="wp-day" title={`${entry.date}: ${entry.calls} calls, ${entry.appointments} appointments`}>
                        <div className="wp-bars">
                          <span className="bar calls" style={{ height: `${(entry.calls / wpMaxDaily) * 100}%` }} />
                          <span className="bar appts" style={{ height: `${(entry.appointments / wpMaxDaily) * 100}%` }} />
                        </div>
                        <small>{Number(entry.date.slice(8))}</small>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="content-grid">
                  <article className="panel">
                    <div className="panel-header"><h3>Call outcomes</h3><span>{wpData.totals.calls} calls</span></div>
                    <div className="wp-hbars">
                      {wpData.outcomes.map((entry) => (
                        <div key={entry.outcome} className="wp-hbar">
                          <span>{entry.outcome.replaceAll('_', ' ')}</span>
                          <div className="track"><div className="fill" style={{ width: `${(entry.count / wpMaxOutcome) * 100}%` }} /></div>
                          <strong>{entry.count}</strong>
                        </div>
                      ))}
                      {wpData.outcomes.length === 0 && <p className="empty-state">No calls logged this month.</p>}
                    </div>
                  </article>

                  {wpData.breakdown.length > 0 && (
                    <article className="panel">
                      <div className="panel-header"><h3>{wpData.scope.type === 'all' ? 'Team comparison' : 'CCM and CRE comparison'}</h3><span>Calls this month</span></div>
                      <div className="wp-hbars">
                        {wpData.breakdown.map((entry) => (
                          <div key={entry.id} className="wp-hbar">
                            <span>{entry.name} <small>{entry.kind}</small></span>
                            <div className="track"><div className="fill alt" style={{ width: `${(entry.calls / wpMaxBreakdown) * 100}%` }} /></div>
                            <strong>{entry.calls}</strong>
                          </div>
                        ))}
                      </div>
                    </article>
                  )}
                </section>

                {wpData.breakdown.length > 0 && (
                  <section className="panel customer-list-panel">
                    <div className="panel-header"><h3>Detailed breakdown</h3><span>Select a team or CRE above to drill down</span></div>
                    <div className="table-scroll"><table><thead><tr><th>Name</th><th>Role</th><th>Calls</th><th>Customers reached</th><th>Appointments booked</th><th>Assigned</th><th>Reach</th></tr></thead><tbody>
                      {wpData.breakdown.map((entry) => <tr key={entry.id}><td>{entry.name}</td><td>{entry.kind}</td><td>{entry.calls}</td><td>{entry.customersReached}</td><td>{entry.appointmentsBooked}</td><td>{entry.assignedRecords}</td><td>{entry.reachPercent}%</td></tr>)}
                    </tbody></table></div>
                  </section>
                )}
              </>
            )}
          </section>
        ) : activeView === 'Workshop Performance' ? (
          <Suspense fallback={<p className="panel service-empty">Loading Workshop Performance…</p>}>
            <WorkshopServicePerformance role={currentRole} ccmId={currentUser?.ccmId} />
          </Suspense>
        ) : activeView === 'Free-Service Import' || activeView.startsWith('Free-Service Customer ·') || activeView.startsWith('Free-Service Follow-up ·') ? (
          <section className="customer-workspace">
            <section className="panel service-empty" role="status">
              <div className="panel-header"><h3>{activeView === 'Free-Service Import' ? 'Import is not available yet' : 'Free-Service customer workflow is not available yet'}</h3></div>
              <p>{activeView === 'Free-Service Import'
                ? 'This page is a placeholder. Customer file upload, processing, and allocation are not implemented.'
                : 'This category is a placeholder. Customer eligibility and customer lists will be added in a later phase.'}</p>
            </section>
          </section>
        ) : activeView === 'Imports' ? (
          <section className="customer-workspace">
            {importError && <p className="form-alert error" role="alert">{importError}</p>}
            {importMessage && <p className="form-alert success" role="status">{importMessage}</p>}
            {importResult && (
              <section className="panel import-result" role="status">
                <div className="panel-header"><h3>Import completed</h3><span>{importResult.batch.fileName}</span></div>
                <div className="import-counts">
                  {[['Rows', importResult.batch.totalRows], ['Created', importResult.batch.createdRows], ['Appended', importResult.batch.appendedRows], ['Skipped', importResult.batch.skippedRows], ['Rejected', importResult.batch.rejectedRows], ['Flagged', importResult.batch.flaggedRows]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
                </div>
                {importResult.errors.length > 0 && <ImportErrors errors={importResult.errors} />}
              </section>
            )}
            {canImport ? (
              <form className="panel import-form" onSubmit={submitImport}>
                <div className="panel-header"><h3>Upload repair orders</h3><span>CSV file, up to 1.8 MB</span></div>
                <p className="import-columns">Upload the service repair-order CSV. Required columns: Repair Order No, Vehicle VIN, Customer Name, and Mobile.</p>
                {currentRole !== 'CCM' && (
                  <label className="import-team-select">Import customer records under CCM
                    <select required disabled={importUploading} value={importCcmId} onChange={(event) => {
                      importRequestKeyRef.current = null;
                      setImportMessage('');
                      setImportCcmId(event.target.value);
                    }}>
                      <option value="">Select CCM team</option>
                      {masterListCcms.map((ccm) => <option key={ccm.ccmId} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}
                    </select>
                  </label>
                )}
                <div className="upload-row">
                  <label className="file-picker"><FileUp size={18} aria-hidden="true" /><span>{importFile?.name || 'Choose CSV file'}</span><input type="file" accept=".csv,text/csv" disabled={importUploading} onChange={(event) => {
                    importRequestKeyRef.current = null;
                    setImportMessage('');
                    setImportFile(event.target.files?.[0] || null);
                  }} /></label>
                  <button type="submit" className="primary-btn" disabled={!importFile || importUploading}>{importUploading ? 'Importing…' : 'Import file'}</button>
                </div>
              </form>
            ) : <p className="form-alert error">Import access is limited to Admin, GM, and CCM accounts.</p>}
            <section className="panel customer-list-panel">
              <div className="panel-header"><h3>Import history</h3><span>{importsLoading ? 'Loading…' : `${imports.length} batches`}</span></div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>File</th><th>Imported</th><th>Status</th><th>Row progress</th><th>Changed records</th><th>Created</th><th>Appended</th><th>Skipped</th><th>Rejected</th><th>Flagged</th>{currentRole === 'ADMIN' && <th>Rollback / recovery</th>}</tr></thead>
                  <tbody>
                    {imports.map((batch) => {
                      const changedRecords = (batch.affectedCustomers || 0)
                        + (batch.affectedVehicles || 0)
                        + (batch.affectedRepairOrders || 0)
                        + (batch.affectedCallListEntries || 0)
                        + (batch.affectedAllocations || 0);
                      const legacyStoredOutcomes = batch.rowOutcomesProvenance === 'legacy-stored-unverified';
                      const rowOutcomesAvailable = batch.statsComplete || legacyStoredOutcomes;
                      const rowOutcomeSuffix = legacyStoredOutcomes ? '†' : '';
                      return (
                        <tr key={batch.id}>
                          <td>{batch.fileName}{batch.rowErrors?.length > 0 && <details className="row-error-details"><summary>{batch.rowErrors.length} row issues</summary><ImportErrors errors={batch.rowErrors.map((row) => ({ ...row, status: row.errorCode.toLowerCase().includes('conflict') ? 'flagged' : row.errorCode.toLowerCase().includes('duplicate') ? 'skipped' : 'rejected' }))} /></details>}</td>
                          <td>{new Date(batch.createdAt).toLocaleString()}</td>
                          <td title={batch.recoveryBlockedReason || undefined}>{batch.status === 'rolled_back' ? 'Rolled back' : batch.status === 'completed' ? 'Completed' : batch.status}</td>
                          <td>{batch.processedRows == null ? `Unknown / ${batch.totalRows} (unverified)` : `${batch.processedRows} / ${batch.totalRows}${batch.statsComplete ? '' : legacyStoredOutcomes ? ' (legacy status; row details unverified)' : ' (partial)'}`}</td>
                          <td title={batch.affectedCountsComplete ? 'Distinct affected records verified from durable change logs.' : batch.processingStartedAt ? 'Distinct records currently represented in durable change logs; completeness is not verified.' : 'No verified change-log count is available for this historical import.'}>
                            {batch.processingStartedAt ? `${changedRecords}${batch.affectedCountsComplete ? '' : ' logged (partial)'}` : 'Unavailable'}
                          </td>
                          <td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.createdRows}${rowOutcomeSuffix}` : '—'}</td><td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.appendedRows}${rowOutcomeSuffix}` : '—'}</td><td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.skippedRows}${rowOutcomeSuffix}` : '—'}</td><td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.rejectedRows}${rowOutcomeSuffix}` : '—'}</td><td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.flaggedRows}${rowOutcomeSuffix}` : '—'}</td>
                          {currentRole === 'ADMIN' && <td>
                            {['completed', 'failed'].includes(batch.status) && batch.rollbackSupported ? (
                              <button type="button" className="outline-btn import-rollback-trigger" disabled={importRollbackSaving} onClick={() => {
                                setImportRollbackBatch(batch);
                                setImportRollbackError('');
                              }}>Roll back</button>
                            ) : batch.status === 'rolled_back' ? (
                              <span className="import-rollback-unavailable">Already rolled back</span>
                            ) : ['processing', 'failed'].includes(batch.status) && !batch.rollbackSupported ? (
                              <button type="button" className="outline-btn import-rollback-trigger" disabled={importRecoverySaving} onClick={() => recoverImport(batch)}>
                                {importRecoverySaving ? 'Checking…' : 'Recover'}
                              </button>
                            ) : batch.status === 'recovery_blocked' ? (
                              <span className="import-rollback-unavailable" title={batch.recoveryBlockedReason}>Blocked</span>
                            ) : (
                              <span className="import-rollback-unavailable" title="This batch has no verified snapshots or is not in a completed state.">Unavailable</span>
                            )}
                          </td>}
                        </tr>
                      );
                    })}
                    {!importsLoading && imports.length === 0 && <tr><td colSpan={currentRole === 'ADMIN' ? 11 : 10} className="empty-state">No imports recorded.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            {importRollbackBatch && (
              <div className="modal-backdrop" onMouseDown={(event) => {
                if (event.target === event.currentTarget && !importRollbackSaving) setImportRollbackBatch(null);
              }}>
                <section className="modal-card import-rollback-modal" role="dialog" aria-modal="true" aria-labelledby="import-rollback-title" aria-describedby="import-rollback-description">
                  <h3 id="import-rollback-title">Roll back repair-order import?</h3>
                  <p id="import-rollback-description">This will reverse only the recorded changes from this import. Any records that have changed since the import or have later dependencies will be preserved and block the rollback.</p>
                  <dl className="import-rollback-details">
                    <div><dt>File</dt><dd>{importRollbackBatch.fileName}</dd></div>
                    <div><dt>Batch ID</dt><dd>{importRollbackBatch.id}</dd></div>
                    <div><dt>Imported</dt><dd>{new Date(importRollbackBatch.createdAt).toLocaleString()}</dd></div>
                    <div><dt>Status</dt><dd>{importRollbackBatch.status}</dd></div>
                    <div><dt>Recorded changes</dt><dd>{importRollbackBatch._count?.changes ?? 'Unknown'}</dd></div>
                    <div><dt>Affected records</dt><dd>{importRollbackBatch.affectedCountsComplete ? <>
                      Customers {importRollbackBatch.affectedCustomers ?? 0}, Vehicles {importRollbackBatch.affectedVehicles ?? 0},
                      Repair orders {importRollbackBatch.affectedRepairOrders ?? 0}, Call list {importRollbackBatch.affectedCallListEntries ?? 0},
                      Allocations {importRollbackBatch.affectedAllocations ?? 0}
                    </> : 'Incomplete; recovery verification is required before rollback.'}</dd></div>
                  </dl>
                  <p className="modal-warning">This action cannot be undone. A rollback conflict will leave the import and its data unchanged.</p>
                  {importRollbackError && <p className="form-alert error" role="alert">{importRollbackError}</p>}
                  <div className="form-actions">
                    <button type="button" className="outline-btn" disabled={importRollbackSaving} onClick={() => setImportRollbackBatch(null)}>Cancel</button>
                    <button type="button" className="danger-btn" disabled={importRollbackSaving} onClick={() => rollbackImport(importRollbackBatch)}>{importRollbackSaving ? 'Rolling back…' : 'Confirm rollback'}</button>
                  </div>
                </section>
              </div>
            )}
          </section>
        ) : activeView === 'Appointments' ? (
          <section className="customer-workspace">
            {appointmentError && <p className="form-alert error" role="alert">{appointmentError}</p>}
            {appointmentMessage && <p className="form-alert success" role="status">{appointmentMessage}</p>}
            {appointmentFormOpen && (
              <form className="panel customer-form" onSubmit={submitAppointment}>
                <div className="panel-header"><h3>Book appointment</h3><span>{currentRole === 'FREE_SERVICE_CRE' ? 'Enter appointment details; no customer record will be created.' : 'Select a customer, vehicle, and service time'}</span></div>
                <div className="form-grid">
                  {currentRole === 'FREE_SERVICE_CRE' ? (
                    <>
                      <label>Customer name<input required maxLength="200" value={appointmentForm.customerName} onChange={(event) => setAppointmentForm({ ...appointmentForm, customerName: event.target.value })} /></label>
                      <label>Vehicle details<input maxLength="200" value={appointmentForm.vehicleName} onChange={(event) => setAppointmentForm({ ...appointmentForm, vehicleName: event.target.value })} placeholder="Optional" /></label>
                    </>
                  ) : <>
                  <label>Customer
                    <select required value={appointmentForm.customerId} onChange={(event) => setAppointmentForm({ ...appointmentForm, customerId: event.target.value, vehicleId: '' })}>
                      <option value="">Choose customer</option>
                      {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name || customer.fullName}</option>)}
                    </select>
                  </label>
                  <label>Vehicle
                    <select value={appointmentForm.vehicleId} onChange={(event) => setAppointmentForm({ ...appointmentForm, vehicleId: event.target.value })}>
                      <option value="">Vehicle to be confirmed</option>
                      {(customers.find((customer) => customer.id === appointmentForm.customerId)?.vehicles || []).map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{[vehicle.model, vehicle.registrationNumber, vehicle.vin].filter(Boolean).join(' / ')}</option>)}
                    </select>
                  </label>
                  </>}
                  <label>Date and time<input required type="datetime-local" value={appointmentForm.scheduledAt} onChange={(event) => setAppointmentForm({ ...appointmentForm, scheduledAt: event.target.value })} /></label>
                </div>
                <div className="form-actions">
                  <button type="button" className="outline-btn" onClick={() => setAppointmentFormOpen(false)}>Cancel</button>
                  <button type="submit" className="primary-btn" disabled={appointmentSaving || (currentRole !== 'FREE_SERVICE_CRE' && customers.length === 0)}>{appointmentSaving ? 'Booking…' : 'Book appointment'}</button>
                </div>
              </form>
            )}
            <section className="panel customer-list-panel">
              <div className="panel-header"><h3>Appointment schedule</h3><span>{appointmentsLoading ? 'Loading…' : `${dayAppointments.length} on selected day`}</span></div>
              <div className="day-strip" role="tablist" aria-label="Next seven days">
                {weekDays.map((day) => {
                  const count = appointments.filter((appointment) => localDateKey(appointment.scheduledAt) === day.key).length;
                  return (
                    <button key={day.key} type="button" role="tab" aria-selected={selectedDay === day.key} className={`day-chip ${selectedDay === day.key ? 'active' : ''}`} onClick={() => setSelectedDay(day.key)}>
                      <span>{day.weekday}</span>
                      <strong>{day.label}</strong>
                      <small>{count} appt{count === 1 ? '' : 's'}</small>
                    </button>
                  );
                })}
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Customer</th><th>Vehicle</th><th>Time</th><th>CRE</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>
                    {dayAppointments.map((appointment) => (
                      <tr key={appointment.id}>
                        <td>{appointment.customer}</td>
                        <td>{appointment.vehicle}</td>
                        <td>{new Date(appointment.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                        <td>{appointment.assigneeName || '—'}</td>
                        <td><select className="status-select" aria-label={`Appointment status for ${appointment.customer}`} value={String(appointment.status).toUpperCase()} onChange={(event) => changeAppointmentStatus(appointment.id, event.target.value)}>
                          {['PENDING', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW'].map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}
                        </select></td>
                        <td><button type="button" className="icon-btn compact-delete-btn" aria-label={`Delete appointment for ${appointment.customer}`} title="Delete appointment" disabled={appointmentDeletingId === appointment.id} onClick={() => deleteAppointment(appointment)}><Trash2 size={17} aria-hidden="true" /></button></td>
                      </tr>
                    ))}
                    {!appointmentsLoading && dayAppointments.length === 0 && <tr><td colSpan="6" className="empty-state">No appointments on this day.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </section>
        ) : activeView === 'Master list' ? (
          <section className="customer-workspace">
            {masterListError && <p className="form-alert error" role="alert">{masterListError}</p>}
            {masterListMessage && <p className="form-alert success" role="status">{masterListMessage}</p>}
            {masterEntryFormOpen && (
              <form className="panel customer-form" onSubmit={submitMasterEntry}>
                <div className="panel-header">
                  <h3>Add customer to master list</h3>
                  <span>Fields match the service repair-order CSV</span>
                </div>
                <div className="form-grid">
                  {masterCsvFields.filter(([key]) => !manualEntryExcludedFields.includes(key)).map(([key, label, type]) => (
                    <label key={key}>
                      {label}{['roNumber', 'vin', 'customerName', 'mobileNumber'].includes(key) ? ' *' : ''}
                      <input
                        required={['roNumber', 'vin', 'customerName', 'mobileNumber'].includes(key)}
                        maxLength={key === 'vin' ? 17 : undefined}
                        type={type}
                        min={type === 'number' ? '0' : undefined}
                        value={masterEntryForm[key]}
                        onChange={(event) => setMasterEntryForm({
                          ...masterEntryForm,
                          [key]: key === 'vin' || key === 'registrationNumber' ? event.target.value.toUpperCase() : event.target.value,
                        })}
                      />
                    </label>
                  ))}
                  {currentRole !== 'CCM' && (
                    <label>CCM ID<select required value={masterEntryForm.ccmId} onChange={(event) => setMasterEntryForm({ ...masterEntryForm, ccmId: event.target.value })}>
                      <option value="">Select CCM</option>
                      {masterListCcms.map((ccm) => <option key={ccm.ccmId} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}
                    </select></label>
                  )}
                </div>
                <div className="form-actions">
                  <button type="button" className="outline-btn" onClick={() => setMasterEntryFormOpen(false)}>Cancel</button>
                  <button type="submit" className="primary-btn" disabled={masterEntrySaving || masterListLoading || (currentRole !== 'CCM' && masterListCcms.length === 0)}>
                    <Save size={16} aria-hidden="true" />{masterEntrySaving ? 'Saving…' : 'Add customer'}
                  </button>
                </div>
              </form>
            )}
            <section className="panel customer-list-panel">
              <div className="panel-header">
                <h3>Master call list</h3>
                {['ADMIN', 'GM'].includes(currentRole) && (
                  <label className="inline-filter">Team
                    <select value={masterListTeam} onChange={(event) => setMasterListTeam(event.target.value)}>
                      <option value="">All teams</option>
                      {masterListCcms.map((ccm) => <option key={ccm.ccmId} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}
                    </select>
                  </label>
                )}
                <span>{masterListLoading ? 'Loading…' : `${masterRecords.length} records`}</span>
              </div>
              {renderMasterCallTable(masterRecords, masterListLoading, { showDetails: true })}
            </section>
            {selectedMasterRecord && (
              <section className="panel master-record-details" aria-label={`Imported details for ${selectedMasterRecord.name || selectedMasterRecord.customerName}`}>
                <div className="panel-header">
                  <div>
                    <h3>{selectedMasterRecord.name || selectedMasterRecord.customerName}</h3>
                    <span>{selectedMasterRecord.vin}</span>
                  </div>
                  <button type="button" className="outline-btn compact-btn" onClick={() => setSelectedMasterRecordId(null)}>Close details</button>
                </div>
                {(selectedMasterRecord.workshopVisits || []).map((visit, index) => {
                  const details = visit.importedDetails || (index === 0 ? selectedMasterRecord.importedDetails : null);
                  return (
                    <section className="master-visit-details" key={`${visit.repairOrderNo}-${index}`}>
                      <h4>Repair order {visit.repairOrderNo || index + 1}</h4>
                      {details && Object.entries(details).length > 0 ? (
                        <dl className="master-detail-grid">
                          {Object.entries(details).map(([key, value]) => (
                            <div key={key}>
                              <dt>{getMasterDetailLabel(key)}</dt>
                              <dd>{value == null || value === '' ? '—' : String(value)}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <dl className="master-detail-grid">
                          <div><dt>Repair Order No</dt><dd>{visit.repairOrderNo || '—'}</dd></div>
                          <div><dt>R/O Date</dt><dd>{visit.visitDate ? new Date(visit.visitDate).toLocaleDateString() : '—'}</dd></div>
                          <div><dt>Closing Date</dt><dd>{visit.closingDate ? new Date(visit.closingDate).toLocaleDateString() : '—'}</dd></div>
                          <div><dt>G.P Date</dt><dd>{visit.gpDate ? new Date(visit.gpDate).toLocaleDateString() : '—'}</dd></div>
                          <div><dt>Labor Cost</dt><dd>{visit.totalLaborCost ?? '—'}</dd></div>
                          <div><dt>Parts Cost</dt><dd>{visit.totalPartsCost ?? '—'}</dd></div>
                          <div><dt>Total Amount</dt><dd>{visit.totalAmount ?? '—'}</dd></div>
                        </dl>
                      )}
                    </section>
                  );
                })}
                {!selectedMasterRecord.workshopVisits?.length && selectedMasterRecord.importedDetails && (
                  <dl className="master-detail-grid">
                    {Object.entries(selectedMasterRecord.importedDetails).map(([key, value]) => (
                      <div key={key}><dt>{getMasterDetailLabel(key)}</dt><dd>{value == null || value === '' ? '—' : String(value)}</dd></div>
                    ))}
                  </dl>
                )}
              </section>
            )}
          </section>
        ) : activeView === 'Customers' || activeView in followUpViews || activeView in dueViews ? (
          <section className="customer-workspace">
            {activeView in followUpViews && followUpError && <p className="form-alert error" role="alert">{followUpError}</p>}
            {activeView in followUpViews && dueError && <p className="form-alert error" role="alert">{dueError}</p>}
            {customerError && <p className="form-alert error" role="alert">{customerError}</p>}
            {customerMessage && <p className="form-alert success" role="status">{customerMessage}</p>}
            {callError && <p className="form-alert error" role="alert">{callError}</p>}
            {callMessage && <p className="form-alert success" role="status">{callMessage}</p>}

            {activeView === 'Customers' && customerFormOpen && canCreateCustomer && (
              <form className="panel customer-form" onSubmit={submitCustomer}>
                <div className="panel-header">
                  <h3>New customer</h3>
                  <span>Customer details and registered vehicles</span>
                </div>
                <div className="form-grid">
                  <label>Full name<input required maxLength="200" value={customerForm.fullName} onChange={(event) => updateCustomerField('fullName', event.target.value)} /></label>
                  <label>Mobile number<input inputMode="tel" value={customerForm.mobileNumber} onChange={(event) => updateCustomerField('mobileNumber', event.target.value)} /></label>
                  <label>Email<input type="email" value={customerForm.email} onChange={(event) => updateCustomerField('email', event.target.value)} /></label>
                  {['ADMIN', 'GM'].includes(String(currentUser?.role || '').toUpperCase()) && <label>CCM ID<input placeholder="Optional team assignment" value={customerForm.ccmId} onChange={(event) => updateCustomerField('ccmId', event.target.value)} /></label>}
                </div>

                <div className="vehicle-form-list">
                  <div className="panel-header">
                    <h3>Vehicles</h3>
                    <button type="button" className="outline-btn compact-btn" onClick={() => setCustomerForm((current) => ({ ...current, vehicles: [...current.vehicles, { vin: '', registrationNumber: '', model: '', year: '' }] }))}>
                      <Plus size={16} aria-hidden="true" /> Add vehicle
                    </button>
                  </div>
                  {customerForm.vehicles.map((vehicle, index) => (
                    <div className="vehicle-form-row" key={`vehicle-${index}`}>
                      <label>VIN<input value={vehicle.vin} onChange={(event) => updateVehicleField(index, 'vin', event.target.value)} /></label>
                      <label>Registration<input value={vehicle.registrationNumber} onChange={(event) => updateVehicleField(index, 'registrationNumber', event.target.value)} /></label>
                      <label>Model<input value={vehicle.model} onChange={(event) => updateVehicleField(index, 'model', event.target.value)} /></label>
                      <label>Year<input type="number" min="1950" max={new Date().getFullYear() + 1} value={vehicle.year} onChange={(event) => updateVehicleField(index, 'year', event.target.value)} /></label>
                      <button type="button" className="icon-btn" aria-label="Remove vehicle" title="Remove vehicle" disabled={customerForm.vehicles.length === 1} onClick={() => setCustomerForm((current) => ({ ...current, vehicles: current.vehicles.filter((_, vehicleIndex) => vehicleIndex !== index) }))}>
                        <Trash2 size={17} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="form-actions">
                  <button type="button" className="outline-btn" onClick={() => setCustomerFormOpen(false)}>Cancel</button>
                  <button type="submit" className="primary-btn" disabled={customerSaving}>{customerSaving ? 'Saving…' : 'Create customer'}</button>
                </div>
              </form>
            )}

            {activeView in followUpViews ? (
              <section className="panel customer-list-panel">
                <div className="panel-header">
                  <h3>Follow-up queue · {followUpViews[activeView].label}</h3>
                  {followUpServiceKind && <label className="inline-filter">Search
                    <input type="search" value={followUpSearch} placeholder="Name, number, VIN, model or reg. no." onChange={(event) => setFollowUpSearch(event.target.value)} />
                  </label>}
                  <span>{followUpsLoading ? 'Loading…' : `${followUpServiceKind ? visibleFollowUpTableRecords.length : followUps.length} records`}</span>
                </div>
                {followUpServiceKind ? renderServiceListTable(followUpServiceKind, visibleFollowUpTableRecords, true) : <div className="table-scroll">
                  <table className="master-call-list-table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Due</th>
                        <th>Name</th>
                        <th>Number</th>
                        <th>Model name</th>
                        <th>VIN</th>
                        <th>Veh age</th>
                        <th>Regd no.</th>
                        <th>Status</th>
                        <th>Scheduled apt</th>
                        <th>Allocated CRE</th>
                        <th>Call on</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {followUps.map((followUp) => {
                        const record = (followUp.vehicleId && calls.find((entry) => entry.vehicleId === followUp.vehicleId))
                          || calls.find((entry) => entry.customerId === followUp.customer.id);
                        const dueValue = followUp.source === 'FREE_SERVICE' ? followUp.milestone?.dueDate : followUp.source === 'WARRANTY' ? null : record?.dueDate;
                        const typeLabel = followUp.source === 'FREE_SERVICE' ? `Free service ${followUp.milestone?.milestone ?? ''}`.trim() : followUp.source === 'WARRANTY' ? 'Warranty' : record?.type;
                        return (
                          <tr key={followUp.id}>
                            <td>{typeLabel || '—'}</td>
                            <td className={dueValue && new Date(dueValue) < new Date() ? 'due-overdue' : undefined}>{dueValue ? new Date(dueValue).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—'}</td>
                            <td><button type="button" className="text-link" onClick={() => openDueCustomer({ customerId: followUp.customer.id, vehicleId: record?.vehicleId }, 'profile')}>{followUp.customer.fullName}</button></td>
                            <td>{followUp.customer.mobileNumber || '—'}</td>
                            <td>{followUp.vehicle?.model || record?.model || '—'}</td>
                            <td>{followUp.vehicle?.vin || record?.vin || '—'}</td>
                            <td>{formatVehicleAge(record?.vehicleAgeMonths)}</td>
                            <td>{followUp.vehicle?.registrationNumber || record?.registrationNumber || '—'}</td>
                            <td><span className="badge badge-neutral">{record?.status || 'pending'}</span></td>
                            <td>{record?.scheduledAppointment ? new Date(record.scheduledAppointment.scheduledAt).toLocaleString() : '—'}</td>
                            <td>{followUp.cre?.name || record?.assigneeName || 'Unassigned'}</td>
                            <td>{new Date(followUp.followUpAt).toLocaleString()}</td>
                            <td>
                              <div className="inline-actions">
                                {currentRole === 'CRE' && (
                                  <button type="button" className="icon-btn call-icon-btn" aria-label={`Call ${followUp.customer.fullName}`} title="Call customer" onClick={() => callFromFollowUp(followUp, record?.vehicleId)}>
                                    <PhoneCall size={17} aria-hidden="true" />
                                  </button>
                                )}
                                <button type="button" className="outline-btn compact-btn" onClick={() => changeFollowUpStatus(followUp.id, 'completed')}>Complete</button>
                                <button type="button" className="outline-btn compact-btn" onClick={() => changeFollowUpStatus(followUp.id, 'cancelled')}>Cancel</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {!followUpsLoading && followUps.length === 0 && <tr><td colSpan="13" className="empty-state">No {followUpViews[activeView].label.toLowerCase()} follow-ups scheduled.</td></tr>}
                    </tbody>
                  </table>
                </div>}
              </section>
            ) : activeView in dueViews ? (
              <section className="panel customer-list-panel">
                <div className="panel-header">
                  <h3>{dueViews[activeView].label}</h3>
                  <label className="inline-filter">Search
                    <input type="search" value={dueSearch} placeholder="Name, number, VIN, model or reg. no." onChange={(event) => setDueSearch(event.target.value)} />
                  </label>
                  <span>{dueLoading ? 'Loading…' : `${visibleDueRecords.length} records`}</span>
                </div>
                {dueError && <p className="form-alert error" role="alert">{dueError}</p>}
                {dueIssues.length > 0 && (
                  <details className="form-alert info data-issues">
                    <summary>{dueIssues.length} vehicle{dueIssues.length === 1 ? ' is' : 's are'} excluded because the sale date is missing or invalid</summary>
                    <ul>{dueIssues.map((issue) => <li key={issue.vehicleId}>{issue.name} · {issue.registrationNumber || issue.vin}</li>)}</ul>
                  </details>
                )}
                {dueViews[activeView].kind !== 'due' ? renderServiceListTable(dueViews[activeView].kind) : currentRole === 'CCM' ? renderMasterCallTable(visibleDueRecords, dueLoading, { showDetails: true }) : (
                <>
                {renderMasterRepairTypeLegend()}
                <div className="table-scroll">
                  <table className="master-call-list-table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Due</th>
                        <th>Name</th>
                        <th>Number</th>
                        <th>Model name</th>
                        <th>VIN</th>
                        <th>Veh age</th>
                        <th>Regd no.</th>
                        <th>Status</th>
                        <th>Scheduled apt</th>
                        <th>Call</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleDueRecords.map((record) => (
                        <tr key={record.id}>
                          <td>{renderMasterRepairTypeBadge(record.type)}</td>
                          <td className={record.dueDate && new Date(record.dueDate) < new Date() ? 'due-overdue' : undefined}>{record.dueDate ? new Date(record.dueDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—'}</td>
                          <td><button type="button" className="text-link" onClick={() => openDueCustomer(record, 'profile')}>{record.name || record.customerName || '—'}</button></td>
                          <td>{record.mobile || '—'}</td>
                          <td>{record.model || '—'}</td>
                          <td>{record.vin || '—'}</td>
                          <td>{formatVehicleAge(record.vehicleAgeMonths)}</td>
                          <td>{record.registrationNumber || '—'}</td>
                          <td><span className="badge badge-neutral">{record.status || 'pending'}</span></td>
                          <td>{record.scheduledAppointment ? new Date(record.scheduledAppointment.scheduledAt).toLocaleString() : '—'}</td>
                          <td>
                            <button type="button" className="icon-btn call-icon-btn" aria-label={`Call ${record.name || record.customerName}`} title="Call customer" disabled={!record.customerId} onClick={() => openDueCustomer(record, 'call')}>
                              <PhoneCall size={17} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!dueLoading && visibleDueRecords.length === 0 && <tr><td colSpan="11" className="empty-state">No customers are due in this list.</td></tr>}
                    </tbody>
                  </table>
                </div>
                </>
                )}
              </section>
            ) : (
            <section className="panel customer-list-panel">
              <div className="panel-header">
                <h3>Customer directory</h3>
                <span>{customersLoading ? 'Loading…' : `${customers.length} records`}</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Customer</th><th>Mobile</th><th>Email</th><th>Vehicles</th></tr></thead>
                  <tbody>
                    {customers.map((customer) => (
                      <tr key={customer.id}>
                        <td><button type="button" className="text-link" onClick={() => openCustomerPanel(customer)}>{customer.name || customer.customerName || customer.fullName}</button></td>
                        <td>{customer.mobile || customer.mobileNumber || '—'}</td>
                        <td>{customer.email || '—'}</td>
                        <td>{customer.vehicleCount ?? customer.vehicles?.length ?? 0}</td>
                      </tr>
                    ))}
                    {!customersLoading && customers.length === 0 && <tr><td colSpan="4" className="empty-state">No customer records found.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            )}

            {panelCustomer && (
              <section className="panel customer-action-panel">
                <div className="panel-header">
                  <h3>{panelCustomer.name || panelCustomer.fullName}</h3>
                  <button type="button" className="outline-btn compact-btn" onClick={() => setCustomerPanel({ customerId: null, mode: 'options' })}>Close</button>
                </div>
                {customerPanel.mode === 'options' && (
                  <div className="customer-options">
                    {currentRole === 'CRE' && <button type="button" className="primary-btn" onClick={() => startCall(panelCustomer)}><PhoneCall size={16} aria-hidden="true" /> Call customer</button>}
                    <button type="button" className="outline-btn" onClick={() => openCustomerProfile(panelCustomer)}>View profile</button>
                  </div>
                )}
                {customerPanel.mode === 'call' && (
                  <form className="customer-form" onSubmit={submitCall}>
                    <p className="call-number">
                      {panelCustomer.mobile || panelCustomer.mobileNumber
                        ? <a className="primary-btn" href={`tel:${panelCustomer.mobile || panelCustomer.mobileNumber}`}><PhoneCall size={16} aria-hidden="true" /> {panelCustomer.mobile || panelCustomer.mobileNumber}</a>
                        : <span className="empty-state">No mobile number on file</span>}
                    </p>
                    {callForm.callSource !== 'SERVICE' && (
                      <p className="performance-note">{callForm.callSource === 'WARRANTY' ? 'Warranty call: it is tracked separately and does not count toward your daily call targets.' : 'Free-service call: the follow-up you arrange will appear under Follow-ups · Free Service.'}</p>
                    )}
                    <div className="form-grid">
                      <label>Vehicle
                        <select value={callForm.vehicleId} onChange={(event) => setCallForm({ ...callForm, vehicleId: event.target.value })}>
                          <option value="">No specific vehicle</option>
                          {(panelCustomer.vehicles || []).map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{[vehicle.model, vehicle.registrationNumber, vehicle.vin].filter(Boolean).join(' / ')}</option>)}
                        </select>
                      </label>
                      <label>Call outcome
                        <select required value={callForm.outcome} onChange={(event) => setCallForm({ ...callForm, outcome: event.target.value })}>
                          {['CONTACTED', 'NOT_INTERESTED', 'WRONG_NUMBER', 'NO_RESPONSE', 'OTHER'].map((outcome) => <option key={outcome} value={outcome}>{outcome.replaceAll('_', ' ')}</option>)}
                        </select>
                      </label>
                      <label className="full-width-field">Feedback<textarea required rows="3" maxLength="2000" value={callForm.notes} onChange={(event) => setCallForm({ ...callForm, notes: event.target.value })} placeholder="What did the customer say?" /></label>
                      <fieldset className="full-width-field next-action">
                        <legend>Next step</legend>
                        {[['none', 'No further action'], ['followup', 'Arrange follow-up'], ['appointment', 'Arrange appointment']].map(([value, label]) => (
                          <label key={value} className="radio-option"><input type="radio" name="nextAction" value={value} checked={callForm.nextAction === value} onChange={() => setCallForm({ ...callForm, nextAction: value })} /> {label}</label>
                        ))}
                      </fieldset>
                      {callForm.nextAction !== 'none' && (
                        <label>{callForm.nextAction === 'followup' ? 'Follow-up date and time' : 'Appointment date and time'}
                          <input required type="datetime-local" value={callForm.scheduledAt} onChange={(event) => setCallForm({ ...callForm, scheduledAt: event.target.value })} />
                        </label>
                      )}
                    </div>
                    <div className="form-actions">
                      <button type="button" className="outline-btn" onClick={() => setCustomerPanel({ customerId: panelCustomer.id, mode: 'options' })}>Back</button>
                      <button type="submit" className="primary-btn" disabled={callSaving}>{callSaving ? 'Saving…' : 'Save call'}</button>
                    </div>
                  </form>
                )}
                {customerPanel.mode === 'profile' && (
                  <div className="customer-profile">
                    <dl className="master-detail-grid">
                      <div><dt>Name</dt><dd>{panelCustomer.name || panelCustomer.fullName}</dd></div>
                      <div><dt>Mobile</dt><dd>{panelCustomer.mobile || panelCustomer.mobileNumber || '—'}</dd></div>
                      <div><dt>Email</dt><dd>{panelCustomer.email || '—'}</dd></div>
                    </dl>
                    <h4>Vehicles</h4>
                    <div className="table-scroll"><table><thead><tr><th>Model</th><th>Reg. no.</th><th>VIN</th></tr></thead><tbody>
                      {(panelCustomer.vehicles || []).map((vehicle) => <tr key={vehicle.id}><td>{vehicle.model || '—'}</td><td>{vehicle.registrationNumber || '—'}</td><td>{vehicle.vin || '—'}</td></tr>)}
                    </tbody></table></div>
                    {(panelCustomer.visits || []).map((visit) => (
                      <div key={visit.repairOrderNo || visit.visitDate}>
                        <h4>Repair order {visit.repairOrderNo || ''}</h4>
                        <dl className="master-detail-grid">
                          {Object.entries(visit.importedDetails || {}).map(([key, value]) => (
                            <div key={key}><dt>{getMasterDetailLabel(key)}</dt><dd>{value == null || value === '' ? '—' : String(value)}</dd></div>
                          ))}
                        </dl>
                      </div>
                    ))}
                    <h4>Call history</h4>
                    <div className="table-scroll"><table><thead><tr><th>When</th><th>Outcome</th><th>CRE</th><th>Feedback</th></tr></thead><tbody>
                      {callLogs.filter((call) => call.customer?.id === panelCustomer.id || call.customerId === panelCustomer.id).map((call) => <tr key={call.id}><td>{new Date(call.createdAt).toLocaleString()}</td><td>{call.outcome.replaceAll('_', ' ')}</td><td>{call.assignee?.name || call.creator?.name || '—'}</td><td>{call.notes || '—'}</td></tr>)}
                      {!callLogsLoading && !callLogs.some((call) => call.customer?.id === panelCustomer.id || call.customerId === panelCustomer.id) && <tr><td colSpan="4" className="empty-state">No calls logged yet.</td></tr>}
                    </tbody></table></div>
                    <div className="form-actions"><button type="button" className="outline-btn" onClick={() => setCustomerPanel({ customerId: panelCustomer.id, mode: 'options' })}>Back</button></div>
                  </div>
                )}
              </section>
            )}
          </section>
        ) : (
          <>
            {currentRole === 'FREE_SERVICE_CRE' ? (
              <section className="customer-workspace cre-dashboard">
                <section className="stats-grid">
                  {[
                    ['Calls made today', dashboardData?.freeServiceCre?.dailyTargets?.callsMade, 120],
                    ['Pickups achieved today', dashboardData?.freeServiceCre?.dailyTargets?.callsPickedUp, 80],
                  ].map(([label, metric, target]) => {
                    const actual = metric?.actual ?? 0;
                    const percent = Math.min(100, Math.round((actual / target) * 100));
                    return (
                      <article key={label} className="stat-card">
                        <p>{label}</p>
                        <strong>{actual} / {target}</strong>
                        <div className="target-progress-row">
                          <div className="target-progress-bar"><div className={`target-progress-fill ${percent >= 100 ? 'met' : ''}`} style={{ width: `${percent}%` }} /></div>
                          <span>{percent}%</span>
                        </div>
                        <small>{actual} actual of {target} daily target</small>
                      </article>
                    );
                  })}
                </section>
                <section className="panel customer-list-panel">
                  <div className="panel-header"><h3>Today&apos;s Appointments</h3><span>{dashboardData?.freeServiceCre?.todayAppointments?.length || 0} booked</span></div>
                  <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Vehicle</th><th>Time</th><th>Status</th></tr></thead><tbody>
                    {(dashboardData?.freeServiceCre?.todayAppointments || []).map((appointment) => <tr key={appointment.id}>
                      <td>{appointment.customer}</td><td>{appointment.vehicle}</td>
                      <td>{new Date(appointment.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td><span className="badge badge-blue">{appointment.status}</span></td>
                    </tr>)}
                    {!dashboardData?.freeServiceCre?.todayAppointments?.length && <tr><td colSpan="4" className="empty-state">No appointments scheduled for today.</td></tr>}
                  </tbody></table></div>
                </section>
              </section>
            ) : currentRole === 'CRE' ? (
              <section className="customer-workspace cre-dashboard">
                <div className="quick-actions-bar">
                  <span className="quick-actions-label">Quick Actions:</span>
                  <button type="button" className="quick-action-btn primary" onClick={() => { setAppointmentFormOpen(true); setActiveView('Appointments'); }}>
                    <CalendarPlus2 size={15} aria-hidden="true" /> Book Appointment
                  </button>
                  <button type="button" className="quick-action-btn" onClick={() => openDueList('Due 1-Year')}>
                    <CalendarClock size={15} aria-hidden="true" /> 1-Year Due ({dashboardData?.cre?.categoryCounts?.oneYear ?? 0})
                  </button>
                  <button type="button" className="quick-action-btn" onClick={() => openDueList('Due 6-Month')}>
                    <Clock3 size={15} aria-hidden="true" /> 6-Month Due ({dashboardData?.cre?.categoryCounts?.sixMonth ?? 0})
                  </button>
                  {canAccessFreeService && <button type="button" className="quick-action-btn" onClick={() => openDueList('Free Service')}>
                    <Gift size={15} aria-hidden="true" /> Free Service ({dashboardData?.cre?.categoryCounts?.freeService ?? 0})
                  </button>}
                  {canAccessWarranty && <button type="button" className="quick-action-btn" onClick={() => openDueList('Warranty')}>
                    <ShieldCheck size={15} aria-hidden="true" /> Warranty
                  </button>}
                  <button type="button" className="quick-action-btn" onClick={() => openFollowUpList('Follow-up Service')}>
                    <PhoneCall size={15} aria-hidden="true" /> Follow-up Queue
                  </button>
                </div>

                <section className="stats-grid">
                  <article className="stat-card">
                    <p>Calls Made Today</p>
                    <strong>{dashboardData?.cre?.dailyTargets?.callsMade?.actual ?? 0} / {dashboardData?.cre?.dailyTargets?.callsMade?.target ?? 120}</strong>
                    <div className="target-progress-row">
                      <div className="target-progress-bar">
                        <div
                          className={`target-progress-fill ${dashboardData?.cre?.dailyTargets?.callsMade?.met ? 'met' : ''}`}
                          style={{ width: `${Math.min(100, Math.round(((dashboardData?.cre?.dailyTargets?.callsMade?.actual ?? 0) / (dashboardData?.cre?.dailyTargets?.callsMade?.target || 120)) * 100))}%` }}
                        />
                      </div>
                      <span className={`badge ${dashboardData?.cre?.dailyTargets?.callsMade?.met ? 'badge-success' : 'badge-danger'}`}>
                        {dashboardData?.cre?.dailyTargets?.callsMade?.met ? 'Met' : `${dashboardData?.cre?.dailyTargets?.callsMade?.shortfall ?? 120} short`}
                      </span>
                    </div>
                  </article>

                  <article className="stat-card">
                    <p>Calls Picked Up Today</p>
                    <strong>{dashboardData?.cre?.dailyTargets?.callsPickedUp?.actual ?? 0} / {dashboardData?.cre?.dailyTargets?.callsPickedUp?.target ?? 80}</strong>
                    <div className="target-progress-row">
                      <div className="target-progress-bar">
                        <div
                          className={`target-progress-fill ${dashboardData?.cre?.dailyTargets?.callsPickedUp?.met ? 'met' : ''}`}
                          style={{ width: `${Math.min(100, Math.round(((dashboardData?.cre?.dailyTargets?.callsPickedUp?.actual ?? 0) / (dashboardData?.cre?.dailyTargets?.callsPickedUp?.target || 80)) * 100))}%` }}
                        />
                      </div>
                      <span className={`badge ${dashboardData?.cre?.dailyTargets?.callsPickedUp?.met ? 'badge-success' : 'badge-danger'}`}>
                        {dashboardData?.cre?.dailyTargets?.callsPickedUp?.met ? 'Met' : `${dashboardData?.cre?.dailyTargets?.callsPickedUp?.shortfall ?? 80} short`}
                      </span>
                    </div>
                  </article>

                  <article className="stat-card">
                    <p>Assigned Workload</p>
                    <strong>{dashboardData?.cre?.assignedWorkload ?? 0}</strong>
                    <span>1-Yr, 6-Mo{canAccessFreeService ? ' & Free Service' : ''}</span>
                  </article>

                  <article className="stat-card">
                    <p>Pending Follow-ups</p>
                    <strong>{dashboardData?.cre?.pendingFollowUps ?? 0}</strong>
                    <span>
                      {(dashboardData?.cre?.overdueFollowUpsCount || 0) > 0 ? (
                        <span className="badge badge-danger">{dashboardData.cre.overdueFollowUpsCount} overdue</span>
                      ) : (
                        'All on schedule'
                      )}
                    </span>
                  </article>
                </section>

                <section className="content-grid">
                  <article className="panel">
                    <div className="panel-header">
                      <h3>Urgent & Upcoming Follow-ups</h3>
                      <span>{dashboardData?.cre?.urgentFollowUps?.length ?? 0} items in queue</span>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Customer</th>
                            <th>Vehicle</th>
                            <th>Due Time</th>
                            <th>Category</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(dashboardData?.cre?.urgentFollowUps || []).map((fu) => (
                            <tr key={fu.id}>
                              <td>
                                <strong>{fu.customerName}</strong>
                                {fu.mobileNumber && <small style={{ display: 'block', color: '#718085' }}>{fu.mobileNumber}</small>}
                              </td>
                              <td>{fu.vehicleModel || '—'}</td>
                              <td>
                                {new Date(fu.followUpAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                {fu.isOverdue && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Overdue</span>}
                              </td>
                              <td><span className="badge badge-neutral">{fu.source?.toLowerCase().replace('_', ' ') || fu.category}</span></td>
                              <td>
                                <button
                                  type="button"
                                  className="primary-btn compact-btn"
                                  onClick={() => openDueCustomer({ customerId: fu.customerId, vehicleId: fu.vehicleId, callSource: fu.source }, 'call')}
                                >
                                  <PhoneCall size={13} aria-hidden="true" /> Call
                                </button>
                              </td>
                            </tr>
                          ))}
                          {(!dashboardData?.cre?.urgentFollowUps || dashboardData.cre.urgentFollowUps.length === 0) && (
                            <tr>
                              <td colSpan="5" className="empty-state">
                                No pending follow-ups scheduled for today. Great job keeping your queue clear!
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>

                  <article className="panel">
                    <div className="panel-header">
                      <h3>Today&apos;s Appointments</h3>
                      <span>{(dashboardData?.cre?.todayAppointments || appointments).length} booked</span>
                    </div>

                    <ul className="stack-list">
                      {(dashboardData?.cre?.todayAppointments || appointments).map((appointment) => (
                        <li key={appointment.id || appointment.customer || appointment.time}>
                          <div>
                            <strong>{appointment.customer}</strong>
                            <small>{appointment.vehicle}</small>
                          </div>
                          <div className="meta-block" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span>{appointment.time || new Date(appointment.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            <span className="badge badge-blue">{appointment.status}</span>
                            <button
                              type="button"
                              className="compact-delete-btn"
                              aria-label={`Delete appointment for ${appointment.customer}`}
                              title="Delete appointment"
                              disabled={appointmentDeletingId === appointment.id}
                              onClick={() => deleteAppointment(appointment)}
                            >
                              <Trash2 size={15} aria-hidden="true" />
                            </button>
                          </div>
                        </li>
                      ))}
                      {((!dashboardData?.cre?.todayAppointments || dashboardData.cre.todayAppointments.length === 0) && appointments.length === 0) && (
                        <li className="empty-state" style={{ textAlign: 'center', display: 'block', padding: '24px 0' }}>
                          No appointments scheduled for today.
                        </li>
                      )}
                    </ul>
                  </article>
                </section>
              </section>
            ) : currentRole === 'CCM' ? (
              <section className="customer-workspace ccm-dashboard">
                <section className="content-grid quota-notices" aria-label="Previous-day call target alerts">
                  {[
                    { key: 'callsMadeMissed', title: 'Calls made target missed', noun: 'calls made', allMet: 'All CREs met the calls-made target yesterday' },
                    { key: 'callsPickedUpMissed', title: 'Calls picked up target missed', noun: 'calls picked up', allMet: 'All CREs met the calls-picked-up target yesterday' },
                  ].map(({ key, title, noun, allMet }) => {
                    const notices = dashboardData?.ccm?.quotaNotices || quotaNotices;
                    return (
                      <article key={key} className="panel quota-notice">
                        <div className="panel-header">
                          <h3>{title}</h3>
                          <span>{notices?.date ? formatDate(`${notices.date}T12:00:00`) : 'Yesterday'}</span>
                        </div>
                        {!notices ? <p className="empty-state">Checking yesterday&apos;s calls…</p> : notices[key].length === 0 ? (
                          <p className="empty-state">{notices.totalCres === 0 ? 'No active CREs report to you yet.' : allMet}</p>
                        ) : (
                          <ul className="stack-list">
                            {notices[key].map((entry) => (
                              <li key={entry.creId}>
                                <div><strong>{entry.creName}</strong><span>{entry.actual}/{entry.target} {noun}</span></div>
                                <span className="badge badge-danger">{entry.shortfall} short</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    );
                  })}
                </section>

                <div className="quick-actions-bar">
                  <span className="quick-actions-label">Quick Actions:</span>
                  <button type="button" className="quick-action-btn primary" onClick={openAllocations}>
                    <ClipboardList size={15} aria-hidden="true" /> Allocate Vehicles
                  </button>
                  <button type="button" className="quick-action-btn" onClick={openPerformanceBoard}>
                    <BarChart3 size={15} aria-hidden="true" /> Performance Board
                  </button>
                  <button type="button" className="quick-action-btn" onClick={() => setActiveView('Workshop Performance')}>
                    <Activity size={15} aria-hidden="true" /> Workshop Performance
                  </button>
                  <button type="button" className="quick-action-btn" onClick={openAppointments}>
                    <CalendarDays size={15} aria-hidden="true" /> Team Schedule
                  </button>
                  <button type="button" className="quick-action-btn" onClick={openImports}>
                    <Upload size={15} aria-hidden="true" /> Import Repair Orders
                  </button>
                </div>

                <section className="stats-grid">
                  <article className="stat-card">
                    <p>Active CREs</p>
                    <strong>{dashboardData?.ccm?.teamCresCount ?? allocationCres.length ?? 0}</strong>
                    <span>In your team</span>
                  </article>
                  <article className="stat-card">
                    <p>Free-Service CREs</p>
                    <strong>{dashboardData?.ccm?.teamFreeServiceCresCount ?? freeServiceCres.length ?? 0}</strong>
                    <span>Separate Free-Service role</span>
                  </article>

                  <article className="stat-card">
                    <p>Team Calls Today</p>
                    <strong>{dashboardData?.ccm?.teamCallsToday ?? 0}</strong>
                    <span>Logged across team</span>
                  </article>

                  <article className="stat-card">
                    <p>Team Calls Connected</p>
                    <strong>{dashboardData?.ccm?.teamCallsPickedUpToday ?? 0}</strong>
                    <span>Answered by customers</span>
                  </article>

                  <article className="stat-card">
                    <p>Unassigned Customers</p>
                    <strong>{dashboardData?.ccm?.pendingAllocationsCount ?? '—'}</strong>
                    <span>Awaiting an active CRE</span>
                  </article>
                </section>

                <section className="content-grid">
                  <article className="panel">
                    <div className="panel-header">
                      <h3>Live CRE Performance Today</h3>
                      <button type="button" className="text-link" onClick={openPerformanceBoard}>View full board</button>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>CRE</th>
                            <th>Calls Made</th>
                            <th>Calls Picked Up</th>
                            <th>Calls Made Status</th>
                            <th>Picked Up Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(dashboardData?.ccm?.creBoard || []).map((row) => (
                            <tr key={row.creId}>
                              <td><strong>{row.creName}</strong></td>
                              <td>{row.callsMade} / {row.callsMadeTarget}</td>
                              <td>{row.callsPickedUp} / {row.callsPickedUpTarget}</td>
                              <td><span className={`badge ${row.callsMadeMet ? 'badge-success' : 'badge-danger'}`}>{row.callsMadeMet ? 'Target met' : `${row.callsMadeShortfall} short`}</span></td>
                              <td><span className={`badge ${row.callsPickedUpMet ? 'badge-success' : 'badge-danger'}`}>{row.callsPickedUpMet ? 'Target met' : `${row.callsPickedUpShortfall} short`}</span></td>
                            </tr>
                          ))}
                          {(!dashboardData?.ccm?.creBoard || dashboardData.ccm.creBoard.length === 0) && (
                            <tr>
                              <td colSpan="5" className="empty-state">No CRE performance logged yet today.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>

                  <article className="panel">
                    <div className="panel-header">
                      <h3>Today&apos;s Team Appointments</h3>
                      <span>{(dashboardData?.ccm?.todayAppointments || appointments).length} booked</span>
                    </div>
                    <ul className="stack-list">
                      {(dashboardData?.ccm?.todayAppointments || appointments).map((appointment) => (
                        <li key={appointment.id || appointment.customer || appointment.time}>
                          <div>
                            <strong>{appointment.customer}</strong>
                            <small>{appointment.vehicle} {appointment.assigneeName ? `· ${appointment.assigneeName}` : ''}</small>
                          </div>
                          <div className="meta-block" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span>{appointment.time || new Date(appointment.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            <span className="badge badge-blue">{appointment.status}</span>
                            <button
                              type="button"
                              className="compact-delete-btn"
                              aria-label={`Delete appointment for ${appointment.customer}`}
                              title="Delete appointment"
                              disabled={appointmentDeletingId === appointment.id}
                              onClick={() => deleteAppointment(appointment)}
                            >
                              <Trash2 size={15} aria-hidden="true" />
                            </button>
                          </div>
                        </li>
                      ))}
                      {((!dashboardData?.ccm?.todayAppointments || dashboardData.ccm.todayAppointments.length === 0) && appointments.length === 0) && (
                        <li className="empty-state" style={{ textAlign: 'center', display: 'block', padding: '24px 0' }}>
                          No appointments scheduled for team today.
                        </li>
                      )}
                    </ul>
                  </article>
                </section>
              </section>
            ) : currentRole === 'GM' ? (
              <section className="customer-workspace gm-dashboard">
                <div className="quick-actions-bar">
                  <span className="quick-actions-label">Quick Actions:</span>
                  <button type="button" className="quick-action-btn primary" onClick={() => setActiveView('Workshop Performance')}>
                    <Activity size={15} aria-hidden="true" /> Service Analytics (Workshop Performance)
                  </button>
                  <button type="button" className="quick-action-btn" onClick={openReports}>
                    <BarChart3 size={15} aria-hidden="true" /> CRM Reports & Productivity
                  </button>
                  <button type="button" className="quick-action-btn" onClick={openAllocations}>
                    <ClipboardList size={15} aria-hidden="true" /> Vehicle Allocations
                  </button>
                  <button type="button" className="quick-action-btn" onClick={openImports}>
                    <Upload size={15} aria-hidden="true" /> Repair Order Imports
                  </button>
                </div>

                <section className="stats-grid">
                  <article className="stat-card">
                    <p>Total Workshop Customers</p>
                    <strong>{dashboardData?.totalCustomers ?? 0}</strong>
                    <span>Registered in CRM</span>
                  </article>

                  <article className="stat-card">
                    <p>Active Vehicles Fleet</p>
                    <strong>{dashboardData?.activeVehicles ?? 0}</strong>
                    <span>Workshop database</span>
                  </article>

                  <article className="stat-card">
                    <p>Calls Logged Today</p>
                    <strong>{dashboardData?.gm?.todayCallsTotal ?? dashboardData?.todaysCalls ?? 0}</strong>
                    <span>{dashboardData?.gm?.todayPickedUpTotal ?? 0} connected</span>
                  </article>

                  <article className="stat-card">
                    <p>Workshop Appointments Today</p>
                    <strong>{dashboardData?.appointmentCount ?? 0}</strong>
                    <span>{dashboardData?.conversionRate ?? 0}% conversion</span>
                  </article>
                </section>

                <section className="content-grid">
                  <article className="panel">
                    <div className="panel-header">
                      <h3>CCM Team Productivity Today</h3>
                      <span>{(dashboardData?.gm?.teamBreakdowns || []).length} teams</span>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Team / CCM</th>
                            <th>Active CREs</th>
                            <th>Calls Today</th>
                            <th>Connected</th>
                            <th>Appointments</th>
                            <th>Fleet Vehicles</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(dashboardData?.gm?.teamBreakdowns || []).map((t) => (
                            <tr key={t.id}>
                              <td><strong>{t.name}</strong></td>
                              <td>{t.creCount}</td>
                              <td>{t.callsMade}</td>
                              <td>{t.callsPickedUp}</td>
                              <td>{t.appointmentsToday}</td>
                              <td>{t.vehiclesCount}</td>
                            </tr>
                          ))}
                          {(!dashboardData?.gm?.teamBreakdowns || dashboardData.gm.teamBreakdowns.length === 0) && (
                            <tr>
                              <td colSpan="6" className="empty-state">No CCM teams configured yet.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>

                  <article className="panel">
                    <div className="panel-header">
                      <h3>Today&apos;s Workshop Appointments</h3>
                      <span>{(dashboardData?.gm?.todayAppointments || appointments).length} total</span>
                    </div>
                    {dashboardData?.gm?.appointmentStatusCounts && (
                      <div className="status-pill-list">
                        {Object.entries(dashboardData.gm.appointmentStatusCounts).map(([status, count]) => (
                          <span key={status} className="status-pill">
                            {status.toLowerCase()}: <strong>{count}</strong>
                          </span>
                        ))}
                      </div>
                    )}
                    <ul className="stack-list">
                      {(dashboardData?.gm?.todayAppointments || appointments).map((appointment) => (
                        <li key={appointment.id || appointment.customer || appointment.time}>
                          <div>
                            <strong>{appointment.customer}</strong>
                            <small>{appointment.vehicle} {appointment.assigneeName ? `· ${appointment.assigneeName}` : ''}</small>
                          </div>
                          <div className="meta-block">
                            <span>{appointment.time || new Date(appointment.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            <span className="badge badge-blue">{appointment.status}</span>
                          </div>
                        </li>
                      ))}
                      {((!dashboardData?.gm?.todayAppointments || dashboardData.gm.todayAppointments.length === 0) && appointments.length === 0) && (
                        <li className="empty-state" style={{ textAlign: 'center', display: 'block', padding: '24px 0' }}>
                          No appointments scheduled today across workshop.
                        </li>
                      )}
                    </ul>
                  </article>
                </section>
              </section>
            ) : currentRole === 'ADMIN' ? (
              <section className="customer-workspace admin-dashboard">
                <div className="quick-actions-bar">
                  <span className="quick-actions-label">Admin Actions:</span>
                  <button type="button" className="quick-action-btn primary" onClick={openUserManagement}>
                    <UserCog size={15} aria-hidden="true" /> User Management
                  </button>
                  <button type="button" className="quick-action-btn" onClick={() => { openUserManagement(); startUserEdit(); }}>
                    <UserRoundPlus size={15} aria-hidden="true" /> + New User Account
                  </button>
                  <button type="button" className="quick-action-btn" onClick={openImports}>
                    <Upload size={15} aria-hidden="true" /> Import Repair Orders
                  </button>
                  <button type="button" className="quick-action-btn" onClick={openReports}>
                    <BarChart3 size={15} aria-hidden="true" /> Workshop Reports
                  </button>
                </div>

                <section className="stats-grid">
                  <article className="stat-card">
                    <p>Total User Accounts</p>
                    <strong>{dashboardData?.admin?.userStats?.total ?? 0}</strong>
                    <span>{dashboardData?.admin?.userStats?.active ?? 0} active accounts</span>
                  </article>

                  <article className="stat-card">
                    <p>User Role Breakdown</p>
                    <strong style={{ fontSize: '1.25rem' }}>
                      {dashboardData?.admin?.userStats?.byRole?.cre ?? dashboardData?.admin?.userStats?.cre ?? 0} CREs · {dashboardData?.admin?.userStats?.byRole?.freeServiceCre ?? 0} Free-Service CREs · {dashboardData?.admin?.userStats?.byRole?.ccm ?? dashboardData?.admin?.userStats?.ccm ?? 0} CCMs
                    </strong>
                    <span>
                      {dashboardData?.admin?.userStats?.byRole?.gm ?? dashboardData?.admin?.userStats?.gm ?? 0} GMs · {dashboardData?.admin?.userStats?.byRole?.admin ?? dashboardData?.admin?.userStats?.admin ?? 0} Admins
                      {(dashboardData?.admin?.userStats?.inactive || 0) > 0 ? ` · ${dashboardData.admin.userStats.inactive} inactive` : ''}
                    </span>
                  </article>

                  <article className="stat-card">
                    <p>Imported Repair Orders</p>
                    <strong>{dashboardData?.importedRows ?? 0}</strong>
                    <span>{dashboardData?.admin?.recentBatches?.length ?? 0} batches tracked</span>
                  </article>

                  <article className="stat-card">
                    <p>Pending VIN Conflicts</p>
                    <strong>{dashboardData?.pendingVinConflicts ?? 0}</strong>
                    <span>Flagged for review</span>
                  </article>
                </section>

                <section className="content-grid">
                  <article className="panel">
                    <div className="panel-header">
                      <h3>Recent Repair Order Imports</h3>
                      <button type="button" className="text-link" onClick={openImports}>View import workspace</button>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>File Name</th>
                            <th>Date</th>
                            <th>Total Rows</th>
                            <th>Created</th>
                            <th>Appended</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(dashboardData?.admin?.recentBatches || []).map((b) => (
                            <tr key={b.id}>
                              <td><strong>{b.fileName}</strong></td>
                              <td>{new Date(b.createdAt).toLocaleDateString()}</td>
                              <td>{b.totalRows}</td>
                              <td>{b.createdRows}</td>
                              <td>{b.appendedRows}</td>
                              <td><span className={`badge ${b.status === 'completed' ? 'badge-success' : 'badge-neutral'}`}>{b.status}</span></td>
                            </tr>
                          ))}
                          {(!dashboardData?.admin?.recentBatches || dashboardData.admin.recentBatches.length === 0) && (
                            <tr>
                              <td colSpan="6" className="empty-state">No import batches recorded yet.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>

                  <article className="panel">
                    <div className="panel-header">
                      <h3>Recent System Audit Logs</h3>
                      <span>Latest activity</span>
                    </div>
                    <ul className="stack-list">
                      {(dashboardData?.admin?.recentAuditLogs || []).map((log) => (
                        <li key={log.id}>
                          <div>
                            <strong>{log.action?.replace('_', ' ')}</strong>
                            <small>{log.actor} · {log.entityType}</small>
                          </div>
                          <div className="meta-block">
                            <span>{new Date(log.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            <span className="badge badge-neutral">{new Date(log.createdAt).toLocaleDateString()}</span>
                          </div>
                        </li>
                      ))}
                      {(!dashboardData?.admin?.recentAuditLogs || dashboardData.admin.recentAuditLogs.length === 0) && (
                        <li className="empty-state" style={{ textAlign: 'center', display: 'block', padding: '24px 0' }}>
                          No audit logs recorded yet.
                        </li>
                      )}
                    </ul>
                  </article>
                </section>
              </section>
            ) : (
              <section className="stats-grid">
                {summary.map((card) => (
                  <article key={card.label} className="stat-card">
                    <p>{card.label}</p>
                    <strong>{card.value}</strong>
                    <span>{card.change}</span>
                  </article>
                ))}
              </section>
            )}
          </>
        )}
      </main>

      {appointmentConfirmDelete && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-delete-dialog-title">
          <div className="modal-card">
            <h3 id="confirm-delete-dialog-title">Delete Appointment</h3>
            <p>
              Are you sure you want to delete the appointment for{' '}
              <strong>{appointmentConfirmDelete.customer || appointmentConfirmDelete.customerName}</strong>
              {appointmentConfirmDelete.vehicle ? ` (${appointmentConfirmDelete.vehicle})` : ''}?
            </p>
            <p className="modal-warning">
              This action cannot be undone and will remove the scheduled slot from the workshop queue.
            </p>
            <div className="form-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button
                type="button"
                className="outline-btn"
                disabled={Boolean(appointmentDeletingId)}
                onClick={() => setAppointmentConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-btn"
                disabled={Boolean(appointmentDeletingId)}
                onClick={() => confirmDeleteAppointment(appointmentConfirmDelete)}
              >
                {appointmentDeletingId ? 'Deleting…' : 'Delete Appointment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
