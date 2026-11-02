import { memo } from 'react';
import { X } from 'lucide-react';
import { MASTER_REPAIR_TYPE_ORDER } from '../utils/repairTypes.js';

function AccordionFiltersBase({
  search,
  onSearchChange,
  ariaLabel,
  kind,
  dueCategory,
  onDueCategoryChange,
  repairType,
  onRepairTypeChange,
  filters = {},
  defaultFilters = {},
  onFilterChange,
  currentRole,
  allocationCres = [],
  onClear,
}) {
  const isDue = kind === 'due';
  const isFree = kind === 'free' || kind === 'followup-free';
  const isWarranty = kind === 'warranty' || kind === 'followup-warranty';
  const isFollowUp = kind?.startsWith('followup-');
  const searchPlaceholder = isDue ? 'Name, mobile, VIN, registration or RO' : 'Name, mobile, VIN or registration';
  const atDefaults = Object.keys({ ...filters, ...defaultFilters }).every((key) => (filters[key] || '') === (defaultFilters[key] || ''));
  return (
    <div className="accordion-list-filters" aria-label={ariaLabel}>
      <label className="master-list-search accordion-search-row">
        Search customers
        <span className="master-list-search-control">
          <input
            type="search"
            value={search}
            placeholder={searchPlaceholder}
            aria-label={`Search by customer ${searchPlaceholder.toLowerCase()}`}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          {search && (
            <button type="button" className="master-list-clear-search" aria-label="Clear search" onClick={() => onSearchChange('')}>
              <X size={15} aria-hidden="true" />
            </button>
          )}
        </span>
      </label>
      <div className="master-list-filters accordion-filter-row">
        {isDue && <>
          <label>
            Due category
            <select value={dueCategory} onChange={(event) => onDueCategoryChange(event.target.value)}>
              <option value="">All customers</option>
              <option value="6m">6 Months Due</option>
              <option value="1y">1 Year Due</option>
              <option value="allDue">All Due Customers</option>
            </select>
          </label>
          <label>
            Repair type
            <select value={repairType} onChange={(event) => onRepairTypeChange(event.target.value)}>
              <option value="">All repair types</option>
              {MASTER_REPAIR_TYPE_ORDER.map((type) => (
                <option key={type} value={type}>{type === 'Free' ? 'Free Service' : type === 'Paid' ? 'Paid Service' : type}</option>
              ))}
            </select>
          </label>
          <label>
            Due status
            <select value={filters.pastDueOnly || ''} onChange={(event) => onFilterChange('pastDueOnly', event.target.value)}>
              <option value="">All due dates</option>
              <option value="true">Past due</option>
            </select>
          </label>
        </>}
        {isFree && <>
          <label>Milestone
            <select value={filters.milestone || ''} onChange={(event) => onFilterChange('milestone', event.target.value)}>
              <option value="">All milestones</option>
              <option value="1">1st free service</option>
              <option value="2">2nd free service</option>
              <option value="3">3rd free service</option>
            </select>
          </label>
          <label>Service status
            <select value={filters.graceStatus ?? ''} onChange={(event) => onFilterChange('graceStatus', event.target.value)}>
              <option value="active">Upcoming + Grace</option>
              <option value="upcoming">Upcoming</option>
              <option value="grace">Grace period</option>
              <option value="expired">Expired</option>
              <option value="">All statuses</option>
            </select>
          </label>
        </>}
        {isWarranty && <label>Contact status
          <select value={filters.contactStatus || ''} onChange={(event) => onFilterChange('contactStatus', event.target.value)}>
            <option value="">All contact statuses</option>
            <option value="Contacted">Contacted</option>
            <option value="Not contacted">Not contacted</option>
          </select>
        </label>}
        {(isFree || isWarranty) && currentRole === 'CCM' && <label>Assigned CRE
          <select value={filters.assigneeId || ''} onChange={(event) => onFilterChange('assigneeId', event.target.value)}>
            <option value="">All CREs</option>
            {allocationCres.map((cre) => <option key={cre.id} value={cre.id}>{cre.name || cre.username}</option>)}
          </select>
        </label>}
        {(isFree || isWarranty) && !isFollowUp && <label>Follow-up
          <select value={filters.followUpStatus || ''} onChange={(event) => onFilterChange('followUpStatus', event.target.value)}>
            <option value="">Any follow-up status</option>
            <option value="scheduled">Scheduled</option>
            <option value="notScheduled">Not scheduled</option>
          </select>
        </label>}
        <button
          type="button"
          className="outline-btn master-list-clear-filters"
          disabled={!search && !dueCategory && !repairType && atDefaults}
          onClick={() => {
            onSearchChange('');
            if (isDue) {
              onDueCategoryChange('');
              onRepairTypeChange('');
            }
            onClear?.();
          }}
        >Clear filters</button>
      </div>
    </div>
  );
}

export default memo(AccordionFiltersBase);
