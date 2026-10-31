import { Activity, BarChart3, ClipboardList, Upload } from 'lucide-react';

export default function GmDashboard(props) {
  const {
    appointments,
    dashboardData,
    openAllocations,
    openImports,
    openReports,
    setActiveView,
  } = props;
  return (
    <>
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
                        <li className="empty-state" style={{ textAlign: 'center', display: 'block', padding: 'calc(var(--crm-density-scale, 1) * 24px) 0' }}>
                          No appointments scheduled today across workshop.
                        </li>
                      )}
                    </ul>
                  </article>
                </section>
              </section>
    </>
  );
}
