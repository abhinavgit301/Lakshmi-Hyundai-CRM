import { PhoneCall, Plus, Trash2 } from 'lucide-react';
import { dueViews, followUpViews, formatVehicleAge } from '../../utils/crmHelpers.js';

export default function CustomerListsPanel(props) {
  const {
    activeView,
    callError,
    callFromFollowUp,
    callMessage,
    calls,
    canCreateCustomer,
    changeFollowUpStatus,
    currentRole,
    currentUser,
    customerError,
    customerForm,
    customerFormOpen,
    customerMessage,
    customerSaving,
    customers,
    customersLoading,
    dueError,
    dueIssues,
    dueLoading,
    dueLoadingMore,
    duePageInfo,
    dueRecords,
    dueSearch,
    followUpError,
    followUpPageInfo,
    followUpSearch,
    followUpServiceKind,
    followUps,
    followUpsLoading,
    followUpsLoadingMore,
    loadMoreDueData,
    loadMoreFollowUps,
    openCustomerProfile,
    openDueCustomer,
    renderAccordionFilters,
    renderCustomerActionPanel,
    renderMasterCallTable,
    renderServiceListTable,
    setCustomerForm,
    setCustomerFormOpen,
    setDueSearch,
    setFollowUpSearch,
    submitCustomer,
    updateCustomerField,
    updateVehicleField,
    visibleDueRecords,
    visibleFollowUpTableRecords,
    visibleFollowUps,
  } = props;
  return (
    <>
          <section className="customer-workspace">
            {activeView in followUpViews && followUpError && <p className="form-alert error" role="alert">{followUpError}</p>}
            {activeView in followUpViews && dueError && <p className="form-alert error" role="alert">{dueError}</p>}
            {customerError && <p className="form-alert error" role="alert">{customerError}</p>}
            {customerMessage && <p className="form-alert success" role="status">{customerMessage}</p>}
            {callError && <p className="form-alert error" role="alert">{callError}</p>}
            {callMessage && <p className="form-alert success" role="status">{callMessage}</p>}

            {activeView === 'Customers' && customerFormOpen && canCreateCustomer && (
              <form className="panel customer-form" onSubmit={submitCustomer}>
                <div className="panel-header">
                  <h3>New customer</h3>
                  <span>Customer details and registered vehicles</span>
                </div>
                <div className="form-grid">
                  <label>Full name<input required maxLength="200" value={customerForm.fullName} onChange={(event) => updateCustomerField('fullName', event.target.value)} /></label>
                  <label>Mobile number<input inputMode="tel" value={customerForm.mobileNumber} onChange={(event) => updateCustomerField('mobileNumber', event.target.value)} /></label>
                  <label>Email<input type="email" value={customerForm.email} onChange={(event) => updateCustomerField('email', event.target.value)} /></label>
                  {['ADMIN', 'GM'].includes(String(currentUser?.role || '').toUpperCase()) && <label>CCM ID<input required placeholder="Required team assignment" value={customerForm.ccmId} onChange={(event) => updateCustomerField('ccmId', event.target.value)} /></label>}
                </div>

                <div className="vehicle-form-list">
                  <div className="panel-header">
                    <h3>Vehicles</h3>
                    <button type="button" className="outline-btn compact-btn" onClick={() => setCustomerForm((current) => ({ ...current, vehicles: [...current.vehicles, { vin: '', registrationNumber: '', model: '', year: '' }] }))}>
                      <Plus size={16} aria-hidden="true" /> Add vehicle
                    </button>
                  </div>
                  {customerForm.vehicles.map((vehicle, index) => (
                    <div className="vehicle-form-row" key={`vehicle-${index}`}>
                      <label>VIN<input value={vehicle.vin} onChange={(event) => updateVehicleField(index, 'vin', event.target.value)} /></label>
                      <label>Registration<input value={vehicle.registrationNumber} onChange={(event) => updateVehicleField(index, 'registrationNumber', event.target.value)} /></label>
                      <label>Model<input value={vehicle.model} onChange={(event) => updateVehicleField(index, 'model', event.target.value)} /></label>
                      <label>Year<input type="number" min="1950" max={new Date().getFullYear() + 1} value={vehicle.year} onChange={(event) => updateVehicleField(index, 'year', event.target.value)} /></label>
                      <button type="button" className="icon-btn" aria-label="Remove vehicle" title="Remove vehicle" disabled={customerForm.vehicles.length === 1} onClick={() => setCustomerForm((current) => ({ ...current, vehicles: current.vehicles.filter((_, vehicleIndex) => vehicleIndex !== index) }))}>
                        <Trash2 size={17} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="form-actions">
                  <button type="button" className="outline-btn" onClick={() => setCustomerFormOpen(false)}>Cancel</button>
                  <button type="submit" className="primary-btn" disabled={customerSaving}>{customerSaving ? 'Saving…' : 'Create customer'}</button>
                </div>
              </form>
            )}

            {activeView in followUpViews ? (
              <section className="panel customer-list-panel">
                <div className="panel-header">
                  <h3>Follow-up queue · {followUpViews[activeView].label}</h3>
                  <span>{followUpsLoading ? 'Loading…' : `${followUpServiceKind ? visibleFollowUpTableRecords.length : visibleFollowUps.length} records`}</span>
                </div>
                {renderAccordionFilters(followUpSearch, setFollowUpSearch, 'Follow-up filters')}
                {followUpServiceKind ? renderServiceListTable(
                  followUpServiceKind,
                  visibleFollowUpTableRecords,
                  true,
                  followUps.length ? 'No follow-ups match the active filters.' : undefined,
                ) : <div className="table-scroll">
                  <table className="master-call-list-table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Due</th>
                        <th>Name</th>
                        <th>Number</th>
                        <th>Model name</th>
                        <th>VIN</th>
                        <th>Veh age</th>
                        <th>Regd no.</th>
                        <th>Status</th>
                        <th>Scheduled apt</th>
                        <th>Allocated CRE</th>
                        <th>Call on</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleFollowUps.map((followUp) => {
                        const record = (followUp.vehicleId && calls.find((entry) => entry.vehicleId === followUp.vehicleId))
                          || calls.find((entry) => entry.customerId === followUp.customer.id);
                        const dueValue = followUp.source === 'FREE_SERVICE' ? followUp.milestone?.dueDate : followUp.source === 'WARRANTY' ? null : record?.dueDate;
                        const typeLabel = followUp.source === 'FREE_SERVICE' ? `Free service ${followUp.milestone?.milestone ?? ''}`.trim() : followUp.source === 'WARRANTY' ? 'Warranty' : record?.type;
                        return (
                          <tr key={followUp.id}>
                            <td>{typeLabel || '—'}</td>
                            <td className={dueValue && new Date(dueValue) < new Date() ? 'due-overdue' : undefined}>{dueValue ? new Date(dueValue).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—'}</td>
                            <td><button type="button" className="text-link" onClick={() => openDueCustomer({ customerId: followUp.customer.id, vehicleId: record?.vehicleId }, 'profile')}>{followUp.customer.fullName}</button></td>
                            <td>{followUp.customer.mobileNumber || '—'}</td>
                            <td>{followUp.vehicle?.model || record?.model || '—'}</td>
                            <td>{followUp.vehicle?.vin || record?.vin || '—'}</td>
                            <td>{formatVehicleAge(record?.vehicleAgeMonths)}</td>
                            <td>{followUp.vehicle?.registrationNumber || record?.registrationNumber || '—'}</td>
                            <td><span className="badge badge-neutral">{record?.status || 'pending'}</span></td>
                            <td>{record?.scheduledAppointment ? new Date(record.scheduledAppointment.scheduledAt).toLocaleString() : '—'}</td>
                            <td>{followUp.cre?.name || record?.assigneeName || 'Unassigned'}</td>
                            <td>{new Date(followUp.followUpAt).toLocaleString()}</td>
                            <td>
                              <div className="inline-actions">
                                {currentRole === 'CRE' && (
                                  <button type="button" className="icon-btn call-icon-btn" aria-label={`Call ${followUp.customer.fullName}`} title="Call customer" onClick={() => callFromFollowUp(followUp, record?.vehicleId)}>
                                    <PhoneCall size={17} aria-hidden="true" />
                                  </button>
                                )}
                                <button type="button" className="outline-btn compact-btn" onClick={() => changeFollowUpStatus(followUp.id, 'completed')}>Complete</button>
                                <button type="button" className="outline-btn compact-btn" onClick={() => changeFollowUpStatus(followUp.id, 'cancelled')}>Cancel</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {!followUpsLoading && visibleFollowUps.length === 0 && <tr><td colSpan="13" className="empty-state">{followUps.length === 0 ? `No ${followUpViews[activeView].label.toLowerCase()} follow-ups scheduled.` : 'No follow-ups match the active filters.'}</td></tr>}
                    </tbody>
                  </table>
                </div>}
                {followUpPageInfo[followUpViews[activeView].source]?.hasMore && <div className="list-pagination"><button type="button" className="outline-btn" disabled={followUpsLoading || followUpsLoadingMore[followUpViews[activeView].source]} onClick={loadMoreFollowUps}>{followUpsLoadingMore[followUpViews[activeView].source] ? 'Loading…' : 'Load 50 More'}</button></div>}
              </section>
            ) : activeView in dueViews ? (
              <section className="panel customer-list-panel">
                <div className="panel-header">
                  <h3>{dueViews[activeView].label}</h3>
                  <span>{dueLoading ? 'Loading…' : `${visibleDueRecords.length} records`}</span>
                </div>
                {renderAccordionFilters(dueSearch, setDueSearch, 'Customer filters')}
                {dueError && <p className="form-alert error" role="alert">{dueError}</p>}
                {dueIssues.length > 0 && (
                  <details className="form-alert info data-issues">
                    <summary>{dueIssues.length} vehicle{dueIssues.length === 1 ? ' is' : 's are'} excluded because the sale date is missing or invalid</summary>
                    <ul>{dueIssues.map((issue) => <li key={issue.vehicleId}>{issue.name} · {issue.registrationNumber || issue.vin}</li>)}</ul>
                  </details>
                )}
                {dueViews[activeView].kind !== 'due' ? renderServiceListTable(
                  dueViews[activeView].kind,
                  visibleDueRecords,
                  false,
                  dueRecords.length ? 'No customers match the active filters.' : undefined,
                ) : renderMasterCallTable(visibleDueRecords, dueLoading, {
                  dueMode: currentRole !== 'CCM',
                  emptyMessage: dueRecords.length ? 'No customers match the active filters.' : 'No customers are due in this list.',
                })}
                {duePageInfo[activeView]?.hasMore && <div className="list-pagination"><button type="button" className="outline-btn" disabled={dueLoading || dueLoadingMore[activeView]} onClick={loadMoreDueData}>{dueLoadingMore[activeView] ? 'Loading…' : 'Load 50 More'}</button></div>}
              </section>
            ) : (
            <section className="panel customer-list-panel">
              <div className="panel-header">
                <h3>Customer directory</h3>
                <span>{customersLoading ? 'Loading…' : `${customers.length} records`}</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Customer</th><th>Mobile</th><th>Email</th><th>Vehicles</th></tr></thead>
                  <tbody>
                    {customers.map((customer) => (
                      <tr key={customer.id}>
                        <td><button type="button" className="text-link" onClick={() => openCustomerProfile(customer)}>{customer.name || customer.customerName || customer.fullName}</button></td>
                        <td>{customer.mobile || customer.mobileNumber || '—'}</td>
                        <td>{customer.email || '—'}</td>
                        <td>{customer.vehicleCount ?? customer.vehicles?.length ?? 0}</td>
                      </tr>
                    ))}
                    {!customersLoading && customers.length === 0 && <tr><td colSpan="4" className="empty-state">No customer records found.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            )}

            {renderCustomerActionPanel()}
          </section>
    </>
  );
}
