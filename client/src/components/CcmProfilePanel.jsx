import { FileUp, Save } from 'lucide-react';
import ImportErrors from './ImportErrors.jsx';
import { monthOptions } from '../utils/months.js';

export default function CcmProfilePanel(props) {
  const {
    ccmProfile,
    changeMonthlyPeriod,
    commitMonthlyImport,
    monthlyBusy,
    monthlyEntries,
    monthlyError,
    monthlyFile,
    monthlyForm,
    monthlyImports,
    monthlyLoading,
    monthlyMessage,
    monthlyMonth,
    monthlyPreview,
    monthlyYear,
    previewMonthlyImport,
    setMonthlyFile,
    setMonthlyForm,
    setMonthlyPreview,
    submitMonthlyEntry,
  } = props;
  return (
          <section className="customer-workspace">
            {monthlyError && <p className="form-alert error" role="alert">{monthlyError}</p>}
            {monthlyMessage && <p className="form-alert success" role="status">{monthlyMessage}</p>}
            {ccmProfile && <section className="stats-grid profile-stats">
              {[['CCM', ccmProfile.ccm.name], ['Customers', ccmProfile.customerCount], ['Vehicles', ccmProfile.vehicleCount], ['Saved months', ccmProfile.monthlyDatasets.length]].map(([label, value]) => <article key={label} className="stat-card"><p>{label}</p><strong>{value}</strong></article>)}
            </section>}
            <section className="panel customer-list-panel">
              <div className="panel-header"><h3>Monthly Customer Data</h3><span>{monthlyLoading ? 'Loading…' : `${monthlyEntries.length} records`}</span></div>
              <div className="period-controls">
                <label>Month<select value={monthlyMonth} onChange={(event) => changeMonthlyPeriod(monthlyYear, Number(event.target.value))}>{monthOptions.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label>
                <label>Year<select value={monthlyYear} onChange={(event) => changeMonthlyPeriod(Number(event.target.value), monthlyMonth)}>{Array.from({ length: 7 }, (_, index) => new Date().getFullYear() - 5 + index).map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
              </div>
              <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Mobile</th><th>VIN</th><th>Vehicle</th><th>Service</th><th>Last visit</th><th>Next due</th><th>Source</th></tr></thead><tbody>
                {monthlyEntries.map((entry) => <tr key={entry.id}><td>{entry.customerName}</td><td>{entry.mobileNumber}</td><td>{entry.vin || '—'}</td><td>{[entry.model, entry.registrationNumber].filter(Boolean).join(' / ') || '—'}</td><td>{entry.serviceType || '—'}</td><td>{entry.lastVisitDate ? new Date(entry.lastVisitDate).toLocaleDateString() : '—'}</td><td>{entry.nextServiceDueDate ? new Date(entry.nextServiceDueDate).toLocaleDateString() : '—'}</td><td>{entry.source}</td></tr>)}
                {!monthlyLoading && monthlyEntries.length === 0 && <tr><td colSpan="8" className="empty-state">No customer data for this month yet.</td></tr>}
              </tbody></table></div>
            </section>
            <form className="panel customer-form" onSubmit={submitMonthlyEntry}>
              <div className="panel-header"><h3>Manual entry</h3><span>Added to {monthOptions[monthlyMonth - 1]} {monthlyYear}</span></div>
              <div className="form-grid">
                <label>Customer name<input required maxLength="200" value={monthlyForm.customerName} onChange={(event) => setMonthlyForm({ ...monthlyForm, customerName: event.target.value })} /></label>
                <label>Mobile number<input required inputMode="tel" value={monthlyForm.mobileNumber} onChange={(event) => setMonthlyForm({ ...monthlyForm, mobileNumber: event.target.value })} /></label>
                <label>Email<input type="email" value={monthlyForm.email} onChange={(event) => setMonthlyForm({ ...monthlyForm, email: event.target.value })} /></label>
                <label>VIN<input value={monthlyForm.vin} onChange={(event) => setMonthlyForm({ ...monthlyForm, vin: event.target.value })} /></label>
                <label>Registration<input value={monthlyForm.registrationNumber} onChange={(event) => setMonthlyForm({ ...monthlyForm, registrationNumber: event.target.value })} /></label>
                <label>Model<input value={monthlyForm.model} onChange={(event) => setMonthlyForm({ ...monthlyForm, model: event.target.value })} /></label>
                <label>Vehicle year<input type="number" min="1950" max={new Date().getFullYear() + 1} value={monthlyForm.vehicleYear} onChange={(event) => setMonthlyForm({ ...monthlyForm, vehicleYear: event.target.value })} /></label>
                <label>Service type<input value={monthlyForm.serviceType} onChange={(event) => setMonthlyForm({ ...monthlyForm, serviceType: event.target.value })} /></label>
                <label>Last visit<input type="date" value={monthlyForm.lastVisitDate} onChange={(event) => setMonthlyForm({ ...monthlyForm, lastVisitDate: event.target.value })} /></label>
                <label>Next service due<input type="date" value={monthlyForm.nextServiceDueDate} onChange={(event) => setMonthlyForm({ ...monthlyForm, nextServiceDueDate: event.target.value })} /></label>
                <label className="full-width-field">Notes<textarea rows="2" maxLength="2000" value={monthlyForm.notes} onChange={(event) => setMonthlyForm({ ...monthlyForm, notes: event.target.value })} /></label>
              </div>
              <div className="form-actions"><button type="submit" className="primary-btn" disabled={monthlyBusy}><Save size={16} aria-hidden="true" />{monthlyBusy ? 'Saving…' : 'Add to month'}</button></div>
            </form>
            <form className="panel import-form" onSubmit={previewMonthlyImport}>
              <div className="panel-header"><h3>CSV / Excel import</h3><span>CSV or XLSX, up to 7 MB</span></div>
              <p className="import-columns">Required columns: Customer Name and Mobile. Optional: Email, VIN, Registration, Make, Model, Year, Service Type, Last Visit Date, Next Service Due Date, Notes.</p>
              <div className="upload-row"><label className="file-picker"><FileUp size={18} aria-hidden="true" /><span>{monthlyFile?.name || 'Choose CSV or XLSX file'}</span><input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setMonthlyFile(event.target.files?.[0] || null); setMonthlyPreview(null); }} /></label><button type="submit" className="outline-btn" disabled={!monthlyFile || monthlyBusy}>{monthlyBusy ? 'Validating…' : 'Preview import'}</button></div>
              {monthlyPreview && <div className="monthly-preview">
                <div className="import-counts"><div><span>Total</span><strong>{monthlyPreview.totalRows}</strong></div><div><span>Ready</span><strong>{monthlyPreview.addedRows}</strong></div><div><span>Duplicates</span><strong>{monthlyPreview.skippedRows}</strong></div><div><span>Invalid</span><strong>{monthlyPreview.rejectedRows}</strong></div></div>
                <div className="table-scroll"><table><thead><tr><th>Row</th><th>Customer</th><th>Mobile</th><th>VIN</th><th>Result</th><th>Validation</th></tr></thead><tbody>{monthlyPreview.rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.row.customerName || '—'}</td><td>{row.row.mobileNumber || '—'}</td><td>{row.row.vin || '—'}</td><td>{row.status}</td><td>{row.error || 'Ready to import'}</td></tr>)}</tbody></table></div>
                <div className="form-actions"><button type="button" className="primary-btn" disabled={monthlyBusy || monthlyPreview.addedRows === 0} onClick={commitMonthlyImport}>{monthlyBusy ? 'Importing…' : `Import ${monthlyPreview.addedRows} rows`}</button></div>
              </div>}
            </form>
            <section className="panel customer-list-panel">
              <div className="panel-header"><h3>Import history</h3><span>{monthlyImports.length} files this month</span></div>
              <div className="table-scroll"><table><thead><tr><th>File</th><th>Imported by</th><th>Date</th><th>Total</th><th>Added</th><th>Skipped</th><th>Rejected</th><th>State</th></tr></thead><tbody>
                {monthlyImports.map((item) => <tr key={item.id}><td>{item.fileName}{item.rowErrors?.length > 0 && <details className="row-error-details"><summary>{item.rowErrors.length} row issues</summary><ImportErrors errors={item.rowErrors.map((error) => ({ ...error, status: error.errorCode === 'DUPLICATE' ? 'skipped' : 'rejected' }))} /></details>}</td><td>{item.importedBy?.name || 'Deleted account'}</td><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.totalRows}</td><td>{item.addedRows}</td><td>{item.skippedRows}</td><td>{item.rejectedRows}</td><td>{item.status}</td></tr>)}
                {!monthlyLoading && monthlyImports.length === 0 && <tr><td colSpan="8" className="empty-state">No imports for this month.</td></tr>}
              </tbody></table></div>
            </section>
          </section>
  );
}
