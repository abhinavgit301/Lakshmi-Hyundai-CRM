import { FileUp } from 'lucide-react';
import ImportErrors from '../ImportErrors.jsx';

export default function ImportsPanel(props) {
  const {
    canImport,
    changeImportHistoryCcm,
    confirmPermanentDeletion,
    currentRole,
    displayedImports,
    importCcmId,
    importError,
    importFile,
    importHistoryCcmId,
    importHistoryCcms,
    importMessage,
    importRecoverySaving,
    importRequestKeyRef,
    importResult,
    importRollbackBatch,
    importRollbackError,
    importRollbackSaving,
    importUploading,
    importsLoading,
    masterListCcms,
    openPermanentDeletionPreview,
    permanentDeletion,
    permanentDeletionError,
    permanentDeletionPreviewLoading,
    permanentDeletionSaving,
    recoverImport,
    rollbackImport,
    setImportCcmId,
    setImportFile,
    setImportMessage,
    setImportRollbackBatch,
    setImportRollbackError,
    setPermanentDeletion,
    setPermanentDeletionError,
    submitImport,
  } = props;
  return (
    <>
          <section className="customer-workspace">
            {importError && <p className="form-alert error" role="alert">{importError}</p>}
            {importMessage && <p className="form-alert success" role="status">{importMessage}</p>}
            {importResult && (
              <section className="panel import-result" role="status">
                <div className="panel-header"><h3>Import completed</h3><span>{importResult.batch.fileName}</span></div>
                <div className="import-counts">
                  {[['Rows', importResult.batch.totalRows], ['Created', importResult.batch.createdRows], ['Appended', importResult.batch.appendedRows], ['Skipped', importResult.batch.skippedRows], ['Rejected', importResult.batch.rejectedRows], ['Flagged', importResult.batch.flaggedRows]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
                </div>
              </section>
            )}
            {canImport ? (
              <form className="panel import-form" onSubmit={submitImport} aria-busy={importUploading}>
                <div className="panel-header"><h3>Upload repair orders</h3><span>CSV file, up to 1.8 MB</span></div>
                <p className="import-columns">Each row must include Repair Order No, Vehicle VIN, and Registration No. Other fields are optional; missing values are shown as “-”.</p>
                {currentRole !== 'CCM' && (
                  <label className="import-team-select">Import customer records under CCM
                    <select required disabled={importUploading} value={importCcmId} onChange={(event) => {
                      importRequestKeyRef.current = null;
                      setImportMessage('');
                      setImportCcmId(event.target.value);
                    }}>
                      <option value="">Select CCM team</option>
                      {masterListCcms.map((ccm) => <option key={ccm.ccmId} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}
                    </select>
                  </label>
                )}
                <div className="upload-row">
                  <label className="file-picker"><FileUp size={18} aria-hidden="true" /><span>{importFile?.name || 'Choose CSV file'}</span><input type="file" accept=".csv,text/csv" disabled={importUploading} onChange={(event) => {
                    importRequestKeyRef.current = null;
                    setImportMessage('');
                    setImportFile(event.target.files?.[0] || null);
                  }} /></label>
                  <button type="submit" className="primary-btn" disabled={!importFile || importUploading}>{importUploading ? 'Importing…' : 'Import file'}</button>
                </div>
                {importUploading && (
                  <div className="import-progress" role="status" aria-live="polite">
                    <span>Importing and saving records. Please keep this page open.</span>
                    <div className="import-progress-track" role="progressbar" aria-label="Import in progress">
                      <span />
                    </div>
                  </div>
                )}
              </form>
            ) : <p className="form-alert error">Import access is limited to Admin, GM, and CCM accounts.</p>}
            <section className="panel customer-list-panel">
              <div className="panel-header import-history-header">
                <h3>Import history</h3>
                {currentRole === 'ADMIN' && (
                  <label className="import-history-filter">
                    <span>CCM</span>
                    <select aria-label="Filter import history by CCM" value={importHistoryCcmId} disabled={importsLoading} onChange={(event) => changeImportHistoryCcm(event.target.value)}>
                      <option value="">All CCMs</option>
                      {importHistoryCcms.map((ccm) => (
                        <option key={ccm.ccmId} value={ccm.ccmId}>
                          {ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <span aria-live="polite">{importsLoading ? 'Loading…' : `${displayedImports.length} batches`}</span>
              </div>
              <div className="table-scroll">
                <table className="import-history-table">
                  <thead><tr><th>Import ID</th><th>File</th><th>Imported by</th><th>CCM</th><th>Imported</th><th>Status</th><th>Row progress</th><th>Changed records</th><th>Created</th><th>Appended</th><th>Skipped</th><th>Rejected</th><th>Flagged</th>{currentRole === 'ADMIN' && <th>Rollback / recovery</th>}</tr></thead>
                  <tbody>
                    {displayedImports.map((batch) => {
                      const changedRecords = (batch.affectedCustomers || 0)
                        + (batch.affectedVehicles || 0)
                        + (batch.affectedRepairOrders || 0)
                        + (batch.affectedCallListEntries || 0)
                        + (batch.affectedAllocations || 0)
                        + (batch.affectedMonthlyEntries || 0);
                      const legacyStoredOutcomes = batch.rowOutcomesProvenance === 'legacy-stored-unverified';
                      const rowOutcomesAvailable = batch.statsComplete || legacyStoredOutcomes;
                      const rowOutcomeSuffix = legacyStoredOutcomes ? '†' : '';
                      const ccm = importHistoryCcms.find((item) => item.ccmId === batch.ccmId);
                      return (
                        <tr key={batch.id}>
                          <td><code className="import-batch-id" title={batch.id}>{batch.id}</code></td>
                          <td>{batch.fileName}{batch.importType === 'monthly_customer_data' && <small className="import-history-subtext">Monthly customer data</small>}{batch.rowErrors?.length > 0 && <details className="row-error-details"><summary>{batch.rowErrors.length} row issues</summary><ImportErrors errors={batch.rowErrors.map((row) => ({ ...row, status: row.errorCode.toLowerCase().includes('conflict') ? 'flagged' : row.errorCode.toLowerCase().includes('duplicate') ? 'skipped' : 'rejected' }))} /></details>}</td>
                          <td title={batch.importedBy?.id || batch.importedByUserId || undefined}>
                            {batch.importedBy?.name || (batch.importedByUserId ? 'Deleted account' : 'Unknown')}
                            {batch.importedBy?.role && <small className="import-history-subtext">{batch.importedBy.role}</small>}
                          </td>
                          <td title={batch.ccmId || undefined}>{ccm?.name || batch.ccmId || '—'}</td>
                          <td>{new Date(batch.createdAt).toLocaleString()}</td>
                          <td title={batch.recoveryBlockedReason || undefined}>
                            {batch.status === 'rolled_back' ? 'Rolled back' : batch.status === 'permanently_deleted' ? 'Permanently deleted' : batch.status === 'completed' ? 'Completed' : batch.status}
                            {batch.permanentDeletion && (
                              <details className="import-invalidation-note">
                                <summary>
                                  {batch.permanentDeletion.invalidatedChanges} changes invalidated
                                  {batch.permanentDeletion.invalidatedRows.length > 0
                                    ? ` · ${batch.permanentDeletion.invalidatedRows.length} rows`
                                    : ''}
                                </summary>
                                <span>Rows: {batch.permanentDeletion.invalidatedRows.join(', ') || '—'}</span>
                                <span>Caused by import: {batch.permanentDeletion.causedByImportIds.join(', ') || 'Unknown'}</span>
                              </details>
                            )}
                          </td>
                          <td>{batch.processedRows == null ? `Unknown / ${batch.totalRows} (unverified)` : `${batch.processedRows} / ${batch.totalRows}${batch.statsComplete ? '' : legacyStoredOutcomes ? ' (legacy status; row details unverified)' : ' (partial)'}`}</td>
                          <td title={batch.affectedCountsComplete ? 'Distinct affected records verified from durable change logs.' : batch.processingStartedAt ? 'Distinct records currently represented in durable change logs; completeness is not verified.' : 'No verified change-log count is available for this historical import.'}>
                            {batch.processingStartedAt ? `${changedRecords}${batch.affectedCountsComplete ? '' : ' logged (partial)'}` : 'Unavailable'}
                          </td>
                          <td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.createdRows}${rowOutcomeSuffix}` : '—'}</td><td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.appendedRows}${rowOutcomeSuffix}` : '—'}</td><td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.skippedRows}${rowOutcomeSuffix}` : '—'}</td><td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.rejectedRows}${rowOutcomeSuffix}` : '—'}</td><td title={legacyStoredOutcomes ? 'Stored historical count; row-level completeness is unverified.' : undefined}>{rowOutcomesAvailable ? `${batch.flaggedRows}${rowOutcomeSuffix}` : '—'}</td>
                          {currentRole === 'ADMIN' && <td>
                            {['completed', 'failed'].includes(batch.status) && batch.rollbackSupported ? (
                              <>
                                <button type="button" className="outline-btn import-rollback-trigger" disabled={importRollbackSaving} onClick={() => {
                                  setImportRollbackBatch(batch);
                                  setImportRollbackError('');
                                }}>Roll back</button>
                                <button type="button" className="danger-btn import-rollback-trigger" disabled={permanentDeletionPreviewLoading || permanentDeletionSaving} onClick={() => openPermanentDeletionPreview(batch)}>
                                  Permanently delete
                                </button>
                              </>
                            ) : batch.status === 'rolled_back' ? (
                              <span className="import-rollback-unavailable">Already rolled back</span>
                            ) : batch.status === 'permanently_deleted' ? (
                              <span className="import-rollback-unavailable">Already permanently deleted</span>
                            ) : ['processing', 'failed'].includes(batch.status) && !batch.rollbackSupported ? (
                              <button type="button" className="outline-btn import-rollback-trigger" disabled={importRecoverySaving} onClick={() => recoverImport(batch)}>
                                {importRecoverySaving ? 'Checking…' : 'Recover'}
                              </button>
                            ) : batch.status === 'recovery_blocked' ? (
                              <span className="import-rollback-unavailable" title={batch.recoveryBlockedReason}>Blocked</span>
                            ) : (
                              <span className="import-rollback-unavailable" title="This batch has no verified snapshots or is not in a completed state.">Unavailable</span>
                            )}
                          </td>}
                        </tr>
                      );
                    })}
                    {!importsLoading && displayedImports.length === 0 && <tr><td colSpan={currentRole === 'ADMIN' ? 14 : 13} className="empty-state">{importHistoryCcmId ? 'No imports recorded for this CCM.' : 'No imports recorded.'}</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            {permanentDeletionPreviewLoading && <p className="form-alert" role="status">Preparing permanent-deletion preview…</p>}
            {importRollbackBatch && (
              <div className="modal-backdrop" onMouseDown={(event) => {
                if (event.target === event.currentTarget && !importRollbackSaving) setImportRollbackBatch(null);
              }}>
                <section className="modal-card import-rollback-modal" role="dialog" aria-modal="true" aria-labelledby="import-rollback-title" aria-describedby="import-rollback-description">
                  <h3 id="import-rollback-title">Roll back repair-order import?</h3>
                  <p id="import-rollback-description">This will reverse only the recorded changes from this import. Any records that have changed since the import or have later dependencies will be preserved and block the rollback.</p>
                  <dl className="import-rollback-details">
                    <div><dt>File</dt><dd>{importRollbackBatch.fileName}</dd></div>
                    <div><dt>Batch ID</dt><dd>{importRollbackBatch.id}</dd></div>
                    <div><dt>Imported</dt><dd>{new Date(importRollbackBatch.createdAt).toLocaleString()}</dd></div>
                    <div><dt>Status</dt><dd>{importRollbackBatch.status}</dd></div>
                    <div><dt>Recorded changes</dt><dd>{importRollbackBatch._count?.changes ?? 'Unknown'}</dd></div>
                    <div><dt>Affected records</dt><dd>{importRollbackBatch.affectedCountsComplete ? <>
                      Customers {importRollbackBatch.affectedCustomers ?? 0}, Vehicles {importRollbackBatch.affectedVehicles ?? 0},
                      Repair orders {importRollbackBatch.affectedRepairOrders ?? 0}, Call list {importRollbackBatch.affectedCallListEntries ?? 0},
                      Allocations {importRollbackBatch.affectedAllocations ?? 0}
                    </> : 'Incomplete; recovery verification is required before rollback.'}</dd></div>
                  </dl>
                  <p className="modal-warning">This action cannot be undone. A rollback conflict will leave the import and its data unchanged.</p>
                  {importRollbackError && <p className="form-alert error" role="alert">{importRollbackError}</p>}
                  <div className="form-actions">
                    <button type="button" className="outline-btn" disabled={importRollbackSaving} onClick={() => setImportRollbackBatch(null)}>Cancel</button>
                    <button type="button" className="danger-btn" disabled={importRollbackSaving} onClick={() => rollbackImport(importRollbackBatch)}>{importRollbackSaving ? 'Rolling back…' : 'Confirm rollback'}</button>
                  </div>
                </section>
              </div>
            )}
            {permanentDeletionError && !permanentDeletion && <p className="form-alert error" role="alert">{permanentDeletionError}</p>}
            {permanentDeletion && (
              <div className="modal-backdrop" onMouseDown={(event) => {
                if (event.target === event.currentTarget && !permanentDeletionSaving) {
                  setPermanentDeletion(null);
                  setPermanentDeletionError('');
                }
              }}>
                <section className="modal-card import-rollback-modal" role="dialog" aria-modal="true" aria-labelledby="permanent-deletion-title" aria-describedby="permanent-deletion-description">
                  <h3 id="permanent-deletion-title">Permanently delete import and dependencies?</h3>
                  <p id="permanent-deletion-description">This separate action permanently removes records created by this import and dependent records from later imports. Later repair orders, calls, appointments, and call-list records may also be deleted. Pre-existing records updated by this import will be restored where their recorded state can be verified.</p>
                  {permanentDeletionPreviewLoading ? <p role="status">Preparing deletion preview…</p> : (
                    <dl className="import-rollback-details">
                      <div><dt>Original file</dt><dd>{permanentDeletion.preview.fileName}</dd></div>
                      <div><dt>Import ID</dt><dd>{permanentDeletion.preview.importId}</dd></div>
                      <div><dt>Imported</dt><dd>{new Date(permanentDeletion.preview.importedAt).toLocaleString()}</dd></div>
                      <div><dt>Directly affected records</dt><dd>{permanentDeletion.preview.directlyAffectedRecords}</dd></div>
                      <div><dt>Dependent records</dt><dd>{permanentDeletion.preview.dependentRecords}</dd></div>
                      <div><dt>Later import batches affected</dt><dd>{permanentDeletion.preview.laterImportBatchesAffected}</dd></div>
                      <div><dt>Total records to delete</dt><dd>{permanentDeletion.preview.totalRecordsDeleted}</dd></div>
                      <div><dt>Existing records to restore</dt><dd>{permanentDeletion.preview.existingRecordsRestored}</dd></div>
                      <div><dt>Existing records to rebase</dt><dd>{permanentDeletion.preview.existingRecordsRebased}</dd></div>
                      <div><dt>Other affected records preserved</dt><dd>{permanentDeletion.preview.recordsPreserved}</dd></div>
                      <div>
                        <dt>PhysicalVehicle identities retained</dt>
                        <dd>
                          {permanentDeletion.preview.physicalVehicleIdentitiesRetained?.length
                            ? permanentDeletion.preview.physicalVehicleIdentitiesRetained.map(({ id, vin }) => vin || id).join(', ')
                            : 'None'}
                        </dd>
                      </div>
                      <div><dt>Customers / vehicles</dt><dd>{permanentDeletion.preview.counts.customers} / {permanentDeletion.preview.counts.vehicles}</dd></div>
                      <div><dt>Repair orders / call-list records</dt><dd>{permanentDeletion.preview.counts.repairOrders} / {permanentDeletion.preview.counts.callListRecords}</dd></div>
                      <div><dt>Calls / appointments / follow-ups</dt><dd>{permanentDeletion.preview.counts.calls} / {permanentDeletion.preview.counts.appointments} / {permanentDeletion.preview.counts.followUps}</dd></div>
                      <div><dt>Allocations / ownership / milestones</dt><dd>{permanentDeletion.preview.counts.allocations} / {permanentDeletion.preview.counts.ownershipRecords} / {permanentDeletion.preview.counts.freeServiceMilestones}</dd></div>
                      <div><dt>Appointment events / VIN reviews</dt><dd>{permanentDeletion.preview.counts.appointmentEvents} / {permanentDeletion.preview.counts.vinConflictReviews}</dd></div>
                      <div><dt>Monthly data entries retained and detached</dt><dd>{permanentDeletion.preview.counts.monthlyEntriesDetached}</dd></div>
                    </dl>
                  )}
                  {permanentDeletion.preview.affectedImportBatches.length > 0 && (
                    <div className="permanent-deletion-batches">
                      <strong>Later batches affected</strong>
                      <ul>{permanentDeletion.preview.affectedImportBatches.map((affected) => <li key={affected.id}>{affected.fileName} — {affected.invalidatedChanges} changes, {affected.invalidatedRows.length} rows invalidated</li>)}</ul>
                    </div>
                  )}
                  {permanentDeletion.preview.recordsAlreadyAbsent?.length > 0 && (
                    <div className="permanent-deletion-batches">
                      <strong>Already absent (will be skipped)</strong>
                      <ul>{permanentDeletion.preview.recordsAlreadyAbsent.map((record) => (
                        <li key={`${record.entityType}:${record.entityId}:${record.operation}`}>
                          {record.entityType} · {record.entityId} ({record.operation})
                        </li>
                      ))}</ul>
                    </div>
                  )}
                  {permanentDeletion.preview.blockers?.length > 0 && (
                    <div className="form-alert error" role="alert">
                      <strong>Deletion is blocked.</strong>
                      <ul>{permanentDeletion.preview.blockers.map((blocker, index) => (
                        <li key={`${blocker.code}:${blocker.entityId || index}`}>{blocker.message}</li>
                      ))}</ul>
                    </div>
                  )}
                  {permanentDeletion.preview.totalRecordsDeleted === 0
                    && permanentDeletion.preview.existingRecordsRestored === 0
                    && permanentDeletion.preview.existingRecordsRebased === 0
                    && !permanentDeletion.preview.deletionBlocked && (
                      <p className="form-alert" role="status">No business-data changes were recorded for this import. Confirming will mark the import as permanently deleted without changing business records.</p>
                    )}
                  <p className="modal-warning">This action cannot be undone. Import history and audit records will be retained, but deleted records cannot be recovered.</p>
                  {permanentDeletionError && <p className="form-alert error" role="alert">{permanentDeletionError}</p>}
                  <div className="form-actions">
                    <button type="button" className="outline-btn" disabled={permanentDeletionSaving} onClick={() => {
                      setPermanentDeletion(null);
                      setPermanentDeletionError('');
                    }}>Cancel</button>
                    <button type="button" className="danger-btn" disabled={permanentDeletionSaving || permanentDeletionPreviewLoading || permanentDeletion.preview.alreadyDeleted || permanentDeletion.preview.deletionBlocked || !permanentDeletion.preview.confirmationToken} onClick={confirmPermanentDeletion}>
                      {permanentDeletionSaving ? 'Deleting permanently…' : 'Confirm permanent deletion'}
                    </button>
                  </div>
                </section>
              </div>
            )}
          </section>
    </>
  );
}
