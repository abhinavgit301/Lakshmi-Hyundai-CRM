import { memo } from 'react';

// Lightweight placeholders shown while lazy view chunks load; they reuse the existing panel styling.
function SectionSkeletonBase({ rows = 5 }) {
  return (
    <section className="panel skeleton-panel" role="status" aria-busy="true" aria-label="Loading">
      <span className="skeleton skeleton-title" />
      {Array.from({ length: rows }, (_, index) => <span key={index} className="skeleton skeleton-row" />)}
    </section>
  );
}

export const SectionSkeleton = memo(SectionSkeletonBase);

function StatsSkeletonBase({ cards = 4 }) {
  return (
    <section className="stats-grid" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: cards }, (_, index) => (
        <article key={index} className="stat-card">
          <span className="skeleton skeleton-line short" />
          <span className="skeleton skeleton-stat" />
        </article>
      ))}
    </section>
  );
}

export const StatsSkeleton = memo(StatsSkeletonBase);
