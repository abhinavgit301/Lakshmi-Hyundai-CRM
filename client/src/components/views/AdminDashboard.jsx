import { BarChart3, Upload, UserCog, UserRoundPlus } from 'lucide-react';

export default function AdminDashboard(props) {
  const {
    dashboardData,
    openImports,
    openReports,
    openUserManagement,
    startUserEdit,
  } = props;
  return (
    <>
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
                    <strong style={{ fontSize: 'calc(var(--crm-density-scale, 1) * 1.25rem)' }}>
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
                        <li className="empty-state" style={{ textAlign: 'center', display: 'block', padding: 'calc(var(--crm-density-scale, 1) * 24px) 0' }}>
                          No audit logs recorded yet.
                        </li>
                      )}
                    </ul>
                  </article>
                </section>
              </section>
    </>
  );
}
