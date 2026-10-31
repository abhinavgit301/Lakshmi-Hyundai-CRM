export default function FreeServiceCreDashboard(props) {
  const {
    dashboardData,
  } = props;
  return (
    <>
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
    </>
  );
}
