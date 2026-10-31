import { memo } from 'react';
import { X } from 'lucide-react';
import { MASTER_REPAIR_TYPE_ORDER } from '../utils/repairTypes.js';

function AccordionFiltersBase({
  search,
  onSearchChange,
  ariaLabel,
  dueCategory,
  onDueCategoryChange,
  repairType,
  onRepairTypeChange,
}) {
  return (
    <div className="master-list-filters accordion-list-filters" aria-label={ariaLabel}>
      <label className="master-list-search">
        Search customers
        <span className="master-list-search-control">
          <input
            type="search"
            value={search}
            placeholder="Name, mobile, VIN, registration or RO"
            aria-label="Search by customer name, mobile, VIN, registration number, or repair order"
            onChange={(event) => onSearchChange(event.target.value)}
          />
          {search && (
            <button type="button" className="master-list-clear-search" aria-label="Clear search" onClick={() => onSearchChange('')}>
              <X size={15} aria-hidden="true" />
            </button>
          )}
        </span>
      </label>
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
      <button
        type="button"
        className="outline-btn master-list-clear-filters"
        disabled={!search && !dueCategory && !repairType}
        onClick={() => {
          onSearchChange('');
          onDueCategoryChange('');
          onRepairTypeChange('');
        }}
      >Clear filters</button>
    </div>
  );
}

export default memo(AccordionFiltersBase);
