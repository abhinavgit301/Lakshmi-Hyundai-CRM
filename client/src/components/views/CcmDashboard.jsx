import { Activity, BarChart3, CalendarDays, ClipboardList, Trash2, Upload } from 'lucide-react';
import { formatDate } from '../../utils/crmHelpers.js';

export default function CcmDashboard(props) {
  const {
    allocationCres,
    appointmentDeletingId,
    appointments,
    callError,
    dashboardData,
    deleteAppointment,
    freeServiceCres,
    openAllocations,
    openAppointments,
    openCustomerProfile,
    openImports,
    openPerformanceBoard,
    quotaNotices,
    setActiveView,
  } = props;
  return (
    <>
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
                            <strong><button type="button" className="text-link" onClick={() => openCustomerProfile({
                              customerId: appointment.customerId,
                              vehicleId: appointment.vehicleId,
                              name: appointment.customer,
                            })}>{appointment.customer}</button></strong>
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
                {callError && <p className="form-alert error" role="alert">{callError}</p>}
              </section>
    </>
  );
}
