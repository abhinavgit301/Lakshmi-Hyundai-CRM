import { PhoneCall, X } from 'lucide-react';
import { formatOutcome, sortRepairOrderVisits } from '../../utils/crmHelpers.js';

export default function CustomerActionPanel(props) {
  const {
    activeView,
    callError,
    callForm,
    callLogs,
    callLogsLoading,
    callMessage,
    callSaving,
    currentRole,
    currentUser,
    customerCallModalRef,
    customerPanel,
    customerProfileVehicleId,
    getMasterDetailLabel,
    navigate,
    openCustomerProfile,
    panelCustomer,
    setCallForm,
    setCustomerPanel,
    startCall,
    submitCall,
  } = props;
    if (!panelCustomer) return null;
    const isCustomerCallModal = customerPanel.mode === 'call';
    const panelContents = (
      <section className="panel customer-action-panel">
        <div className="panel-header">
          <h3>{panelCustomer.name || panelCustomer.fullName}</h3>
          {!isCustomerCallModal && <button
            type="button"
            className="outline-btn compact-btn"
            data-call-modal-close
            onClick={() => {
              if (callSaving) return;
              if (activeView === 'CustomerProfile') navigate(-1);
              else setCustomerPanel({ customerId: null, mode: 'options' });
            }}
          >{activeView === 'CustomerProfile' ? 'Back' : 'Close'}</button>}
        </div>
        {customerPanel.mode === 'options' && (
          <div className="customer-options">
            {currentRole === 'CRE' && <button type="button" className="primary-btn" onClick={() => startCall(panelCustomer)}><PhoneCall size={16} aria-hidden="true" /> Call customer</button>}
            <button type="button" className="outline-btn" onClick={() => openCustomerProfile(panelCustomer)}>View profile</button>
          </div>
        )}
        {customerPanel.mode === 'call' && (
          <form className="customer-form call-modal-form" onSubmit={submitCall}>
            {callError && <p className="form-alert error" role="alert">{callError}</p>}
            {callMessage && <p className="form-alert success" role="status">{callMessage}</p>}
            <div className="call-modal-customer">
              <span className="call-modal-customer-avatar" aria-hidden="true">
                {(panelCustomer.name || panelCustomer.fullName || 'C').split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase()}
              </span>
              <div className="call-modal-customer-info">
                <strong>{panelCustomer.name || panelCustomer.fullName || 'Customer'}</strong>
                <span>{panelCustomer.mobile || panelCustomer.mobileNumber || 'No mobile number on file'}</span>
              </div>
              {(panelCustomer.mobile || panelCustomer.mobileNumber) && (
                <a className="outline-btn call-modal-phone-link" href={`tel:${panelCustomer.mobile || panelCustomer.mobileNumber}`}>
                  <PhoneCall size={16} aria-hidden="true" />Call now
                </a>
              )}
            </div>
            {callForm.callSource !== 'SERVICE' && (
              <p className="performance-note call-modal-context">{callForm.callSource === 'WARRANTY' ? 'Warranty call: it is tracked separately and does not count toward your daily call targets.' : 'Free-service call: the follow-up you arrange will appear under Follow-ups · Free Service.'}</p>
            )}
            <div className="form-grid">
              <label><span>Vehicle <span className="call-modal-optional">(Optional)</span></span>
                <select value={callForm.vehicleId} onChange={(event) => setCallForm({ ...callForm, vehicleId: event.target.value })}>
                  <option value="">No specific vehicle</option>
                  {(panelCustomer.vehicles || []).map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{[vehicle.model, vehicle.registrationNumber, vehicle.vin].filter(Boolean).join(' / ')}</option>)}
                </select>
              </label>
              <label>Call outcome
                <select required value={callForm.outcome} onChange={(event) => setCallForm({ ...callForm, outcome: event.target.value })}>
                  {['CONTACTED', 'NOT_INTERESTED', 'WRONG_NUMBER', 'NO_RESPONSE', 'OTHER'].map((outcome) => <option key={outcome} value={outcome}>{formatOutcome(outcome).replace(/\b\w/g, (letter) => letter.toUpperCase())}</option>)}
                </select>
              </label>
              <label className="full-width-field"><span>Feedback <span className="call-modal-optional">(Required)</span></span><textarea required rows="3" maxLength="2000" value={callForm.notes} onChange={(event) => setCallForm({ ...callForm, notes: event.target.value })} placeholder="Summarize the conversation and any important customer feedback." /></label>
              <fieldset className="full-width-field next-action call-modal-next-action">
                <legend>What happens next?</legend>
                {[['none', 'No further action'], ['followup', 'Arrange follow-up'], ['appointment', 'Arrange appointment']].map(([value, label]) => (
                  <label key={value} className={`radio-option ${callForm.nextAction === value ? 'selected' : ''}`}><input type="radio" name="nextAction" value={value} checked={callForm.nextAction === value} onChange={() => setCallForm({ ...callForm, nextAction: value, scheduledAt: value === 'none' ? '' : callForm.scheduledAt })} /> <span>{label}</span></label>
                ))}
              </fieldset>
              {callForm.nextAction !== 'none' && (
                <label className="full-width-field">{callForm.nextAction === 'followup' ? 'Follow-up date and time' : 'Appointment date and time'}
                  <input required type="datetime-local" value={callForm.scheduledAt} onChange={(event) => setCallForm({ ...callForm, scheduledAt: event.target.value })} />
                </label>
              )}
            </div>
            <div className="form-actions call-modal-actions">
              <button
                type="button"
                className="outline-btn"
                disabled={callSaving}
                onClick={() => setCustomerPanel(isCustomerCallModal
                  ? { customerId: null, mode: 'options' }
                  : { customerId: panelCustomer.id, mode: 'options' })}
              >{isCustomerCallModal ? 'Cancel' : 'Back'}</button>
              <button type="submit" className="primary-btn" disabled={callSaving}>{callSaving ? 'Saving…' : 'Save call'}</button>
            </div>
          </form>
        )}
        {customerPanel.mode === 'profile' && (
          <div className="customer-profile">
            {callLogsLoading && <p className="performance-note" role="status">Loading customer history…</p>}
            <dl className="master-detail-grid">
              <div><dt>Name</dt><dd>{panelCustomer.name || panelCustomer.fullName}</dd></div>
              <div><dt>Mobile</dt><dd>{panelCustomer.mobile || panelCustomer.mobileNumber || '—'}</dd></div>
              <div><dt>Email</dt><dd>{panelCustomer.email || '—'}</dd></div>
            </dl>
            <h4>Vehicles</h4>
            <div className="table-scroll"><table><thead><tr><th>Model</th><th>Reg. no.</th><th>VIN</th></tr></thead><tbody>
              {(panelCustomer.vehicles || []).map((vehicle) => <tr key={vehicle.id}><td>{vehicle.model || '—'}</td><td>{vehicle.registrationNumber || '—'}</td><td>{vehicle.vin || '—'}</td></tr>)}
              {!panelCustomer.vehicles?.length && <tr><td colSpan="3" className="empty-state">No vehicle details available.</td></tr>}
            </tbody></table></div>
            <h4>Repair history</h4>
            {sortRepairOrderVisits(panelCustomer.visits || []).map((visit) => (
              <div key={visit.repairOrderNo || visit.visitDate}>
                <h4>Repair order {visit.repairOrderNo || '—'}{visit.visitDate ? ` · ${new Date(visit.visitDate).toLocaleDateString()}` : ''}</h4>
                <dl className="master-detail-grid">
                  <div><dt>Closing date</dt><dd>{visit.closingDate ? new Date(visit.closingDate).toLocaleDateString() : '—'}</dd></div>
                  <div><dt>G.P. date</dt><dd>{visit.gpDate ? new Date(visit.gpDate).toLocaleDateString() : '—'}</dd></div>
                  <div><dt>Repair total</dt><dd>{visit.totalAmount ?? '—'}</dd></div>
                </dl>
                <dl className="master-detail-grid">
                  {Object.entries(visit.importedDetails || {}).map(([key, value]) => (
                    <div key={key}><dt>{getMasterDetailLabel(key)}</dt><dd>{value == null || value === '' ? '—' : String(value)}</dd></div>
                  ))}
                </dl>
              </div>
            ))}
            {!panelCustomer.visits?.length && !panelCustomer.importedDetails && <p className="empty-state">No repair history available.</p>}
            {!panelCustomer.visits?.length && panelCustomer.importedDetails && (
              <section className="master-visit-details">
                <h4>Imported repair details</h4>
                <dl className="master-detail-grid">
                  {Object.entries(panelCustomer.importedDetails).map(([key, value]) => (
                    <div key={key}><dt>{getMasterDetailLabel(key)}</dt><dd>{value == null || value === '' ? '—' : String(value)}</dd></div>
                  ))}
                </dl>
              </section>
            )}
            <h4>Call history</h4>
            <div className="table-scroll"><table><thead><tr><th>When</th><th>Outcome</th><th>CRE</th><th>Feedback</th></tr></thead><tbody>
              {callLogs.filter((call) => call.customer?.id === panelCustomer.id || call.customerId === panelCustomer.id).map((call) => <tr key={call.id}><td>{new Date(call.createdAt).toLocaleString()}</td><td>{call.outcome.replaceAll('_', ' ')}</td><td>{call.assignee?.name || call.creator?.name || '—'}</td><td>{call.notes || '—'}</td></tr>)}
              {!callLogsLoading && !callLogs.some((call) => call.customer?.id === panelCustomer.id || call.customerId === panelCustomer.id) && <tr><td colSpan="4" className="empty-state">No calls logged yet.</td></tr>}
            </tbody></table></div>
            <div className="form-actions">
              {currentRole === 'CRE' && panelCustomer.customerId && (
                <button type="button" className="primary-btn" onClick={() => startCall(
                  panelCustomer,
                  customerProfileVehicleId || panelCustomer.vehicles?.find((vehicle) => vehicle.allocations?.some((allocation) => allocation.creId === currentUser?.id))?.id,
                )}><PhoneCall size={16} aria-hidden="true" /> Call customer</button>
              )}
              <button type="button" className="outline-btn" onClick={() => setCustomerPanel({ customerId: panelCustomer.id, mode: 'options' })}>Back</button>
            </div>
          </div>
        )}
      </section>
    );
    if (!isCustomerCallModal) return panelContents;
    return (
      <div
        className="modal-backdrop master-call-modal-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !callSaving) setCustomerPanel({ customerId: null, mode: 'options' });
        }}
      >
        <div
          ref={customerCallModalRef}
          className="modal-card master-call-modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="master-call-modal-title"
          tabIndex={-1}
        >
          <div className="master-call-modal-heading">
            <div>
              <p className="eyebrow">Customer follow-up</p>
              <h2 id="master-call-modal-title">Log a call</h2>
            </div>
            <button type="button" className="icon-btn" aria-label="Close call dialog" disabled={callSaving} onClick={() => setCustomerPanel({ customerId: null, mode: 'options' })}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          {panelContents}
        </div>
      </div>
    );
}
