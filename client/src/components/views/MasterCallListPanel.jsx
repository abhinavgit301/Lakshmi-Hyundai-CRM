import { Save, X } from 'lucide-react';
import { manualEntryExcludedFields, masterCsvFields } from '../../utils/crmHelpers.js';
import { MASTER_REPAIR_TYPE_ORDER } from '../../utils/repairTypes.js';

export default function MasterCallListPanel(props) {
  const {
    callError,
    callMessage,
    currentRole,
    customerPanel,
    loadMoreMasterList,
    masterEntryForm,
    masterEntryFormOpen,
    masterEntrySaving,
    masterListCcms,
    masterListCreFilter,
    masterListCres,
    masterListDueFilter,
    masterListError,
    masterListLoading,
    masterListLoadingMore,
    masterListMessage,
    masterListPageInfo,
    masterListRepairFilter,
    masterListSearch,
    masterListTeam,
    masterRecords,
    renderCustomerActionPanel,
    renderMasterCallTable,
    setMasterEntryForm,
    setMasterEntryFormOpen,
    setMasterListCreFilter,
    setMasterListDueFilter,
    setMasterListRepairFilter,
    setMasterListSearch,
    setMasterListTeam,
    submitMasterEntry,
  } = props;
  return (
    <>
          <section className="customer-workspace">
            {masterListError && <p className="form-alert error" role="alert">{masterListError}</p>}
            {masterListMessage && <p className="form-alert success" role="status">{masterListMessage}</p>}
            {masterEntryFormOpen && (
              <form className="panel customer-form" onSubmit={submitMasterEntry}>
                <div className="panel-header">
                  <h3>Add customer to master list</h3>
                  <span>Fields match the service repair-order CSV</span>
                </div>
                <div className="form-grid">
                  {masterCsvFields.filter(([key]) => !manualEntryExcludedFields.includes(key)).map(([key, label, type]) => (
                    <label key={key}>
                      {label}{['roNumber', 'vin', 'customerName', 'mobileNumber'].includes(key) ? ' *' : ''}
                      <input
                        required={['roNumber', 'vin', 'customerName', 'mobileNumber'].includes(key)}
                        maxLength={key === 'vin' ? 17 : undefined}
                        type={type}
                        min={type === 'number' ? '0' : undefined}
                        value={masterEntryForm[key]}
                        onChange={(event) => setMasterEntryForm({
                          ...masterEntryForm,
                          [key]: key === 'vin' || key === 'registrationNumber' ? event.target.value.toUpperCase() : event.target.value,
                        })}
                      />
                    </label>
                  ))}
                  {currentRole !== 'CCM' && (
                    <label>CCM ID<select required value={masterEntryForm.ccmId} onChange={(event) => setMasterEntryForm({ ...masterEntryForm, ccmId: event.target.value })}>
                      <option value="">Select CCM</option>
                      {masterListCcms.map((ccm) => <option key={ccm.ccmId} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}
                    </select></label>
                  )}
                </div>
                <div className="form-actions">
                  <button type="button" className="outline-btn" onClick={() => setMasterEntryFormOpen(false)}>Cancel</button>
                  <button type="submit" className="primary-btn" disabled={masterEntrySaving || masterListLoading || (currentRole !== 'CCM' && masterListCcms.length === 0)}>
                    <Save size={16} aria-hidden="true" />{masterEntrySaving ? 'Saving…' : 'Add customer'}
                  </button>
                </div>
              </form>
            )}
            <section className="panel customer-list-panel master-list-panel">
              <div className="panel-header">
                <h3>Master call list</h3>
                {['ADMIN', 'GM'].includes(currentRole) && (
                  <label className="inline-filter">Team
                    <select value={masterListTeam} onChange={(event) => setMasterListTeam(event.target.value)}>
                      <option value="">All teams</option>
                      {masterListCcms.map((ccm) => <option key={ccm.ccmId} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}
                    </select>
                  </label>
                )}
                <span>{masterListLoading ? 'Loading…' : `${masterRecords.length} records`}</span>
              </div>
              {['CCM', 'CRE'].includes(currentRole) && (
                <div className="master-list-filters" aria-label="Master Call List filters">
                  <label className="master-list-search">
                    Search customers
                    <span className="master-list-search-control">
                      <input
                        type="search"
                        value={masterListSearch}
                        placeholder="Name, mobile, VIN, registration or RO"
                        aria-label="Search by customer name, mobile, VIN, registration number, or repair order"
                        onChange={(event) => setMasterListSearch(event.target.value)}
                      />
                      {masterListSearch && (
                        <button type="button" className="master-list-clear-search" aria-label="Clear search" onClick={() => setMasterListSearch('')}>
                          <X size={15} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  </label>
                  {currentRole === 'CCM' && (
                    <label>
                      CRE
                      <select value={masterListCreFilter} onChange={(event) => setMasterListCreFilter(event.target.value)}>
                        <option value="">All CREs</option>
                        <option value="unassigned">Unassigned customers</option>
                        {masterListCres.map((cre) => <option key={cre.id} value={cre.id}>{cre.name || cre.username}</option>)}
                      </select>
                    </label>
                  )}
                  <label>
                    Due category
                    <select value={masterListDueFilter} onChange={(event) => setMasterListDueFilter(event.target.value)}>
                      <option value="">All customers</option>
                      <option value="6m">6 Months Due</option>
                      <option value="1y">1 Year Due</option>
                      <option value="allDue">All Due Customers</option>
                    </select>
                  </label>
                  <label>
                    Repair type
                    <select value={masterListRepairFilter} onChange={(event) => setMasterListRepairFilter(event.target.value)}>
                      <option value="">All repair types</option>
                      {MASTER_REPAIR_TYPE_ORDER.map((type) => (
                        <option key={type} value={type}>
                          {type === 'Free' ? 'Free Service' : type === 'Paid' ? 'Paid Service' : type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="outline-btn master-list-clear-filters"
                    disabled={!masterListSearch && !masterListCreFilter && !masterListDueFilter && !masterListRepairFilter}
                    onClick={() => {
                      setMasterListSearch('');
                      setMasterListCreFilter('');
                      setMasterListDueFilter('');
                      setMasterListRepairFilter('');
                    }}
                  >Clear filters</button>
                </div>
              )}
              {renderMasterCallTable(masterRecords, masterListLoading, {
                emptyMessage: 'No matching customers found. Try adjusting or clearing the active filters.',
              })}
              {masterListPageInfo.hasMore && <div className="list-pagination"><button type="button" className="outline-btn" disabled={masterListLoading || masterListLoadingMore} onClick={loadMoreMasterList}>{masterListLoadingMore ? 'Loading…' : 'Load 50 More'}</button></div>}
            </section>
            {callError && customerPanel.mode !== 'call' && <p className="form-alert error" role="alert">{callError}</p>}
            {callMessage && customerPanel.mode !== 'call' && <p className="form-alert success" role="status">{callMessage}</p>}
            {customerPanel.mode === 'call' && renderCustomerActionPanel()}
          </section>
    </>
  );
}
