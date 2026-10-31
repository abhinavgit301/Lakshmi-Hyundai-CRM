export default function AllocationsPanel(props) {
  const {
    allocationCres,
    allocationError,
    allocationForm,
    allocationFormOpen,
    allocationMessage,
    pendingRedistribution,
    allocationSaving,
    allocationSearch,
    allocationTeamId,
    allocationVehicles,
    allocationsLoading,
    callError,
    currentRole,
    currentUser,
    customerPanel,
    customers,
    masterListCcms,
    masterListError,
    masterListTeam,
    renderCustomerActionPanel,
    renderMasterCallTable,
    setAllocationForm,
    setAllocationFormOpen,
    setAllocationSearch,
    setMasterListTeam,
    submitAllocation,
    allocatePendingCustomers,
    visibleAllocationRecords,
  } = props;
  return (
    <>
          <section className="customer-workspace">
            {allocationError && <p className="form-alert error" role="alert">{allocationError}</p>}
            {allocationMessage && <p className="form-alert success" role="status">{allocationMessage}</p>}
            {currentRole === 'CCM' && pendingRedistribution?.pendingCustomers > 0 && (
              <div className="panel" role="status">
                <div className="panel-header">
                  <div>
                    <h3>Customers awaiting allocation</h3>
                    <span>{pendingRedistribution.pendingCustomers} customer{pendingRedistribution.pendingCustomers === 1 ? '' : 's'} are pending after CRE removal or transfer.</span>
                  </div>
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={allocatePendingCustomers}
                    disabled={allocationSaving || !pendingRedistribution.activeCreCount}
                  >
                    {allocationSaving ? 'Allocating…' : `Allocate Customers (${pendingRedistribution.pendingCustomers})`}
                  </button>
                </div>
                {!pendingRedistribution.activeCreCount && <p>No active CREs are available. Add a CRE, then allocate this pending customer pool.</p>}
              </div>
            )}
            {allocationFormOpen && ['ADMIN', 'GM'].includes(currentRole) && (
              <form className="panel customer-form" onSubmit={submitAllocation}>
                <div className="panel-header"><h3>Assign vehicle to CRE</h3><span>Assignments are limited to the vehicle&apos;s CCM team</span></div>
                <div className="form-grid">
                  <label>Vehicle
                    <select required value={allocationForm.vehicleId} onChange={(event) => setAllocationForm({ ...allocationForm, vehicleId: event.target.value })}>
                      <option value="">Choose vehicle</option>
                      {allocationVehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{[vehicle.customerName, vehicle.model, vehicle.registrationNumber || vehicle.vin].filter(Boolean).join(' · ')}</option>)}
                    </select>
                  </label>
                  <label>CRE
                    <select required value={allocationForm.creId} onChange={(event) => setAllocationForm({ ...allocationForm, creId: event.target.value })}>
                      <option value="">Choose CRE</option>
                      {allocationCres.filter((cre) => allocationTeamId ? cre.ccmId === allocationTeamId : currentUser.role !== 'CCM' || cre.ccmId === currentUser.ccmId).map((cre) => <option key={cre.id} value={cre.id}>{cre.name}</option>)}
                    </select>
                  </label>
                  <label>Service type<input required maxLength="100" value={allocationForm.serviceType} onChange={(event) => setAllocationForm({ ...allocationForm, serviceType: event.target.value })} placeholder="Periodic service" /></label>
                  <label>Category<input maxLength="100" value={allocationForm.category} onChange={(event) => setAllocationForm({ ...allocationForm, category: event.target.value })} placeholder="Due service" /></label>
                </div>
                <div className="form-actions"><button type="button" className="outline-btn" onClick={() => setAllocationFormOpen(false)}>Cancel</button><button type="submit" className="primary-btn" disabled={allocationSaving || !customers.some((customer) => customer.vehicles?.length) || allocationCres.length === 0}>{allocationSaving ? 'Assigning…' : 'Assign vehicle'}</button></div>
              </form>
            )}
            {masterListError && <p className="form-alert error" role="alert">{masterListError}</p>}
            <section className="panel customer-list-panel">
              <div className="panel-header">
                <h3>{currentRole === 'CCM' ? 'Allocated customers' : 'Allocation queue'}</h3>
                {['ADMIN', 'GM'].includes(currentRole) && (
                  <label className="inline-filter">Team
                    <select value={masterListTeam} onChange={(event) => setMasterListTeam(event.target.value)}>
                      <option value="">All teams</option>
                      {masterListCcms.map((ccm) => <option key={ccm.ccmId} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}
                    </select>
                  </label>
                )}
                <label className="inline-filter">Search
                  <input type="search" value={allocationSearch} placeholder="Name, number, VIN, model or reg. no." onChange={(event) => setAllocationSearch(event.target.value)} />
                </label>
                <span>{allocationsLoading ? 'Loading…' : `${visibleAllocationRecords.length} records`}</span>
              </div>
              {renderMasterCallTable(visibleAllocationRecords, allocationsLoading, { assignable: currentRole === 'CCM' })}
            </section>
            {callError && <p className="form-alert error" role="alert">{callError}</p>}
            {customerPanel.mode === 'call' && renderCustomerActionPanel()}
          </section>
    </>
  );
}
