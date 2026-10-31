import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { Activity, ArrowLeft, BarChart3, CalendarDays, CalendarPlus2, ChevronDown, ClipboardList, Clock3, Download, Gift, LayoutDashboard, ListFilter, LogOut, Plus, Upload, UserCog, UserRoundPlus, UsersRound } from 'lucide-react';
import api from './lib/api.js';
import { listCache } from './lib/listCache.js';
import { beginRequest, isCanceled } from './lib/requestControl.js';

import { SectionSkeleton } from './components/Skeletons.jsx';
import AccordionFilters from './components/AccordionFilters.jsx';
import MasterCallTable from './components/MasterCallTable.jsx';
import ServiceListTable from './components/ServiceListTable.jsx';
import { useStableCallback } from './hooks/useStableCallback.js';
import { monthOptions } from './utils/months.js';
import { buildUserTree, dueViews, followUpViews, localDateKey, masterCsvLabels, masterListQuery } from './utils/crmHelpers.js';

const UserManagementPanel = lazy(() => import('./components/UserManagementPanel.jsx'));
const CcmProfilePanel = lazy(() => import('./components/CcmProfilePanel.jsx'));
const PerformanceBoardPanel = lazy(() => import('./components/views/PerformanceBoardPanel.jsx'));
const PerformancePanel = lazy(() => import('./components/views/PerformancePanel.jsx'));
const AllocationsPanel = lazy(() => import('./components/views/AllocationsPanel.jsx'));
const ReportsPanel = lazy(() => import('./components/views/ReportsPanel.jsx'));
const ImportsPanel = lazy(() => import('./components/views/ImportsPanel.jsx'));
const AppointmentsPanel = lazy(() => import('./components/views/AppointmentsPanel.jsx'));
const MasterCallListPanel = lazy(() => import('./components/views/MasterCallListPanel.jsx'));
const CustomerListsPanel = lazy(() => import('./components/views/CustomerListsPanel.jsx'));
const FreeServiceCreDashboard = lazy(() => import('./components/views/FreeServiceCreDashboard.jsx'));
const CreDashboard = lazy(() => import('./components/views/CreDashboard.jsx'));
const CcmDashboard = lazy(() => import('./components/views/CcmDashboard.jsx'));
const GmDashboard = lazy(() => import('./components/views/GmDashboard.jsx'));
const AdminDashboard = lazy(() => import('./components/views/AdminDashboard.jsx'));
const DefaultDashboard = lazy(() => import('./components/views/DefaultDashboard.jsx'));
const CustomerProfilePage = lazy(() => import('./components/views/CustomerProfilePage.jsx'));
const CustomerActionPanel = lazy(() => import('./components/views/CustomerActionPanel.jsx'));
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
const customerListRouteAliases = {
  '/customer/1-year': 'Due 1-Year',
  '/customer/1-year-due': 'Due 1-Year',
  '/customer/one-year-due': 'Due 1-Year',
  '/customer/due-1-year': 'Due 1-Year',
  '/customer/6-month': 'Due 6-Month',
  '/customer/6-month-due': 'Due 6-Month',
  '/customer/6-months-due': 'Due 6-Month',
  '/customer/6month-due': 'Due 6-Month',
  '/customer/due-6-month': 'Due 6-Month',
  '/customer/free-service': 'Free Service',
  '/customer/warranty': 'Warranty',
  '/customers/1-year': 'Due 1-Year',
  '/customers/1-year-due': 'Due 1-Year',
  '/customers/one-year-due': 'Due 1-Year',
  '/customers/due-1-year': 'Due 1-Year',
  '/customers/6-month': 'Due 6-Month',
  '/customers/6-month-due': 'Due 6-Month',
  '/customers/6-months-due': 'Due 6-Month',
  '/customers/6month-due': 'Due 6-Month',
  '/customers/due-6-month': 'Due 6-Month',
  '/customers/free-service': 'Free Service',
  '/customers/warranty': 'Warranty',
};

function resolveRoute(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  const customerListView = customerListRouteAliases[path];
  if (customerListView) return { view: customerListView, ccmId: '' };
  const knownView = viewByRoute[path];
  if (knownView) return { view: knownView, ccmId: '' };
  const customerProfileMatch = path.match(/^\/customers\/([^/]+)$/);
  if (customerProfileMatch) {
    const customerId = (() => {
      try {
        return decodeURIComponent(customerProfileMatch[1]);
      } catch {
        return '';
      }
    })();
    return { view: 'CustomerProfile', customerId, ccmId: '' };
  }
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
  if (view === 'CustomerProfile') return Boolean(user) && ['ADMIN', 'GM', 'CCM', 'CRE'].includes(role);
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
function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const activeRoute = resolveRoute(location.pathname);
  const activeView = activeRoute.view;
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const currentRole = String(currentUser?.role || '').toUpperCase();
  const currentUserId = currentUser?.id ?? null;
  const [authChecked, setAuthChecked] = useState(false);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [summary, setSummary] = useState([]);
  const [calls, setCalls] = useState([]);
  const [masterListLoading, setMasterListLoading] = useState(false);
  const [masterListLoadingMore, setMasterListLoadingMore] = useState(false);
  const [masterListPageInfo, setMasterListPageInfo] = useState({ total: 0, hasMore: false, offset: 0 });
  const [masterListError, setMasterListError] = useState('');
  const [masterListMessage, setMasterListMessage] = useState('');
  const [masterListCres, setMasterListCres] = useState([]);
  const [masterListCcms, setMasterListCcms] = useState([]);
  const [masterListSearch, setMasterListSearch] = useState('');
  const [masterListCreFilter, setMasterListCreFilter] = useState('');
  const [masterListDueFilter, setMasterListDueFilter] = useState('');
  const [masterListRepairFilter, setMasterListRepairFilter] = useState('');
  const [masterListSavingId, setMasterListSavingId] = useState(null);
  const [masterEntryFormOpen, setMasterEntryFormOpen] = useState(false);
  const [masterEntrySaving, setMasterEntrySaving] = useState(false);
  const [customerProfile, setCustomerProfile] = useState(null);
  const [customerProfileVehicleId, setCustomerProfileVehicleId] = useState('');
  const [customerProfileLoading, setCustomerProfileLoading] = useState(false);
  const [customerProfileError, setCustomerProfileError] = useState('');
  const [customerProfileTab, setCustomerProfileTab] = useState('service');
  const [expandedServiceVisit, setExpandedServiceVisit] = useState(null);
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
  const [dueRecordsView, setDueRecordsView] = useState('');
  const [duePageInfo, setDuePageInfo] = useState({});
  const [dueLoadingMore, setDueLoadingMore] = useState({});
  const [followUpPageInfo, setFollowUpPageInfo] = useState({});
  const [followUpsLoadingMore, setFollowUpsLoadingMore] = useState({});
  const [dueLoading, setDueLoading] = useState(false);
  const [dueError, setDueError] = useState('');
  const [dueSearch, setDueSearch] = useState('');
  const [dueAppliedFilters, setDueAppliedFilters] = useState({});
  const [followUpSearch, setFollowUpSearch] = useState('');
  const [followUpAppliedFilters, setFollowUpAppliedFilters] = useState({});
  const [accordionDueCategoryFilter, setAccordionDueCategoryFilter] = useState('');
  const [accordionRepairTypeFilter, setAccordionRepairTypeFilter] = useState('');
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
  const masterListRequestRef = useRef(0);
  const masterListControllerRef = useRef({});
  const masterListLoadMoreRef = useRef(false);
  const dueRequestRef = useRef({});
  const dueLoadMoreRef = useRef({});
  const followUpRequestRef = useRef({});
  const followUpLoadMoreRef = useRef({});
  const masterListAppliedFiltersRef = useRef('');
  const [initialDataLoading, setInitialDataLoading] = useState(true);
  const [initialDataError, setInitialDataError] = useState('');
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
  const [performanceDate, setPerformanceDate] = useState(() => localDateKey(new Date()));
  const [performanceRange, setPerformanceRange] = useState('day');
  const [performanceCreId, setPerformanceCreId] = useState('');
  const [followUps, setFollowUps] = useState([]);
  const [followUpsSource, setFollowUpsSource] = useState('');
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
  const [permanentDeletion, setPermanentDeletion] = useState(null);
  const [permanentDeletionPreviewLoading, setPermanentDeletionPreviewLoading] = useState(false);
  const [permanentDeletionSaving, setPermanentDeletionSaving] = useState(false);
  const [permanentDeletionError, setPermanentDeletionError] = useState('');
  const [importCcmId, setImportCcmId] = useState('');
  const [importHistoryCcmId, setImportHistoryCcmId] = useState('');
  const [importHistoryCcms, setImportHistoryCcms] = useState([]);
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
  const customerCallModalRef = useRef(null);
  const userSavingRef = useRef(false);
  const importRequestKeyRef = useRef(null);
  const initialLoadPromiseRef = useRef(null);
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

    if (!initialLoadPromiseRef.current) {
      initialLoadPromiseRef.current = (async () => {
        const userResponse = await api.get('/auth/me');
        const user = userResponse.data.user;
        const role = String(user?.role || '').toUpperCase();
        setCurrentUser(user);
        const requests = [
          api.get('/dashboard/summary'),
          ['CCM', 'CRE', 'FREE_SERVICE_CRE', 'GM', 'ADMIN'].includes(role)
            ? api.get('/appointments')
            : Promise.resolve({ data: { appointments: [] } }),
        ];
        if (['CCM', 'CRE'].includes(role)) requests.push(api.get('/call-list?limit=50&offset=0'));
        if (role === 'CCM') requests.push(api.get('/teams'));
        const [summaryResponse, appointmentResponse, masterResponse, teamResponse] = await Promise.all(requests);
        return { user, role, summaryResponse, appointmentResponse, masterResponse, teamResponse };
      })();
    }
    initialLoadPromiseRef.current.then(({
      user, role, summaryResponse, appointmentResponse, masterResponse, teamResponse,
    }) => {
      if (!isMounted) return;
      setCurrentUser(user);
      setDashboardData(summaryResponse.data);
      if (masterResponse) {
        setCalls(masterResponse.data.records || []);
        setMasterListPageInfo({
          total: masterResponse.data.total || 0,
          hasMore: masterResponse.data.hasMore === true,
          offset: masterResponse.data.offset || 0,
        });
      }
      if (teamResponse) {
        setAllocationCres(teamResponse.data.cres || []);
        setMasterListCcms(teamResponse.data.ccms || []);
      }
      setSummary([
        { label: 'Total customers', value: summaryResponse.data.totalCustomers, change: 'Current total' },
        { label: 'Active vehicles', value: summaryResponse.data.activeVehicles, change: 'Current total' },
        { label: 'Calls today', value: summaryResponse.data.todaysCalls, change: `${summaryResponse.data.pendingFollowUps} follow-ups pending` },
        { label: 'Appointments', value: summaryResponse.data.appointmentCount, change: 'Today' },
      ]);
      setAppointments(appointmentResponse.data.appointments || []);
      if (role === 'CCM') {
        api.get('/notifications/quota').then((response) => {
          if (isMounted) setQuotaNotices(response.data);
        }).catch((error) => console.warn('Could not load CCM quota notices.', error));
      } else {
        setQuotaNotices(null);
      }
    }).catch((error) => {
      if (!isMounted) return;
      if (error.response?.status !== 401) {
        console.error('Dashboard load failed.', error);
        setInitialDataError(error.response?.data?.message || 'We could not load the data required to open your workspace.');
      } else {
        setCurrentUser(null);
      }
    }).finally(() => {
      if (!isMounted) return;
      setAuthChecked(true);
      setInitialDataLoading(false);
      setLoading(false);
    });

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
      initialLoadPromiseRef.current = null;
      setInitialDataLoading(true);
      setInitialDataError('');
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
      setInitialDataError('');
      setInitialDataLoading(false);
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

  const refreshMasterList = useCallback(async (filters, { offset = 0, append = false } = {}) => {
    const requestId = masterListRequestRef.current + 1;
    masterListRequestRef.current = requestId;
    masterListAppliedFiltersRef.current = JSON.stringify(filters);
    const cacheKey = `${currentUserId}|master|${JSON.stringify(filters)}`;
    const cached = !append && offset === 0 ? listCache.get(cacheKey) : null;
    if (cached) {
      setCalls(cached.records);
      setMasterListPageInfo(cached.pageInfo);
      setMasterListError('');
      setMasterListLoading(false);
      setMasterListLoadingMore(false);
      return;
    }
    const controller = beginRequest(masterListControllerRef.current, 'master');
    const startedGeneration = listCache.generation();
    if (append) setMasterListLoadingMore(true);
    else setMasterListLoading(true);
    setMasterListError('');
    try {
      const response = await api.get(`/call-list${masterListQuery({ ...filters, offset })}`, { signal: controller.signal });
      if (requestId === masterListRequestRef.current) {
        const nextRecords = response.data.records || [];
        const pageInfo = {
          total: response.data.total || 0,
          hasMore: response.data.hasMore === true,
          offset: response.data.offset || 0,
        };
        setCalls((current) => append
          ? [...current, ...nextRecords.filter((record) => !current.some((existing) => existing.id === record.id))]
          : nextRecords);
        setMasterListPageInfo(pageInfo);
        if (!append && offset === 0) listCache.set(cacheKey, { records: nextRecords, pageInfo }, startedGeneration);
      }
    } catch (error) {
      if (isCanceled(error)) return;
      if (requestId === masterListRequestRef.current) {
        setMasterListError(error.response?.data?.message || 'Could not load the master call list.');
      }
    } finally {
      if (requestId === masterListRequestRef.current) {
        setMasterListLoading(false);
        setMasterListLoadingMore(false);
      }
    }
  }, [currentUserId]);

  async function loadMoreMasterList() {
    if (masterListLoadMoreRef.current || !masterListPageInfo.hasMore) return;
    masterListLoadMoreRef.current = true;
    try {
      await refreshMasterList({
        search: masterListSearch,
        creId: masterListCreFilter,
        dueCategory: masterListDueFilter,
        repairType: masterListRepairFilter,
      }, { offset: masterListPageInfo.offset + 50, append: true });
    } finally {
      masterListLoadMoreRef.current = false;
    }
  }

  async function openMasterList() {
    setActiveView('Master list');
    const filters = {
      search: masterListSearch,
      creId: masterListCreFilter,
      dueCategory: masterListDueFilter,
      repairType: masterListRepairFilter,
    };
    try {
      const requests = [refreshMasterList(filters)];
      if (String(currentUser?.role || '').toUpperCase() === 'CCM') {
        requests.push(api.get('/teams'));
      } else if (['ADMIN', 'GM'].includes(String(currentUser?.role || '').toUpperCase())) {
        requests.push(api.get('/teams'));
      }
      const [, teamsResponse] = await Promise.all(requests);
      setMasterListCres(teamsResponse?.data?.cres || []);
      setMasterListCcms(teamsResponse?.data?.ccms || []);
    } catch (error) {
      setMasterListError(error.response?.data?.message || 'Could not load the master call list.');
    }
  }

  async function changeMasterListAssignee(recordId, assigneeId, record) {
    setMasterListSavingId(recordId);
    setMasterListError('');
    try {
      const response = record?.allocationOnly
        ? await api.patch(`/allocations/${record.allocationId}`, { creId: assigneeId })
        : await api.patch(`/allocations/master-call-list/${recordId}/assignee`, { assigneeId });
      const assignment = record?.allocationOnly
        ? {
          assigneeId: response.data.allocation.creId,
          assigneeName: response.data.allocation.cre?.name || null,
        }
        : response.data.record;
      setCalls((current) => current.map((record) => record.id === recordId
        ? { ...record, ...assignment }
        : record));
      // Due, Free Service and Warranty rows carry their master-list record id as `recordId` (or `id`).
      setDueRecords((current) => current.map((record) => (record.recordId || record.id) === recordId
        ? { ...record, assigneeId: assignment.assigneeId, assigneeName: assignment.assigneeName }
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

  const loadDueData = useCallback(async (viewName, {
    offset = 0,
    append = false,
    search = dueSearch,
    dueCategory = accordionDueCategoryFilter,
    repairType = accordionRepairTypeFilter,
  } = {}) => {
    const view = dueViews[viewName];
    if (append && dueLoadMoreRef.current[viewName]) return;
    if (append) dueLoadMoreRef.current[viewName] = true;
    const requestId = (dueRequestRef.current[viewName] || 0) + 1;
    dueRequestRef.current[viewName] = requestId;
    if (append) setDueLoadingMore((current) => ({ ...current, [viewName]: true }));
    else {
      setDueLoading(true);
      setDueRecords([]);
    }
    setDueError('');
    try {
      const params = new URLSearchParams({ limit: '50', offset: String(offset) });
      if (search.trim()) params.set('search', search.trim());
      if (dueCategory) params.set('dueCategory', dueCategory);
      if (repairType) params.set('repairType', repairType);
      if (view.kind === 'due') params.set('window', view.window);
      const endpoint = `${view.kind === 'free' ? '/free-service' : view.kind === 'warranty' ? '/warranty' : '/call-list/due'}?${params}`;
      const requests = [api.get(endpoint)];
      if (!append && currentRole === 'CCM') requests.push(api.get('/teams'));
      const [dueResponse, teamResponse] = await Promise.all(requests);
      if (requestId !== dueRequestRef.current[viewName]) return;
      const nextRecords = dueResponse.data.records || [];
      setDueRecordsView(viewName);
      setDueRecords((current) => append
        ? [...current, ...nextRecords.filter((record) => !current.some((existing) => existing.id === record.id))]
        : nextRecords);
      setDuePageInfo((current) => ({
        ...current,
        [viewName]: {
          total: dueResponse.data.total || 0,
          hasMore: dueResponse.data.hasMore === true,
          offset: dueResponse.data.offset || 0,
        },
      }));
      setDueIssues(dueResponse.data.dataIssues || []);
      if (teamResponse) {
        setAllocationCres(teamResponse.data.cres || []);
        setMasterListCcms(teamResponse.data.ccms || []);
      }
    } catch (error) {
      if (requestId === dueRequestRef.current[viewName]) {
        setDueError(error.response?.data?.message || 'Could not load this customer list.');
      }
    } finally {
      if (requestId === dueRequestRef.current[viewName]) {
        setDueLoading(false);
        setDueLoadingMore((current) => ({ ...current, [viewName]: false }));
      }
      if (append) dueLoadMoreRef.current[viewName] = false;
    }
  }, [currentRole, dueSearch, accordionDueCategoryFilter, accordionRepairTypeFilter]);

  async function loadMoreDueData() {
    const page = duePageInfo[activeView];
    if (dueLoadingMore[activeView] || !page?.hasMore) return;
    await loadDueData(activeView, {
      offset: page.offset + 50,
      append: true,
    });
  }

  function openDueList(viewName) {
    if ((viewName === 'Free Service' && !canAccessFreeService) || (viewName === 'Warranty' && !canAccessWarranty)) return;
    setDueAppliedFilters((current) => ({ ...current, [viewName]: '' }));
    setActiveView(viewName);
    setCustomersMenuOpen(true);
    setDueSearch('');
    setAccordionDueCategoryFilter('');
    setAccordionRepairTypeFilter('');
    setDueRecords([]);
    setDueIssues([]);
    setDuePageInfo((current) => ({ ...current, [viewName]: { total: 0, hasMore: false, offset: 0 } }));
    setCustomerPanel({ customerId: null, mode: 'options' });
    setCallError('');
    setCallMessage('');
  }

  async function openDueCustomer(record, mode) {
    let customer = customers.find((entry) => entry.id === record.customerId);
    setDueError('');
    if (mode === 'call') {
      if (!customer) {
        try {
          const response = await api.get('/customers');
          const records = response.data.customers || [];
          setCustomers(records);
          customer = records.find((entry) => entry.id === record.customerId);
        } catch (error) {
          setDueError(error.response?.data?.message || 'Could not load this customer.');
          return;
        }
      }
      if (!customer) {
        setDueError('This customer is not available. Reload the list and try again.');
        return;
      }
      startCall(customer, record.vehicleId, {
        callSource: record.callSource || dueViews[activeView]?.callSource || 'SERVICE',
        milestoneId: record.milestoneId || '',
      });
    } else await openCustomerProfile({ ...record, ...(customer || {}) });
  }

  async function loadCustomerProfile(customerId) {
    if (!customerId) {
      setCustomerProfileError('This customer does not have a profile linked to the CRM.');
      setCustomerProfileLoading(false);
      return;
    }
    setCustomerProfileLoading(true);
    setCustomerProfileError('');
    setCustomerProfile(null);
    setCustomerProfileTab('service');
    setExpandedServiceVisit(null);
    setCustomerPanel({ customerId, mode: 'profile' });
    setCallLogs([]);
    setCallLogsLoading(true);
    const [customerResult, callLogResult] = await Promise.allSettled([
      api.get('/customers'),
      api.get(`/call-logs?customerId=${encodeURIComponent(customerId)}`),
    ]);
    if (customerResult.status === 'fulfilled') {
      const availableCustomers = customerResult.value.data.customers || [];
      setCustomers(availableCustomers);
      const matchedCustomer = availableCustomers.find((entry) => entry.id === customerId);
      if (matchedCustomer) {
        setCustomerProfile({ ...matchedCustomer, customerId });
      } else {
        setCustomerProfileError('This customer is not available to your account.');
      }
    } else {
      setCustomerProfileError(customerResult.reason.response?.data?.message || 'Could not load this customer profile.');
    }
    if (callLogResult.status === 'fulfilled') {
      setCallLogs(callLogResult.value.data.callLogs || []);
    } else {
      setCustomerProfileError((current) => current || callLogResult.reason.response?.data?.message || 'Could not load call history.');
    }
    setCustomerProfileLoading(false);
    setCallLogsLoading(false);
  }

  async function openCustomerProfile(customer) {
    const hasCustomerId = Boolean(customer.customerId || (!Object.hasOwn(customer, 'customerId') && customer.id));
    const customerId = customer.customerId || (!Object.hasOwn(customer, 'customerId') ? customer.id : null);
    if (!hasCustomerId || !customerId) {
      const message = 'This master-list record is not linked to a customer profile.';
      if (activeView === 'Master list') setMasterListError(message);
      else setCallError(message);
      return;
    }
    setMasterListError('');
    setCustomerProfileError('');
    setCustomerProfileVehicleId(customer.vehicleId || '');
    navigate(`/customers/${encodeURIComponent(customerId)}`);
    await loadCustomerProfile(customerId);
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
          const [, summaryResponse] = await Promise.all([
            refreshMasterList({
              search: masterListSearch,
              creId: masterListCreFilter,
              dueCategory: masterListDueFilter,
              repairType: masterListRepairFilter,
            }),
            api.get('/dashboard/summary'),
          ]);
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

  const loadFollowUps = useCallback(async (source, { offset = 0, append = false, search = followUpSearch } = {}) => {
    const requestKey = source;
    if (append && followUpLoadMoreRef.current[requestKey]) return;
    if (append) followUpLoadMoreRef.current[requestKey] = true;
    const requestId = (followUpRequestRef.current[requestKey] || 0) + 1;
    followUpRequestRef.current[requestKey] = requestId;
    if (append) setFollowUpsLoadingMore((current) => ({ ...current, [requestKey]: true }));
    else {
      setFollowUpsLoading(true);
      setFollowUps([]);
    }
    setFollowUpError('');
    try {
      const params = new URLSearchParams({ source, limit: '50', offset: String(offset) });
      if (search.trim()) params.set('search', search.trim());
      const requests = [api.get(`/follow-ups?${params}`)];
      if (!append) {
        requests.push(api.get('/call-list?limit=50&offset=0'));
        if (source === 'FREE_SERVICE') requests.push(api.get('/free-service?limit=50&offset=0'));
        if (source === 'WARRANTY') requests.push(api.get('/warranty?limit=50&offset=0'));
      }
      const [followUpResponse, recordsResponse, sourceListResponse] = await Promise.all(requests);
      if (requestId !== followUpRequestRef.current[requestKey]) return;
      const next = followUpResponse.data.followUps || [];
      setFollowUpsSource(source);
      setFollowUps((current) => append
        ? [...current, ...next.filter((followUp) => !current.some((existing) => existing.id === followUp.id))]
        : next);
      setFollowUpPageInfo((current) => ({
        ...current,
        [requestKey]: {
          total: followUpResponse.data.total || 0,
          hasMore: followUpResponse.data.hasMore === true,
          offset: followUpResponse.data.offset || 0,
        },
      }));
      if (sourceListResponse) setFollowUpListRecords(sourceListResponse.data.records || []);
      else if (recordsResponse) setFollowUpListRecords(recordsResponse.data.records || []);
    } catch (error) {
      if (requestId === followUpRequestRef.current[requestKey]) {
        setFollowUpError(error.response?.data?.message || 'Could not load follow-ups. Sign in and try again.');
      }
    } finally {
      if (requestId === followUpRequestRef.current[requestKey]) {
        setFollowUpsLoading(false);
        setFollowUpsLoadingMore((current) => ({ ...current, [requestKey]: false }));
      }
      if (append) followUpLoadMoreRef.current[requestKey] = false;
    }
  }, [followUpSearch]);

  async function loadMoreFollowUps() {
    const key = followUpViews[activeView]?.source;
    const page = followUpPageInfo[key];
    if (followUpsLoadingMore[key] || !page?.hasMore) return;
    await loadFollowUps(key, { offset: page.offset + 50, append: true });
  }

  function openFollowUpList(viewName) {
    if ((viewName === 'Follow-up Free Service' && !canAccessFreeService) || (viewName === 'Follow-up Warranty' && !canAccessWarranty)) return;
    setFollowUpAppliedFilters((current) => ({ ...current, [followUpViews[viewName].source]: '' }));
    setActiveView(viewName);
    setFollowUpMenuOpen(true);
    setFollowUps([]);
    setFollowUpSearch('');
    setAccordionDueCategoryFilter('');
    setAccordionRepairTypeFilter('');
    setDueError('');
    setCustomerPanel({ customerId: null, mode: 'options' });
    setCallError('');
    setCallMessage('');
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

  async function loadPerformance(year, month, creId, freeServiceSelected, date = performanceDate, range = performanceRange) {
    setPerformanceLoading(true);
    setPerformanceError('');
    try {
      const params = new URLSearchParams({ year: String(year), month: String(month) });
      if (creId) params.set('creId', creId);
      if (date) params.set('date', date);
      params.set('range', range);
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
    const now = new Date();
    const selectedYear = Number(year);
    const selectedMonth = selectedYear === now.getFullYear()
      ? Math.min(Number(month), now.getMonth() + 1)
      : Number(month);
    const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
    const selectedDay = Math.min(Number(performanceDate.slice(-2)), lastDay);
    let nextDate = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(selectedDay).padStart(2, '0')}`;
    if (nextDate > localDateKey(now)) nextDate = localDateKey(now);
    setPerformanceYear(selectedYear);
    setPerformanceMonth(selectedMonth);
    setPerformanceDate(nextDate);
    if (currentRole === 'CRE' || currentRole === 'FREE_SERVICE_CRE' || creId) {
      loadPerformance(selectedYear, selectedMonth, creId, undefined, nextDate);
    }
    else setPerformance(null);
  }

  function changePerformanceDate(date) {
    if (!date) return;
    const [year, month] = date.split('-').map(Number);
    setPerformanceRange('day');
    setPerformanceDate(date);
    setPerformanceYear(year);
    setPerformanceMonth(month);
    if (currentRole === 'CRE' || currentRole === 'FREE_SERVICE_CRE' || performanceCreId) {
      loadPerformance(year, month, performanceCreId, undefined, date, 'day');
    }
  }

  function changePerformanceRange(range) {
    setPerformanceRange(range);
    if (currentRole === 'CRE' || currentRole === 'FREE_SERVICE_CRE' || performanceCreId) {
      loadPerformance(performanceYear, performanceMonth, performanceCreId, undefined, performanceDate, range);
    }
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
    const today = localDateKey(now);
    setPerformanceDate(today);
    setPerformanceRange('day');
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
          today,
          'day',
        );
      }
      else setPerformance(null);
      return;
    }
    await loadPerformance(now.getFullYear(), now.getMonth() + 1, '', undefined, today, 'day');
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

  async function refreshImportHistory(ccmId = importHistoryCcmId) {
    const params = currentRole === 'ADMIN' && ccmId ? { ccmId } : {};
    const response = await api.get('/imports/history', { params });
    setImports(response.data.imports || []);
    return response;
  }

  async function changeImportHistoryCcm(ccmId) {
    setImportHistoryCcmId(ccmId);
    setImportsLoading(true);
    setImportError('');
    try {
      await refreshImportHistory(ccmId);
    } catch (error) {
      setImportError(error.response?.data?.message || 'Could not filter import history.');
    } finally {
      setImportsLoading(false);
    }
  }

  async function openImports() {
    setActiveView('Imports');
    setImportsLoading(true);
    setImportError('');
    try {
      const requests = [refreshImportHistory()];
      if (['ADMIN', 'GM'].includes(String(currentUser?.role || '').toUpperCase())) {
        requests.push(api.get('/teams'));
      }
      if (String(currentUser?.role || '').toUpperCase() === 'ADMIN') {
        requests.push(api.get('/users'));
      }
      const [, teamsResponse, usersResponse] = await Promise.all(requests);
      if (teamsResponse) {
        const ccms = teamsResponse.data.ccms || [];
        setMasterListCcms(ccms);
        if (!ccms.some((ccm) => ccm.ccmId === importCcmId)) setImportCcmId(ccms.length === 1 ? ccms[0].ccmId : '');
      } else if (String(currentUser?.role || '').toUpperCase() === 'CCM') {
        setImportCcmId(currentUser?.ccmId || '');
      }
      if (usersResponse) {
        setImportHistoryCcms((usersResponse.data.users || []).filter((user) => user.role === 'CCM'));
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
      const [, callListResponse] = await Promise.all([
        refreshImportHistory(),
        api.get('/call-list'),
      ]);
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
      const [, callListResponse, customersResponse] = await Promise.all([
        refreshImportHistory(),
        api.get('/call-list'),
        api.get('/customers'),
      ]);
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

  async function openPermanentDeletionPreview(batch) {
    if (!batch || permanentDeletionPreviewLoading || permanentDeletionSaving) return;
    setPermanentDeletionPreviewLoading(true);
    setPermanentDeletionError('');
    try {
      const response = await api.get(`/imports/${encodeURIComponent(batch.id)}/permanent-deletion/preview`);
      setPermanentDeletion({ batch, preview: response.data });
    } catch (error) {
      setPermanentDeletionError(error.response?.data?.message || 'Could not prepare the permanent-deletion preview.');
    } finally {
      setPermanentDeletionPreviewLoading(false);
    }
  }

  async function confirmPermanentDeletion() {
    if (!permanentDeletion || permanentDeletionSaving) return;
    setPermanentDeletionSaving(true);
    setPermanentDeletionError('');
    setImportMessage('');
    let deletionCommitted = false;
    try {
      const response = await api.delete(
        `/imports/${encodeURIComponent(permanentDeletion.batch.id)}/permanent-deletion`,
        { data: { confirmationToken: permanentDeletion.preview.confirmationToken } },
      );
      deletionCommitted = response.data.status === 'permanently_deleted';
      if (!deletionCommitted) throw new Error('The server did not confirm permanent deletion.');
      setPermanentDeletion(null);
      const { summary } = response.data;
      const recordsChanged = summary.totalRecordsDeleted
        + summary.existingRecordsRestored
        + summary.existingRecordsRebased;
      const retainedPhysicalVehicleIds = summary.physicalVehicleIdentitiesRetained
        .map(({ id, vin }) => vin || id)
        .join(', ');
      setImportMessage(recordsChanged === 0
        ? `Import ${permanentDeletion.batch.fileName} was marked permanently deleted; no business records were changed.`
        : `Import ${permanentDeletion.batch.fileName} reversed: ${summary.totalRecordsDeleted} records deleted, ${summary.existingRecordsRestored} restored, ${summary.existingRecordsRebased} rebased, ${summary.recordsPreserved} preserved. PhysicalVehicle identities retained: ${retainedPhysicalVehicleIds || 'none'}.`);
      const [, callListResponse, customersResponse] = await Promise.all([
        refreshImportHistory(),
        api.get('/call-list'),
        api.get('/customers'),
      ]);
      setCalls(callListResponse.data.records || []);
      setCustomers(customersResponse.data.customers || []);
      await refreshDashboardSummary();
    } catch (error) {
      const message = error.response?.data?.message || 'Could not complete permanent deletion.';
      if (deletionCommitted) {
        setImportMessage(`Permanent deletion committed, but some interface data could not refresh: ${message}`);
      } else {
        setPermanentDeletionError(message);
      }
    } finally {
      setPermanentDeletionSaving(false);
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
  const canAccessFreeService = currentRole !== 'CRE' || currentUser?.freeServiceEnabled === true;
  const canAccessWarranty = currentRole !== 'CRE' || currentUser?.warrantyEnabled === true;
  const viewingFreeServicePerformance = currentRole === 'FREE_SERVICE_CRE' || freeServiceCres.some((user) => user.id === performanceCreId);
  const displayedImports = currentRole === 'ADMIN' && importHistoryCcmId
    ? imports.filter((batch) => batch.ccmId === importHistoryCcmId)
    : imports;
  const performanceDateLabel = performanceRange === 'month'
    ? `${monthOptions[performanceMonth - 1]} ${performanceYear}`
    : new Date(`${performanceDate}T12:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
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
  useEffect(() => {
    if (activeView !== 'Master list' || !['CCM', 'CRE'].includes(currentRole)) return undefined;
    const filters = {
      search: masterListSearch,
      creId: masterListCreFilter,
      dueCategory: masterListDueFilter,
      repairType: masterListRepairFilter,
    };
    if (JSON.stringify(filters) === masterListAppliedFiltersRef.current) return undefined;
    const timeout = window.setTimeout(() => {
      refreshMasterList(filters);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [activeView, currentRole, masterListSearch, masterListCreFilter, masterListDueFilter, masterListRepairFilter, refreshMasterList]);
  useEffect(() => {
    if (!(activeView in dueViews)) return undefined;
    const signature = JSON.stringify({
      viewName: activeView,
      search: dueSearch,
      dueCategory: accordionDueCategoryFilter,
      repairType: accordionRepairTypeFilter,
    });
    if (signature === dueAppliedFilters[activeView]) return undefined;
    const timeout = window.setTimeout(() => {
      setDueAppliedFilters((current) => ({ ...current, [activeView]: signature }));
      loadDueData(activeView, {
        search: dueSearch,
        dueCategory: accordionDueCategoryFilter,
        repairType: accordionRepairTypeFilter,
      });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [activeView, dueSearch, accordionDueCategoryFilter, accordionRepairTypeFilter, loadDueData, dueAppliedFilters]);
  useEffect(() => {
    if (!(activeView in followUpViews)) return undefined;
    const signature = JSON.stringify({ viewName: activeView, search: followUpSearch });
    const source = followUpViews[activeView].source;
    if (signature === followUpAppliedFilters[source]) return undefined;
    const timeout = window.setTimeout(() => {
      setFollowUpAppliedFilters((current) => ({ ...current, [source]: signature }));
      loadFollowUps(source, { search: followUpSearch });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [activeView, followUpSearch, loadFollowUps, followUpAppliedFilters]);
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
  const panelCustomer = customerProfile?.id === customerPanel.customerId
    ? customerProfile
    : customers.find((customer) => customer.id === customerPanel.customerId);
  const isTeamRole = currentRole === 'CRE' || currentRole === 'CCM';
  const isFreeServiceRole = currentRole === 'FREE_SERVICE_CRE';

  function renderCustomerActionPanel() {
    if (!panelCustomer) return null;
    return (
      <Suspense fallback={<SectionSkeleton />}>
        <CustomerActionPanel
          activeView={activeView}
          callError={callError}
          callForm={callForm}
          callLogs={callLogs}
          callLogsLoading={callLogsLoading}
          callMessage={callMessage}
          callSaving={callSaving}
          currentRole={currentRole}
          currentUser={currentUser}
          customerCallModalRef={customerCallModalRef}
          customerPanel={customerPanel}
          customerProfileVehicleId={customerProfileVehicleId}
          getMasterDetailLabel={getMasterDetailLabel}
          navigate={navigate}
          openCustomerProfile={openCustomerProfile}
          panelCustomer={panelCustomer}
          setCallForm={setCallForm}
          setCustomerPanel={setCustomerPanel}
          startCall={startCall}
          submitCall={submitCall}
        />
      </Suspense>
    );
  }

  function renderCustomerProfilePage() {
    if (!customerProfile) return null;
    return (
      <Suspense fallback={<SectionSkeleton />}>
        <CustomerProfilePage
          callLogs={callLogs}
          callLogsLoading={callLogsLoading}
          currentRole={currentRole}
          currentUser={currentUser}
          customerPanel={customerPanel}
          customerProfile={customerProfile}
          customerProfileTab={customerProfileTab}
          customerProfileVehicleId={customerProfileVehicleId}
          expandedServiceVisit={expandedServiceVisit}
          getMasterDetailLabel={getMasterDetailLabel}
          renderCustomerActionPanel={renderCustomerActionPanel}
          setCustomerProfileTab={setCustomerProfileTab}
          setExpandedServiceVisit={setExpandedServiceVisit}
          startCall={startCall}
        />
      </Suspense>
    );
  }

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
  const visibleDueRecords = dueRecords.filter((record) => matchesAccordionFilters(record, dueSearchTerm));
  const allocationSearchTerm = allocationSearch.trim().toLowerCase();
  const allocationRecords = currentRole === 'CCM'
    ? masterRecords.filter((record) => Boolean(record.assigneeId) || record.allocationQueue)
    : masterRecords;
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
  const visibleFollowUpTableRecords = followUpTableRecords.filter((record) => matchesAccordionFilters(record, followUpSearchTerm));
  const visibleFollowUps = followUps.filter((followUp) => {
    const record = (followUp.vehicleId && followUpListRecords.find((entry) => entry.vehicleId === followUp.vehicleId))
      || (followUp.vehicleId && calls.find((entry) => entry.vehicleId === followUp.vehicleId))
      || followUpListRecords.find((entry) => entry.customerId === followUp.customer.id)
      || calls.find((entry) => entry.customerId === followUp.customer.id);
    return matchesAccordionFilters({
      ...record,
      name: followUp.customer.fullName || record?.name,
      mobile: followUp.customer.mobileNumber || record?.mobile,
      vin: followUp.vehicle?.vin || record?.vin,
      model: followUp.vehicle?.model || record?.model,
      registrationNumber: followUp.vehicle?.registrationNumber || record?.registrationNumber,
      assigneeName: followUp.cre?.name || record?.assigneeName,
      repairOrderNo: record?.repairOrderNo,
    }, followUpSearchTerm);
  });
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

  function matchesAccordionFilters(record, search) {
    if (accordionDueCategoryFilter) {
      const dueCategory = record.dueCategory;
      if (accordionDueCategoryFilter === 'allDue') {
        if (!['6m', '1y'].includes(dueCategory)) return false;
      } else if (dueCategory !== accordionDueCategoryFilter) return false;
    }
    if (accordionRepairTypeFilter && record.type !== accordionRepairTypeFilter) return false;
    if (!search) return true;

    const searchValues = [
      record.name,
      record.customerName,
      record.mobile,
      record.mobileNumber,
      record.vin,
      record.model,
      record.registrationNumber,
      record.milestoneName,
      record.assigneeName,
      record.repairOrderNo,
      record.roNumber,
      ...(record.workshopVisits || []).flatMap((visit) => [
        visit.repairOrderNo,
        visit.importedDetails?.roNumber,
      ]),
    ];
    return searchValues.some((value) => String(value || '').toLowerCase().includes(search));
  }

  function renderAccordionFilters(search, setSearch, ariaLabel) {
    return (
      <AccordionFilters
        search={search}
        onSearchChange={setSearch}
        ariaLabel={ariaLabel}
        dueCategory={accordionDueCategoryFilter}
        onDueCategoryChange={setAccordionDueCategoryFilter}
        repairType={accordionRepairTypeFilter}
        onRepairTypeChange={setAccordionRepairTypeFilter}
      />
    );
  }

  function renderServiceListTable(kind, records = visibleDueRecords, followUpQueue = false, emptyMessage) {
    return (
      <ServiceListTable
        kind={kind}
        records={records}
        followUpQueue={followUpQueue}
        emptyMessage={emptyMessage}
        loading={dueLoading}
        currentRole={currentRole}
        onOpenCustomer={stableOpenDueCustomer}
        onChangeFollowUpStatus={stableChangeFollowUpStatus}
      />
    );
  }

  function renderMasterCallTable(records, loading, { assignable = false, dueMode = false, emptyMessage } = {}) {
    return (
      <MasterCallTable
        records={records}
        loading={loading}
        assignable={assignable}
        dueMode={dueMode}
        emptyMessage={emptyMessage}
        currentRole={currentRole}
        currentUserId={currentUser?.id}
        activeView={activeView}
        allocationCres={allocationCres}
        savingId={masterListSavingId}
        onOpenProfile={dueMode ? stableOpenDueProfile : stableOpenCustomerProfile}
        onStartCall={dueMode ? stableOpenDueCall : stableStartCallFromMasterRecord}
        onChangeAssignee={stableChangeMasterListAssignee}
      />
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
      'Master list': () => {
        if (calls.length === 0 && masterListPageInfo.total === 0) openMasterList();
      },
      Performance: openPerformance,
      'Performance Board': openPerformanceBoard,
      'User Management': openUserManagement,
      'Due 1-Year': () => { if (dueRecordsView !== 'Due 1-Year' || !dueRecords.length) openDueList('Due 1-Year'); },
      'Due 6-Month': () => { if (dueRecordsView !== 'Due 6-Month' || !dueRecords.length) openDueList('Due 6-Month'); },
      'Free Service': () => { if (dueRecordsView !== 'Free Service' || !dueRecords.length) openDueList('Free Service'); },
      Warranty: () => { if (dueRecordsView !== 'Warranty' || !dueRecords.length) openDueList('Warranty'); },
      'Follow-up Service': () => { if (followUpsSource !== 'SERVICE' || !followUps.length) openFollowUpList('Follow-up Service'); },
      'Follow-up Free Service': () => { if (followUpsSource !== 'FREE_SERVICE' || !followUps.length) openFollowUpList('Follow-up Free Service'); },
      'Follow-up Warranty': () => { if (followUpsSource !== 'WARRANTY' || !followUps.length) openFollowUpList('Follow-up Warranty'); },
      CcmProfile: (ccmId) => {
        if (currentRole === 'CCM') {
          openOwnMonthlyData();
        } else if (ccmId) {
          const ccm = managedTeams.ccms.find((team) => team.ccmId === ccmId);
          openCcmProfile(ccm || { ccmId, name: `CCM ${ccmId}` });
        }
      },
      CustomerProfile: (_ccmId, customerId) => {
        setCustomerProfileVehicleId('');
        loadCustomerProfile(customerId);
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
    const normalizedPath = location.pathname.replace(/\/+$/, '') || '/';
    const canonicalPath = customerListRouteAliases[normalizedPath]
      ? location.pathname
      : route.view === 'CustomerProfile' && route.customerId
        ? `/customers/${encodeURIComponent(route.customerId)}`
        : pathForView(route.view, route.ccmId);
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
      routeActionsRef.current[route.view]?.(route.ccmId, route.customerId);
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

  useEffect(() => {
    if (customerPanel.mode !== 'call') return undefined;
    customerCallModalRef.current?.focus();
    function handleCallModalKeyDown(event) {
      if (event.key === 'Escape' && !callSaving) {
        setCustomerPanel({ customerId: null, mode: 'options' });
      }
    }
    document.addEventListener('keydown', handleCallModalKeyDown);
    return () => document.removeEventListener('keydown', handleCallModalKeyDown);
  }, [activeView, callSaving, customerPanel.mode]);

  const stableOpenDueCustomer = useStableCallback(openDueCustomer);
  const stableOpenDueProfile = useStableCallback((record) => openDueCustomer(record, 'profile'));
  const stableOpenDueCall = useStableCallback((record) => openDueCustomer(record, 'call'));
  const stableChangeFollowUpStatus = useStableCallback(changeFollowUpStatus);
  const stableOpenCustomerProfile = useStableCallback(openCustomerProfile);
  const stableStartCallFromMasterRecord = useStableCallback(startCallFromMasterRecord);
  const stableChangeMasterListAssignee = useStableCallback(changeMasterListAssignee);

  if (!authChecked) {
    return (
      <main className="auth-loading" aria-live="polite">
        <div className="initial-progress" aria-hidden="true"><span /></div>
        <p>{initialDataLoading && currentUser ? 'Preparing your workspace…' : 'Checking session…'}</p>
      </main>
    );
  }

  if (initialDataError) {
    return (
      <main className="auth-loading initial-load-error" role="alert">
        <h1>Workspace could not be loaded</h1>
        <p>{initialDataError}</p>
        <button type="button" className="primary-btn" onClick={() => {
          setInitialDataError('');
          setInitialDataLoading(true);
          initialLoadPromiseRef.current = null;
          setAuthChecked(false);
          setSessionVersion((version) => version + 1);
        }}>Retry</button>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="auth-page">
        <div className="auth-shell">
          <section className="auth-brand-panel">
            <img className="brand-mark" src="/logo-256.webp" width="46" height="46" alt="Lakshmi Hyundai logo" />
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
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <img className="brand-mark" src="/logo-256.webp" width="46" height="46" alt="Lakshmi Hyundai logo" />
          <div>
            <p className="eyebrow">Workshop CRM</p>
            <h1>Lakshmi Hyundai</h1>
          </div>
        </div>

        <nav className="nav-list" aria-label="Sidebar navigation">
          {visibleNavItems.map((item) => {
            const NavIcon = navIcons[item];
            const accordion = navAccordions[item];
            const accordionHasActiveRoute = Boolean(accordion) && accordion.items.some((child) =>
              child.view === activeView || child.children?.some((nested) => nested.view === activeView),
            );
            const customerProfileActive = item === 'Customers' && activeView === 'CustomerProfile';
            const accordionOpen = Boolean(accordion) && (accordion.open || accordionHasActiveRoute || customerProfileActive);
            const navItemActive = item === activeView || accordionHasActiveRoute || customerProfileActive;
            return (
              <Fragment key={item}>
              <button
                type="button"
                title={item}
                aria-current={item === activeView && !accordion || customerProfileActive ? 'page' : undefined}
                aria-expanded={accordion ? accordionOpen : undefined}
                onClick={() => accordion ? accordion.toggle() : item === 'Dashboard' ? openDashboard() : item === 'Import' ? setActiveView('Free-Service Import') : item === 'Master list' ? openMasterList() : item === 'Customers' ? openCustomers() : item === 'Appointments' ? openAppointments() : item === 'Allocations' ? openAllocations() : item === 'Imports' ? openImports() : item === 'User Management' ? openUserManagement() : item === 'Monthly Data' ? openOwnMonthlyData() : item === 'Performance' ? openPerformance() : item === 'Reports' ? openReports() : setActiveView(item)}
                className={navItemActive ? 'nav-item active' : 'nav-item'}
              >
                <NavIcon size={18} strokeWidth={1.8} aria-hidden="true" />
                <span>{item}</span>
                {accordion && <ChevronDown className={accordionOpen ? 'nav-chevron open' : 'nav-chevron'} size={15} aria-hidden="true" />}
              </button>
              {accordionOpen && accordion.items.map((child) => {
                const SubIcon = child.icon;
                const childHasActiveRoute = child.children?.some((nested) => nested.view === activeView) || false;
                const childIsActive = child.view === activeView || childHasActiveRoute;
                const childExpanded = Boolean(child.children) && (child.expanded || childHasActiveRoute);
                return (
                  <Fragment key={child.view}>
                    <button
                      type="button"
                      title={child.label}
                      aria-current={child.view === activeView && !child.children ? 'page' : undefined}
                      aria-expanded={child.children ? childExpanded : undefined}
                      onClick={child.open}
                      className={childIsActive ? 'nav-item nav-subitem active' : 'nav-item nav-subitem'}
                    >
                      <SubIcon size={16} strokeWidth={1.8} aria-hidden="true" />
                      <span>{child.label}</span>
                      {child.children && <ChevronDown className={childExpanded ? 'nav-chevron open' : 'nav-chevron'} size={15} aria-hidden="true" />}
                    </button>
                    {childExpanded && child.children?.map((nested) => (
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
            <p className="eyebrow">{activeView === 'Free-Service Import' ? 'Free Service' : activeView.startsWith('Free-Service Customer') ? 'Free-Service customers' : activeView.startsWith('Free-Service Follow-up') ? 'Free-Service follow-up' : activeView in dueViews ? 'Service follow-up' : activeView in followUpViews ? 'Next actions' : activeView === 'Performance Board' ? 'Team activity' : activeView === 'User Management' ? 'Administration' : activeView === 'CcmProfile' ? 'CCM profile' : activeView === 'CustomerProfile' ? 'Customer record' : activeView === 'Master list' ? 'Customer follow-up' : activeView === 'Customers' ? 'Customer records' : activeView === 'Follow-ups' ? 'Next actions' : activeView === 'Appointments' ? 'Workshop schedule' : activeView === 'Allocations' ? 'CRE workload' : activeView === 'Imports' ? 'Repair orders' : activeView === 'Performance' ? 'Your activity' : activeView === 'Reports' ? 'CRM activity' : activeView === 'Workshop Performance' ? 'Service analytics' : 'Overview'}</p>
            <h2>{activeView === 'Free-Service Import' ? 'Import' : activeView.startsWith('Free-Service Customer') ? activeView.replace('Free-Service Customer · ', '') : activeView.startsWith('Free-Service Follow-up') ? `Follow-up · ${activeView.replace('Free-Service Follow-up · ', '')}` : activeView in dueViews ? dueViews[activeView].label : activeView in followUpViews ? `Follow-ups · ${followUpViews[activeView].label}` : activeView === 'Performance Board' ? 'Performance Board' : activeView === 'User Management' ? 'User Management' : activeView === 'CcmProfile' ? selectedCcm?.name || 'Monthly Customer Data' : activeView === 'CustomerProfile' ? customerProfile?.name || customerProfile?.fullName || 'Customer profile' : activeView === 'Master list' ? 'Master call list' : activeView === 'Customers' ? 'Customers and vehicles' : activeView === 'Follow-ups' ? 'Follow-up queue' : activeView === 'Appointments' ? 'Appointments' : activeView === 'Allocations' ? 'Vehicle allocations' : activeView === 'Imports' ? 'Repair-order imports' : activeView === 'Performance' ? 'Performance' : activeView === 'Reports' ? 'Reports' : activeView === 'Workshop Performance' ? 'Workshop Performance' : 'Service operations dashboard'}</h2>
          </div>
          {activeView === 'User Management' ? (
            <button type="button" className="primary-btn" onClick={() => startUserEdit()}><Plus size={16} aria-hidden="true" />New Account</button>
          ) : activeView === 'CcmProfile' ? (
            <button type="button" className="outline-btn" onClick={() => setActiveView(currentRole === 'ADMIN' ? 'User Management' : 'Dashboard')}><ArrowLeft size={16} aria-hidden="true" />{currentRole === 'ADMIN' ? 'Users' : 'Dashboard'}</button>
          ) : activeView === 'CustomerProfile' ? (
            <button type="button" className="outline-btn customer-profile-back-btn" onClick={() => navigate(-1)}>
              <ArrowLeft size={16} aria-hidden="true" />
              <span>Back</span>
            </button>
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
              <label className="performance-control">
                <span>View</span>
                <select aria-label="Performance range" value={performanceRange} onChange={(event) => changePerformanceRange(event.target.value)}>
                  <option value="day">Single day</option>
                  <option value="month">Whole month</option>
                </select>
              </label>
              <label className="performance-control">
                <span>Month</span>
                <select aria-label="Month" value={performanceMonth} onChange={(event) => changePerformancePeriod(performanceYear, Number(event.target.value))}>
                  {monthOptions.map((name, index) => <option key={name} value={index + 1} disabled={performanceYear === new Date().getFullYear() && index + 1 > new Date().getMonth() + 1}>{name}</option>)}
                </select>
              </label>
              <label className="performance-control">
                <span>Year</span>
                <select aria-label="Year" value={performanceYear} onChange={(event) => changePerformancePeriod(Number(event.target.value), performanceMonth)}>
                  {Array.from({ length: 5 }, (_, index) => new Date().getFullYear() - index).map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
              </label>
              {(currentRole === 'CRE' || currentRole === 'FREE_SERVICE_CRE' || (currentRole === 'CCM' && performanceCreId)) && (
                performanceRange === 'day' && <label className="performance-control performance-date-filter">
                  <span>Activity date</span>
                  <input
                    type="date"
                    aria-label="View performance for date"
                    value={performanceDate}
                    max={localDateKey(new Date())}
                    onChange={(event) => changePerformanceDate(event.target.value)}
                  />
                </label>
              )}
              {performanceLoading && <span className="live-indicator">Updating…</span>}
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
          <Suspense fallback={<p className="panel service-empty">Loading…</p>}>
            <UserManagementPanel
              closeUserForm={closeUserForm}
              currentRole={currentRole}
              currentUser={currentUser}
              deleteManagedAccount={deleteManagedAccount}
              editingUserId={editingUserId}
              managedTeams={managedTeams}
              managedUsers={managedUsers}
              managedUsersError={managedUsersError}
              managedUsersLoading={managedUsersLoading}
              managedUsersMessage={managedUsersMessage}
              openCcmProfile={openCcmProfile}
              passwordUnlocked={passwordUnlocked}
              setPasswordUnlocked={setPasswordUnlocked}
              setUserForm={setUserForm}
              startUserEdit={startUserEdit}
              submitManagedUser={submitManagedUser}
              toggleManagedUserStatus={toggleManagedUserStatus}
              userForm={userForm}
              userFormCloseButtonRef={userFormCloseButtonRef}
              userFormClosing={userFormClosing}
              userFormDialogRef={userFormDialogRef}
              userFormOpen={userFormOpen}
              userSaving={userSaving}
              userTree={userTree}
            />
          </Suspense>
        ) : activeView === 'CustomerProfile' ? (
          <section className="customer-workspace">
            {customerProfileLoading && <p className="performance-note" role="status">Loading customer profile…</p>}
            {customerProfileError && <p className="form-alert error" role="alert">{customerProfileError}</p>}
            {!customerProfileLoading && !customerProfileError && !customerProfile && (
              <p className="empty-state">Customer profile is not available.</p>
            )}
            {renderCustomerProfilePage()}
          </section>
        ) : activeView === 'CcmProfile' ? (
          <Suspense fallback={<p className="panel service-empty">Loading…</p>}>
            <CcmProfilePanel
              ccmProfile={ccmProfile}
              changeMonthlyPeriod={changeMonthlyPeriod}
              commitMonthlyImport={commitMonthlyImport}
              monthlyBusy={monthlyBusy}
              monthlyEntries={monthlyEntries}
              monthlyError={monthlyError}
              monthlyFile={monthlyFile}
              monthlyForm={monthlyForm}
              monthlyImports={monthlyImports}
              monthlyLoading={monthlyLoading}
              monthlyMessage={monthlyMessage}
              monthlyMonth={monthlyMonth}
              monthlyPreview={monthlyPreview}
              monthlyYear={monthlyYear}
              previewMonthlyImport={previewMonthlyImport}
              setMonthlyFile={setMonthlyFile}
              setMonthlyForm={setMonthlyForm}
              setMonthlyPreview={setMonthlyPreview}
              submitMonthlyEntry={submitMonthlyEntry}
            />
          </Suspense>
        ) : activeView === 'Performance Board' ? (
          <Suspense fallback={<SectionSkeleton />}>
            <PerformanceBoardPanel
              board={board}
              boardError={boardError}
              boardLoading={boardLoading}
            />
          </Suspense>
        ) : activeView === 'Performance' ? (
          <Suspense fallback={<SectionSkeleton />}>
            <PerformancePanel
              performance={performance}
              canAccessFreeService={canAccessFreeService}
              canAccessWarranty={canAccessWarranty}
              currentRole={currentRole}
              openCustomerProfile={openCustomerProfile}
              performanceCreId={performanceCreId}
              performanceDate={performanceDate}
              performanceDateLabel={performanceDateLabel}
              performanceError={performanceError}
              performanceLoading={performanceLoading}
              performanceMonth={performanceMonth}
              performanceRange={performanceRange}
              performanceYear={performanceYear}
              viewingFreeServicePerformance={viewingFreeServicePerformance}
            />
          </Suspense>
        ) : activeView === 'Allocations' ? (
          <Suspense fallback={<SectionSkeleton />}>
            <AllocationsPanel
              allocationCres={allocationCres}
              allocationError={allocationError}
              allocationForm={allocationForm}
              allocationFormOpen={allocationFormOpen}
              allocationMessage={allocationMessage}
              allocationSaving={allocationSaving}
              allocationSearch={allocationSearch}
              allocationTeamId={allocationTeamId}
              allocationVehicles={allocationVehicles}
              allocationsLoading={allocationsLoading}
              callError={callError}
              currentRole={currentRole}
              currentUser={currentUser}
              customerPanel={customerPanel}
              customers={customers}
              masterListCcms={masterListCcms}
              masterListError={masterListError}
              masterListTeam={masterListTeam}
              renderCustomerActionPanel={renderCustomerActionPanel}
              renderMasterCallTable={renderMasterCallTable}
              setAllocationForm={setAllocationForm}
              setAllocationFormOpen={setAllocationFormOpen}
              setAllocationSearch={setAllocationSearch}
              setMasterListTeam={setMasterListTeam}
              submitAllocation={submitAllocation}
              visibleAllocationRecords={visibleAllocationRecords}
            />
          </Suspense>
        ) : activeView === 'Reports' ? (
          <Suspense fallback={<SectionSkeleton />}>
            <ReportsPanel
              changeWorkshopFilter={changeWorkshopFilter}
              masterListCcms={masterListCcms}
              wpCcmId={wpCcmId}
              wpCreId={wpCreId}
              wpCres={wpCres}
              wpData={wpData}
              wpError={wpError}
              wpLoading={wpLoading}
              wpMaxBreakdown={wpMaxBreakdown}
              wpMaxDaily={wpMaxDaily}
              wpMaxOutcome={wpMaxOutcome}
              wpMonth={wpMonth}
              wpNow={wpNow}
              wpYear={wpYear}
              wpYears={wpYears}
            />
          </Suspense>
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
          <Suspense fallback={<SectionSkeleton />}>
            <ImportsPanel
              canImport={canImport}
              changeImportHistoryCcm={changeImportHistoryCcm}
              confirmPermanentDeletion={confirmPermanentDeletion}
              currentRole={currentRole}
              displayedImports={displayedImports}
              importCcmId={importCcmId}
              importError={importError}
              importFile={importFile}
              importHistoryCcmId={importHistoryCcmId}
              importHistoryCcms={importHistoryCcms}
              importMessage={importMessage}
              importRecoverySaving={importRecoverySaving}
              importRequestKeyRef={importRequestKeyRef}
              importResult={importResult}
              importRollbackBatch={importRollbackBatch}
              importRollbackError={importRollbackError}
              importRollbackSaving={importRollbackSaving}
              importUploading={importUploading}
              importsLoading={importsLoading}
              masterListCcms={masterListCcms}
              openPermanentDeletionPreview={openPermanentDeletionPreview}
              permanentDeletion={permanentDeletion}
              permanentDeletionError={permanentDeletionError}
              permanentDeletionPreviewLoading={permanentDeletionPreviewLoading}
              permanentDeletionSaving={permanentDeletionSaving}
              recoverImport={recoverImport}
              rollbackImport={rollbackImport}
              setImportCcmId={setImportCcmId}
              setImportFile={setImportFile}
              setImportMessage={setImportMessage}
              setImportRollbackBatch={setImportRollbackBatch}
              setImportRollbackError={setImportRollbackError}
              setPermanentDeletion={setPermanentDeletion}
              setPermanentDeletionError={setPermanentDeletionError}
              submitImport={submitImport}
            />
          </Suspense>
        ) : activeView === 'Appointments' ? (
          <Suspense fallback={<SectionSkeleton />}>
            <AppointmentsPanel
              appointmentDeletingId={appointmentDeletingId}
              appointmentError={appointmentError}
              appointmentForm={appointmentForm}
              appointmentFormOpen={appointmentFormOpen}
              appointmentMessage={appointmentMessage}
              appointmentSaving={appointmentSaving}
              appointments={appointments}
              appointmentsLoading={appointmentsLoading}
              callError={callError}
              changeAppointmentStatus={changeAppointmentStatus}
              currentRole={currentRole}
              customerPanel={customerPanel}
              customers={customers}
              dayAppointments={dayAppointments}
              deleteAppointment={deleteAppointment}
              openCustomerProfile={openCustomerProfile}
              renderCustomerActionPanel={renderCustomerActionPanel}
              selectedDay={selectedDay}
              setAppointmentForm={setAppointmentForm}
              setAppointmentFormOpen={setAppointmentFormOpen}
              setSelectedDay={setSelectedDay}
              submitAppointment={submitAppointment}
              weekDays={weekDays}
            />
          </Suspense>
        ) : activeView === 'Master list' ? (
          <Suspense fallback={<SectionSkeleton />}>
            <MasterCallListPanel
              callError={callError}
              callMessage={callMessage}
              currentRole={currentRole}
              customerPanel={customerPanel}
              loadMoreMasterList={loadMoreMasterList}
              masterEntryForm={masterEntryForm}
              masterEntryFormOpen={masterEntryFormOpen}
              masterEntrySaving={masterEntrySaving}
              masterListCcms={masterListCcms}
              masterListCreFilter={masterListCreFilter}
              masterListCres={masterListCres}
              masterListDueFilter={masterListDueFilter}
              masterListError={masterListError}
              masterListLoading={masterListLoading}
              masterListLoadingMore={masterListLoadingMore}
              masterListMessage={masterListMessage}
              masterListPageInfo={masterListPageInfo}
              masterListRepairFilter={masterListRepairFilter}
              masterListSearch={masterListSearch}
              masterListTeam={masterListTeam}
              masterRecords={masterRecords}
              renderCustomerActionPanel={renderCustomerActionPanel}
              renderMasterCallTable={renderMasterCallTable}
              setMasterEntryForm={setMasterEntryForm}
              setMasterEntryFormOpen={setMasterEntryFormOpen}
              setMasterListCreFilter={setMasterListCreFilter}
              setMasterListDueFilter={setMasterListDueFilter}
              setMasterListRepairFilter={setMasterListRepairFilter}
              setMasterListSearch={setMasterListSearch}
              setMasterListTeam={setMasterListTeam}
              submitMasterEntry={submitMasterEntry}
            />
          </Suspense>
        ) : activeView === 'Customers' || activeView in followUpViews || activeView in dueViews ? (
          <Suspense fallback={<SectionSkeleton />}>
            <CustomerListsPanel
              activeView={activeView}
              callError={callError}
              callFromFollowUp={callFromFollowUp}
              callMessage={callMessage}
              calls={calls}
              canCreateCustomer={canCreateCustomer}
              changeFollowUpStatus={changeFollowUpStatus}
              currentRole={currentRole}
              currentUser={currentUser}
              customerError={customerError}
              customerForm={customerForm}
              customerFormOpen={customerFormOpen}
              customerMessage={customerMessage}
              customerSaving={customerSaving}
              customers={customers}
              customersLoading={customersLoading}
              dueError={dueError}
              dueIssues={dueIssues}
              dueLoading={dueLoading}
              dueLoadingMore={dueLoadingMore}
              duePageInfo={duePageInfo}
              dueRecords={dueRecords}
              dueSearch={dueSearch}
              followUpError={followUpError}
              followUpPageInfo={followUpPageInfo}
              followUpSearch={followUpSearch}
              followUpServiceKind={followUpServiceKind}
              followUps={followUps}
              followUpsLoading={followUpsLoading}
              followUpsLoadingMore={followUpsLoadingMore}
              loadMoreDueData={loadMoreDueData}
              loadMoreFollowUps={loadMoreFollowUps}
              openCustomerProfile={openCustomerProfile}
              openDueCustomer={openDueCustomer}
              renderAccordionFilters={renderAccordionFilters}
              renderCustomerActionPanel={renderCustomerActionPanel}
              renderMasterCallTable={renderMasterCallTable}
              renderServiceListTable={renderServiceListTable}
              setCustomerForm={setCustomerForm}
              setCustomerFormOpen={setCustomerFormOpen}
              setDueSearch={setDueSearch}
              setFollowUpSearch={setFollowUpSearch}
              submitCustomer={submitCustomer}
              updateCustomerField={updateCustomerField}
              updateVehicleField={updateVehicleField}
              visibleDueRecords={visibleDueRecords}
              visibleFollowUpTableRecords={visibleFollowUpTableRecords}
              visibleFollowUps={visibleFollowUps}
            />
          </Suspense>
        ) : (
          <>
            {currentRole === 'FREE_SERVICE_CRE' ? (
            <Suspense fallback={<SectionSkeleton />}>
              <FreeServiceCreDashboard
                dashboardData={dashboardData}
              />
            </Suspense>
            ) : currentRole === 'CRE' ? (
            <Suspense fallback={<SectionSkeleton />}>
              <CreDashboard
                appointmentDeletingId={appointmentDeletingId}
                appointments={appointments}
                callError={callError}
                canAccessFreeService={canAccessFreeService}
                canAccessWarranty={canAccessWarranty}
                customerPanel={customerPanel}
                dashboardData={dashboardData}
                deleteAppointment={deleteAppointment}
                openCustomerProfile={openCustomerProfile}
                openDueCustomer={openDueCustomer}
                openDueList={openDueList}
                openFollowUpList={openFollowUpList}
                renderCustomerActionPanel={renderCustomerActionPanel}
                setActiveView={setActiveView}
                setAppointmentFormOpen={setAppointmentFormOpen}
              />
            </Suspense>
            ) : currentRole === 'CCM' ? (
            <Suspense fallback={<SectionSkeleton />}>
              <CcmDashboard
                allocationCres={allocationCres}
                appointmentDeletingId={appointmentDeletingId}
                appointments={appointments}
                callError={callError}
                dashboardData={dashboardData}
                deleteAppointment={deleteAppointment}
                freeServiceCres={freeServiceCres}
                openAllocations={openAllocations}
                openAppointments={openAppointments}
                openCustomerProfile={openCustomerProfile}
                openImports={openImports}
                openPerformanceBoard={openPerformanceBoard}
                quotaNotices={quotaNotices}
                setActiveView={setActiveView}
              />
            </Suspense>
            ) : currentRole === 'GM' ? (
            <Suspense fallback={<SectionSkeleton />}>
              <GmDashboard
                appointments={appointments}
                dashboardData={dashboardData}
                openAllocations={openAllocations}
                openImports={openImports}
                openReports={openReports}
                setActiveView={setActiveView}
              />
            </Suspense>
            ) : currentRole === 'ADMIN' ? (
            <Suspense fallback={<SectionSkeleton />}>
              <AdminDashboard
                dashboardData={dashboardData}
                openImports={openImports}
                openReports={openReports}
                openUserManagement={openUserManagement}
                startUserEdit={startUserEdit}
              />
            </Suspense>
            ) : (
            <Suspense fallback={<SectionSkeleton />}>
              <DefaultDashboard
                summary={summary}
              />
            </Suspense>
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
