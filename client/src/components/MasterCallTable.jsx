import { memo } from 'react';
import { PhoneCall } from 'lucide-react';
import { formatVehicleAge } from '../utils/crmHelpers.js';
import { RepairTypeBadge, RepairTypeLegend } from './RepairTypeParts.jsx';
import SpacerRow from './SpacerRow.jsx';
import { useWindowRows } from '../hooks/useWindowRows.js';

const MasterCallRow = memo(function MasterCallRow({
  record,
  loading,
  assignable,
  showCallColumn,
  canOpenProfile,
  dueMode,
  currentUserId,
  allocationCres,
  saving,
  onOpenProfile,
  onStartCall,
  onChangeAssignee,
  measureRef,
  index,
}) {
  const name = record.name || record.customerName;
  return (
    <tr ref={measureRef} data-index={index}>
      <td><RepairTypeBadge type={record.type} /></td>
      <td className={record.dueDate && new Date(record.dueDate) < new Date() ? 'due-overdue' : undefined}>{record.dueDate ? new Date(record.dueDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—'}</td>
      <td>{canOpenProfile ? (
        <button type="button" className="text-link" onClick={() => onOpenProfile(record)}>
          {name || '—'}
        </button>
      ) : name || '—'}</td>
      <td>{record.mobile || '—'}</td>
      <td>{record.model || '—'}</td>
      <td>{record.vin || '—'}</td>
      <td>{formatVehicleAge(record.vehicleAgeMonths)}</td>
      <td>{record.registrationNumber || '—'}</td>
      <td><span className="badge badge-neutral">{record.status || 'pending'}</span></td>
      <td>{record.scheduledAppointment ? new Date(record.scheduledAppointment.scheduledAt).toLocaleString() : '—'}</td>
      <td>{assignable ? (
        <select
          className="status-select master-list-assignee"
          aria-label={`Allocated CRE for ${name || record.vin || 'vehicle'}`}
          value={record.assigneeId || ''}
          disabled={saving || loading}
          onChange={(event) => onChangeAssignee(record.id, event.target.value, record)}
        >
          {record.assigneeId && !allocationCres.some((cre) => cre.id === record.assigneeId) && (
            <option value={record.assigneeId}>{record.assigneeName || 'Former CRE'} (inactive)</option>
          )}
          {allocationCres.filter((cre) => cre.ccmId === record.ccmId).map((cre) => (
            <option key={cre.id} value={cre.id}>{cre.name}</option>
          ))}
        </select>
      ) : showCallColumn ? (
        <button
          type="button"
          className="icon-btn call-icon-btn"
          aria-label={`Call ${name || 'customer'}`}
          title={dueMode || record.assigneeId === currentUserId ? 'Call customer' : 'This customer is not assigned to you'}
          disabled={dueMode ? !record.customerId : loading || !record.customerId || record.assigneeId !== currentUserId}
          onClick={() => onStartCall(record)}
        >
          <PhoneCall size={17} aria-hidden="true" />
        </button>
      ) : record.assigneeName || 'Unassigned'}</td>
    </tr>
  );
});

function MasterCallTableBase({
  records,
  loading,
  assignable = false,
  dueMode = false,
  emptyMessage,
  currentRole,
  currentUserId,
  activeView,
  allocationCres,
  savingId,
  onOpenProfile,
  onStartCall,
  onChangeAssignee,
}) {
  const showCallColumn = dueMode || (currentRole === 'CRE' && activeView === 'Master list' && !assignable);
  const canOpenProfile = dueMode || ['CCM', 'CRE'].includes(currentRole);
  const { enabled, attachBody, indexes, measureElement, paddingTop, paddingBottom } = useWindowRows(records.length);
  const renderRow = (record, index, measureRef) => (
    <MasterCallRow
      key={record.id}
      record={record}
      index={index}
      measureRef={measureRef}
      loading={loading}
      assignable={assignable}
      showCallColumn={showCallColumn}
      canOpenProfile={canOpenProfile}
      dueMode={dueMode}
      currentUserId={currentUserId}
      allocationCres={allocationCres}
      saving={savingId === record.id}
      onOpenProfile={onOpenProfile}
      onStartCall={onStartCall}
      onChangeAssignee={onChangeAssignee}
    />
  );
  return (
    <div className="master-list-table-wrap">
      <RepairTypeLegend />
      <div className="table-scroll">
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
              <th>{showCallColumn ? 'Call' : 'Allocated CRE'}</th>
            </tr>
          </thead>
          <tbody ref={attachBody}>
            {enabled ? (
              <>
                <SpacerRow height={paddingTop} columns={11} />
                {indexes.map((index) => renderRow(records[index], index, measureElement))}
                <SpacerRow height={paddingBottom} columns={11} />
              </>
            ) : records.map((record) => renderRow(record))}
            {!loading && records.length === 0 && <tr><td colSpan="11" className="empty-state">{emptyMessage || 'No master call list records found.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default memo(MasterCallTableBase);
