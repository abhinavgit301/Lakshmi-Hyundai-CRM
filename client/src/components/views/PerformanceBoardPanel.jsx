import { dailyTargetLabels, formatDate } from '../../utils/crmHelpers.js';

export default function PerformanceBoardPanel(props) {
  const {
    board,
    boardError,
    boardLoading,
  } = props;
  return (
    <>
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
    </>
  );
}
