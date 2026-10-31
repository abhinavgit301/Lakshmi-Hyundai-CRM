import { memo } from 'react';
import { PhoneCall } from 'lucide-react';
import { formatDate, formatOutcome } from '../utils/crmHelpers.js';
import SpacerRow from './SpacerRow.jsx';
import { useWindowRows } from '../hooks/useWindowRows.js';

const ServiceListRow = memo(function ServiceListRow({
  record,
  isFree,
  isCcm,
  followUpQueue,
  onOpenCustomer,
  onChangeFollowUpStatus,
  measureRef,
  index,
}) {
  return (
    <tr ref={measureRef} data-index={index}>
      <td><button type="button" className="text-link" onClick={() => onOpenCustomer(record, 'profile')}>{record.name || '—'}</button></td>
      <td>{record.mobile || '—'}</td>
      <td>{record.registrationNumber || '—'}</td>
      <td>{record.vin || '—'}</td>
      <td>{formatDate(record.saleDate)}</td>
      {isFree ? (
        <>
          <td>{record.milestoneName}</td>
          <td>{formatDate(record.dueDate)}</td>
          <td>{formatDate(record.callingStartDate)}</td>
          <td>{record.lastCall ? `${formatDate(record.lastCall.createdAt)} · ${formatOutcome(record.lastCall.outcome)}` : record.callStatus}</td>
        </>
      ) : (
        <>
          <td>{formatDate(record.warrantyExpiryDate)}</td>
          <td>{record.callingWindow?.start ? new Date(record.callingWindow.start).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : '—'}</td>
          <td>{record.lastCall ? `${formatDate(record.lastCall.createdAt)} · ${formatOutcome(record.lastCall.outcome)}` : '—'}</td>
          <td><span className={`badge ${record.contactStatus === 'Contacted' ? 'badge-blue' : 'badge-neutral'}`}>{record.contactStatus}</span></td>
        </>
      )}
      <td>{record.followUp ? `Scheduled ${new Date(record.followUp.followUpAt).toLocaleString()}` : '—'}</td>
      <td>
        {isCcm ? record.assigneeName || 'Unassigned' : (
          <button type="button" className="icon-btn call-icon-btn" aria-label={`Call ${record.name}`} title="Call customer" disabled={!record.customerId} onClick={() => onOpenCustomer({ ...record, callSource: isFree ? 'FREE_SERVICE' : 'WARRANTY' }, 'call')}>
            <PhoneCall size={17} aria-hidden="true" />
          </button>
        )}
      </td>
      {followUpQueue && <td>
        <div className="inline-actions">
          <button type="button" className="outline-btn compact-btn" onClick={() => onChangeFollowUpStatus(record.followUpId, 'completed')}>Complete</button>
          <button type="button" className="outline-btn compact-btn" onClick={() => onChangeFollowUpStatus(record.followUpId, 'cancelled')}>Cancel</button>
        </div>
      </td>}
    </tr>
  );
});

// Free Service and Warranty lists. CREs get a call icon; CCMs see the allocated CRE.
function ServiceListTableBase({
  kind,
  records,
  followUpQueue = false,
  emptyMessage,
  loading,
  currentRole,
  onOpenCustomer,
  onChangeFollowUpStatus,
}) {
  const isFree = kind === 'free';
  const isCcm = currentRole === 'CCM';
  const columnCount = 11 + (followUpQueue ? 1 : 0);
  const { enabled, attachBody, indexes, measureElement, paddingTop, paddingBottom } = useWindowRows(records.length);
  const renderRow = (record, index, measureRef) => (
    <ServiceListRow
      key={record.id}
      record={record}
      index={index}
      measureRef={measureRef}
      isFree={isFree}
      isCcm={isCcm}
      followUpQueue={followUpQueue}
      onOpenCustomer={onOpenCustomer}
      onChangeFollowUpStatus={onChangeFollowUpStatus}
    />
  );
  return (
    <div className="table-scroll">
      <table className="master-call-list-table service-list-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Number</th>
            <th>Regd no.</th>
            <th>VIN</th>
            <th>Sale date</th>
            {isFree ? (
              <>
                <th>Milestone</th>
                <th>Due date</th>
                <th>Calling from</th>
                <th>Call status</th>
              </>
            ) : (
              <>
                <th>Warranty expiry</th>
                <th>Calling month</th>
                <th>Previous call</th>
                <th>Contact status</th>
              </>
            )}
            <th>Follow-up</th>
            <th>{isCcm ? 'Allocated CRE' : 'Call'}</th>
            {followUpQueue && <th>Action</th>}
          </tr>
        </thead>
        <tbody ref={attachBody}>
          {enabled ? (
            <>
              <SpacerRow height={paddingTop} columns={columnCount} />
              {indexes.map((index) => renderRow(records[index], index, measureElement))}
              <SpacerRow height={paddingBottom} columns={columnCount} />
            </>
          ) : records.map((record) => renderRow(record))}
          {!loading && records.length === 0 && (
            <tr><td colSpan={columnCount} className="empty-state">{emptyMessage || (followUpQueue ? `No ${isFree ? 'free service' : 'warranty'} follow-ups scheduled.` : isFree ? 'No free-service customers are ready to call.' : 'No warranties are in their calling month.')}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default memo(ServiceListTableBase);
