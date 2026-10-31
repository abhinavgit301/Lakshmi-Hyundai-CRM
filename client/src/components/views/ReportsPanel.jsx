import { monthOptions } from '../../utils/months.js';

export default function ReportsPanel(props) {
  const {
    changeWorkshopFilter,
    masterListCcms,
    wpCcmId,
    wpCreId,
    wpCres,
    wpData,
    wpError,
    wpLoading,
    wpMaxBreakdown,
    wpMaxDaily,
    wpMaxOutcome,
    wpMonth,
    wpNow,
    wpYear,
    wpYears,
  } = props;
  return (
    <>
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
    </>
  );
}
