import express from 'express';
import { login, getCurrentUser, logout } from '../controllers/authController.js';
import {
  createCallLog,
  createFollowUp,
  getCrePerformanceSummary,
  getFreeServicePerformanceSummary,
  listCallLogs,
  listFollowUps,
  updateFollowUpStatus,
} from '../controllers/callWorkflowController.js';
import { createCustomer } from '../controllers/customerController.js';
import { getPerformanceBoard, getQuotaNotifications } from '../controllers/quotaController.js';
import { getFreeServiceList, getWarrantyList } from '../controllers/serviceListsController.js';
import { createAppointment, deleteAppointment, updateAppointment } from '../controllers/appointmentController.js';
import { getWorkshopPerformance } from '../controllers/workshopPerformanceController.js';
import { getWorkshopServicePerformance } from '../controllers/workshopServicePerformanceController.js';
import { exportWorkshopPerformancePdf, exportReportsPdf } from '../controllers/pdfExportController.js';
import { deleteImport, getImportHistory, importRepairOrders, permanentlyDeleteImport, previewPermanentDeletion, recoverImport } from '../controllers/importController.js';
import { createAllocation, listAllocations, updateAllocation } from '../controllers/allocationController.js';
import {
  createMonthlyCustomerEntry,
  getCcmProfile,
  getMonthlyCustomerData,
  getMonthlyCustomerImportHistory,
  importMonthlyCustomerData,
  previewMonthlyCustomerImport,
} from '../controllers/monthlyCustomerDataController.js';
import {
  getAppointments,
  getCallList,
  getCustomers,
  getDashboardSummary,
  getDueCallList,
  createManualCallListEntry,
  updateCallListAssignee,
} from '../controllers/recordsController.js';
import {
  assignUserToCcm,
  createUser,
  deleteManagedUser,
  getManagedUser,
  listTeams,
  listUsers,
  updateManagedUser,
  updateUserStatus,
} from '../controllers/userController.js';
import { authMiddleware, requireRole } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lakshmi-hyundai-crm-api', timestamp: new Date().toISOString() });
});

router.post('/auth/login', login);
router.post('/auth/logout', logout);
router.get('/auth/me', authMiddleware, getCurrentUser);

router.get('/dashboard/summary', authMiddleware, getDashboardSummary);

router.get('/users', authMiddleware, requireRole('Admin'), listUsers);
router.post('/users', authMiddleware, requireRole('Admin'), createUser);
router.get('/users/:id', authMiddleware, requireRole('Admin'), getManagedUser);
router.patch('/users/:id', authMiddleware, requireRole('Admin'), updateManagedUser);
router.patch('/users/:id/status', authMiddleware, requireRole('Admin'), updateUserStatus);
router.delete('/users/:id', authMiddleware, requireRole('Admin'), deleteManagedUser);
router.patch('/users/:id/ccm', authMiddleware, requireRole('Admin'), assignUserToCcm);
router.get('/ccms/:ccmId/profile', authMiddleware, requireRole('Admin'), getCcmProfile);
router.get('/ccms/:ccmId/monthly-customer-data', authMiddleware, requireRole('Admin', 'CCM', 'CRE'), getMonthlyCustomerData);
router.post('/ccms/:ccmId/monthly-customer-data', authMiddleware, requireRole('Admin', 'CCM', 'CRE'), createMonthlyCustomerEntry);
router.post('/ccms/:ccmId/monthly-customer-data/preview', authMiddleware, requireRole('Admin', 'CCM', 'CRE'), previewMonthlyCustomerImport);
router.post('/ccms/:ccmId/monthly-customer-data/import', authMiddleware, requireRole('Admin', 'CCM', 'CRE'), importMonthlyCustomerData);
router.get('/ccms/:ccmId/monthly-customer-data/history', authMiddleware, requireRole('Admin', 'CCM', 'CRE'), getMonthlyCustomerImportHistory);
router.get('/teams', authMiddleware, requireRole('Admin', 'GM', 'CCM'), listTeams);
router.get('/allocations', authMiddleware, listAllocations);
router.post('/allocations', authMiddleware, requireRole('Admin', 'GM'), createAllocation);
router.patch('/allocations/:id', authMiddleware, requireRole('Admin', 'GM', 'CCM'), updateAllocation);
router.patch('/allocations/master-call-list/:id/assignee', authMiddleware, requireRole('CCM'), updateCallListAssignee);

router.get('/call-list', authMiddleware, getCallList);
router.get('/call-list/due', authMiddleware, requireRole('CRE', 'CCM'), getDueCallList);
router.post('/call-list', authMiddleware, requireRole('Admin', 'GM', 'CCM'), createManualCallListEntry);
router.get('/customers', authMiddleware, getCustomers);
router.post('/customers', authMiddleware, requireRole('Admin', 'GM', 'CCM'), createCustomer);
router.get('/appointments', authMiddleware, requireRole('Admin', 'GM', 'CCM', 'CRE', 'Free-Service CRE'), getAppointments);
router.post('/appointments', authMiddleware, requireRole('CCM', 'CRE', 'Free-Service CRE'), createAppointment);
router.patch('/appointments/:id', authMiddleware, requireRole('CCM', 'CRE', 'Free-Service CRE'), updateAppointment);
router.delete('/appointments/:id', authMiddleware, requireRole('Admin', 'GM', 'CCM', 'CRE', 'Free-Service CRE'), deleteAppointment);
router.get('/call-logs', authMiddleware, requireRole('CCM', 'CRE'), listCallLogs);
router.get('/performance/summary', authMiddleware, requireRole('CRE', 'CCM'), getCrePerformanceSummary);
router.get('/performance/free-service', authMiddleware, requireRole('Free-Service CRE', 'CCM'), getFreeServicePerformanceSummary);
router.get('/performance/board', authMiddleware, requireRole('CCM'), getPerformanceBoard);
router.get('/notifications/quota', authMiddleware, requireRole('CCM'), getQuotaNotifications);
router.get('/free-service', authMiddleware, requireRole('CRE', 'CCM'), getFreeServiceList);
router.get('/warranty', authMiddleware, requireRole('CRE', 'CCM'), getWarrantyList);
router.get('/performance/workshop', authMiddleware, requireRole('Admin', 'GM'), getWorkshopPerformance);
router.get('/performance/workshop-services', authMiddleware, requireRole('Admin', 'GM', 'CCM'), getWorkshopServicePerformance);
router.get('/export/workshop-performance/pdf', authMiddleware, requireRole('Admin', 'GM', 'CCM'), exportWorkshopPerformancePdf);
router.get('/export/reports/pdf', authMiddleware, requireRole('Admin', 'GM'), exportReportsPdf);
router.post('/call-logs', authMiddleware, requireRole('CCM', 'CRE'), createCallLog);
router.get('/follow-ups', authMiddleware, requireRole('CCM', 'CRE'), listFollowUps);
router.post('/follow-ups', authMiddleware, requireRole('CCM', 'CRE'), createFollowUp);
router.patch('/follow-ups/:id/status', authMiddleware, requireRole('CCM', 'CRE'), updateFollowUpStatus);

router.get('/imports/history', authMiddleware, requireRole('Admin', 'GM', 'CCM'), getImportHistory);
router.post('/imports/repair-orders', authMiddleware, requireRole('Admin', 'GM', 'CCM'), importRepairOrders);
router.delete('/imports/:id', authMiddleware, requireRole('Admin'), deleteImport);
router.get('/imports/:id/permanent-deletion/preview', authMiddleware, requireRole('Admin'), previewPermanentDeletion);
router.delete('/imports/:id/permanent-deletion', authMiddleware, requireRole('Admin'), permanentlyDeleteImport);
router.post('/imports/:id/recover', authMiddleware, requireRole('Admin'), recoverImport);

router.get('/audit-log', authMiddleware, requireRole('Admin', 'GM', 'CCM'), (_req, res) => {
  return res.json({
    entries: [
      { id: 'audit-1', type: 'Repair Order Import', actor: 'Naveen Kumar', createdAt: '2026-10-01T09:17:00Z', summary: 'Imported 240 repair orders for Service Care' },
      { id: 'audit-2', type: 'Customer Update', actor: 'Priya S.', createdAt: '2026-10-02T11:00:00Z', summary: 'Updated appointment confirmation status' },
    ],
  });
});

export default router;
