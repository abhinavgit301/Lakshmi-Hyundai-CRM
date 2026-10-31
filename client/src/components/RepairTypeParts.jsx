import { memo } from 'react';
import { getMasterRepairTypePresentation, MASTER_REPAIR_TYPE_ORDER } from '../utils/repairTypes.js';

export const RepairTypeBadge = memo(function RepairTypeBadge({ type }) {
  const presentation = getMasterRepairTypePresentation(type);
  return (
    <span className={`repair-type-badge ${presentation.className}`} title={type || 'Others'}>
      {presentation.short}
    </span>
  );
});

export const RepairTypeLegend = memo(function RepairTypeLegend() {
  return (
    <div className="repair-type-legend" aria-label="Repair type color legend">
      <span className="repair-type-legend-title">Repair types:</span>
      {MASTER_REPAIR_TYPE_ORDER.map((type) => {
        const presentation = getMasterRepairTypePresentation(type);
        return (
          <span className="repair-type-legend-item" key={type}>
            <span className={`repair-type-dot ${presentation.className}`} aria-hidden="true" />
            <span><strong>{presentation.short}</strong> {type}</span>
          </span>
        );
      })}
    </div>
  );
});
