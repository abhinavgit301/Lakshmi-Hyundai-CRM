import { Activity, CalendarCheck, CalendarClock, CalendarDays, Clock3, PhoneCall, ShieldCheck, UsersRound } from 'lucide-react';
import { formatDate } from '../../utils/crmHelpers.js';
import { monthOptions } from '../../utils/months.js';

export default function PerformancePanel(props) {
  const {
    performance,
    canAccessFreeService,
    canAccessWarranty,
    currentRole,
    openCustomerProfile,
    performanceCreId,
    performanceDate,
    performanceDateLabel,
    performanceError,
    performanceLoading,
    performanceMonth,
    performanceRange,
    performanceYear,
    viewingFreeServicePerformance,
  } = props;
  return (
    <>
          <section className="performance-workspace" aria-busy={performanceLoading}>
            {performanceError && <p className="form-alert error" role="alert">{performanceError}</p>}
            {currentRole === 'CCM' && !performanceCreId ? (
              <p className="form-alert info" role="status">Select a CRE above to view their performance.</p>
            ) : viewingFreeServicePerformance ? (
              <>
                <section className="performance-kpis" aria-label="Free-Service CRE performance metrics">
                  {[
                    [`Calls made · ${performanceDateLabel}`, performance?.dailyTargets?.callsMade, 120],
                    [`Pickups · ${performanceDateLabel}`, performance?.dailyTargets?.callsPickedUp, 80],
                  ].map(([label, metric, target]) => {
                    const actual = metric?.actual ?? 0;
                    const percent = Math.min(100, Math.round((actual / target) * 100));
                    return <article key={label} className="performance-kpi teal">
                      <div className="performance-kpi-heading"><span>{label}</span><PhoneCall size={17} aria-hidden="true" /></div>
                      <strong>{performanceRange === 'month' ? actual : `${actual} / ${target}`}</strong>
                      <small>{performanceRange === 'month' ? 'Total for selected month' : `${percent}% of daily target`}</small>
                      {performanceRange === 'day' && <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>}
                    </article>;
                  })}
                  {performanceRange === 'day' && <article className="performance-kpi coral">
                    <div className="performance-kpi-heading"><span>Calls this month</span><Activity size={17} aria-hidden="true" /></div>
                    <strong>{performance?.callsThisMonth ?? 0}</strong>
                    <small>Persisted Free-Service call activity</small>
                  </article>}
                </section>
                <section className="panel customer-list-panel">
                  <div className="panel-header"><h3>Historical daily activity</h3><span>{monthOptions[performanceMonth - 1]} {performanceYear}</span></div>
                  <div className="table-scroll"><table><thead><tr><th>Date</th><th>Calls made</th><th>Pickups achieved</th></tr></thead><tbody>
                    {(performance?.dailyPerformance || []).map((entry) => <tr key={entry.date} className={performanceRange === 'day' && entry.date === performanceDate ? 'performance-selected-day' : undefined}><td>{formatDate(`${entry.date}T12:00:00`)}</td><td>{entry.callsMade}</td><td>{entry.callsPickedUp}</td></tr>)}
                    {!performanceLoading && !(performance?.dailyPerformance || []).length && <tr><td colSpan="3" className="empty-state">No Free-Service call activity is recorded for this month.</td></tr>}
                  </tbody></table></div>
                </section>
              </>
            ) : (
            <>
            <section className="performance-kpis" aria-label="Performance metrics">
              {[
                { label: `Calls made · ${performanceDateLabel}`, value: performance?.dailyTargets ? (performanceRange === 'month' ? performance.dailyTargets.callsMade.actual : `${performance.dailyTargets.callsMade.actual} / ${performance.dailyTargets.callsMade.target}`) : performance ? 'N/A' : '—', detail: performanceRange === 'month' ? 'Total for selected month' : performance?.dailyTargets ? (performance.dailyTargets.callsMade.actual >= performance.dailyTargets.callsMade.target ? 'Daily target met' : `${performance.dailyTargets.callsMade.target - performance.dailyTargets.callsMade.actual} short of the daily target`) : 'Daily call activity', icon: PhoneCall, tone: 'coral' },
                { label: `Calls picked up · ${performanceDateLabel}`, value: performance?.dailyTargets ? (performanceRange === 'month' ? performance.dailyTargets.callsPickedUp.actual : `${performance.dailyTargets.callsPickedUp.actual} / ${performance.dailyTargets.callsPickedUp.target}`) : performance ? 'N/A' : '—', detail: performanceRange === 'month' ? 'Total for selected month' : performance?.dailyTargets ? (performance.dailyTargets.callsPickedUp.actual >= performance.dailyTargets.callsPickedUp.target ? 'Daily target met' : `${performance.dailyTargets.callsPickedUp.target - performance.dailyTargets.callsPickedUp.actual} short of the daily target`) : 'Daily call activity', icon: PhoneCall, tone: 'teal' },
                ...(performanceRange === 'day' ? [{
                  label: 'Calls this month',
                  value: performance?.callsThisMonth ?? '—',
                  detail: 'Since latest monthly-data load',
                  icon: Activity,
                  tone: 'teal',
                }] : []),
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
              <div className="panel-header"><h3>{performanceRange === 'month' ? `Calls during ${performanceDateLabel}` : `Calls on ${performanceDateLabel}`}</h3><span>{performanceLoading ? 'Loading…' : `${(performance?.recentCalls || []).length} calls`}</span></div>
              <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Vehicle</th><th>Outcome</th><th>When</th></tr></thead><tbody>
                {(performance?.recentCalls || []).map((call) => <tr key={call.id}>
                  <td>{call.customer?.id ? (
                    <button type="button" className="text-link" onClick={() => openCustomerProfile({
                      customerId: call.customer.id,
                      vehicleId: call.vehicle?.id,
                      name: call.customer.fullName,
                      mobile: call.customer.mobileNumber,
                    })}>{call.customer.fullName || 'Customer'}</button>
                  ) : call.customer?.fullName || 'Customer'}</td>
                  <td>{call.vehicle?.model || call.vehicle?.registrationNumber || call.vehicle?.vin || '—'}</td>
                  <td><span className="badge badge-neutral">{call.outcome.replaceAll('_', ' ')}</span></td>
                  <td>{new Date(call.createdAt).toLocaleString()}</td>
                </tr>)}
                {!performanceLoading && !performanceError && (performance?.recentCalls || []).length === 0 && <tr><td colSpan="4" className="empty-state">{performanceRange === 'month' ? 'No calls were logged during this month.' : 'No calls were logged on this date.'}</td></tr>}
              </tbody></table></div>
            </section>
            </>
            )}
          </section>
    </>
  );
}
