import { CalendarClock, CalendarPlus2, Clock3, Gift, PhoneCall, ShieldCheck, Trash2 } from 'lucide-react';

export default function CreDashboard(props) {
  const {
    appointmentDeletingId,
    appointments,
    callError,
    canAccessFreeService,
    canAccessWarranty,
    customerPanel,
    dashboardData,
    deleteAppointment,
    openCustomerProfile,
    openDueCustomer,
    openDueList,
    openFollowUpList,
    renderCustomerActionPanel,
    setActiveView,
    setAppointmentFormOpen,
  } = props;
  return (
    <>
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
                                <strong><button type="button" className="text-link" onClick={() => openCustomerProfile({
                                  customerId: fu.customerId,
                                  vehicleId: fu.vehicleId,
                                  name: fu.customerName,
                                  mobile: fu.mobileNumber,
                                  model: fu.vehicleModel,
                                })}>{fu.customerName}</button></strong>
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
                            <strong><button type="button" className="text-link" onClick={() => openCustomerProfile({
                              customerId: appointment.customerId,
                              vehicleId: appointment.vehicleId,
                              name: appointment.customer,
                            })}>{appointment.customer}</button></strong>
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
                {callError && <p className="form-alert error" role="alert">{callError}</p>}
                {customerPanel.mode === 'call' && renderCustomerActionPanel()}
              </section>
    </>
  );
}
