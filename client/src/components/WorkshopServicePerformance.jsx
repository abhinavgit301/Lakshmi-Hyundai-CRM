import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '../lib/api.js';

const CATEGORIES = ['Free Service', 'PMS', 'Accidental Repair', 'Running Repair', 'Others'];
const COLORS = ['#145a62', '#398b80', '#d28a39', '#7b6ba8', '#8a969b'];
const TABS = ['Load Analysis', 'Load Trend', 'MTD Load'];

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function shiftMonth(value, offset) {
  const [year, month] = value.split('-').map(Number);
  const date = new Date(year, month - 1 + offset, 1);
  return monthKey(date.getFullYear(), date.getMonth() + 1);
}

function monthLabel(value) {
  return new Date(`${value}-01T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function getMonthCount(entry, serviceType) {
  return serviceType === 'All' ? entry?.total || 0 : entry?.categories?.[serviceType] || 0;
}

function getPercentChange(current, previous) {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function changeLabel(value) {
  if (value == null) return 'N/A';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function monthOptions(count = 119) {
  const result = [];
  const now = new Date();
  for (let offset = 0; offset < count; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    result.push(monthKey(date.getFullYear(), date.getMonth() + 1));
  }
  return result;
}

function DataNotice({ data, selectedRange }) {
  if (!data || data.filteredRangeCount > 0) return null;
  let message = 'No dated workshop service records were found for this selected period.';
  if (data.historyCount === 0) {
    message = 'No workshop service history exists in the database yet. Analytics will appear after repair-order service records are imported.';
  } else if (data.rangeCount > 0 && data.serviceType !== 'All') {
    message = `No ${data.serviceType} service records were found for this selected period.`;
  } else if (data.undatedHistoryCount > 0) {
    message = `No dated workshop service records were found for ${selectedRange}. ${data.undatedHistoryCount} historical record${data.undatedHistoryCount === 1 ? ' has' : 's have'} no visit date and cannot be included.`;
  }
  return <p className="form-alert info" role="status">{message}</p>;
}

function FilterPanel({ children }) {
  return <section className="panel service-filters">{children}</section>;
}

export default function WorkshopServicePerformance({ role, ccmId: forcedCcmId }) {
  const [activeTab, setActiveTab] = useState(TABS[0]);
  const now = useMemo(() => new Date(), []);
  const currentMonth = monthKey(now.getFullYear(), now.getMonth() + 1);
  const years = Array.from({ length: 10 }, (_, index) => now.getFullYear() - index);
  const months = useMemo(() => monthOptions(), []);
  const isTeamScoped = role === 'CCM';
  const [teamCcmId, setTeamCcmId] = useState('');
  const [teams, setTeams] = useState([]);
  const ccmId = isTeamScoped ? forcedCcmId : teamCcmId;

  useEffect(() => {
    if (isTeamScoped) return undefined;
    let isCurrent = true;
    api.get('/teams').then((response) => { if (isCurrent) setTeams(response.data.ccms || []); }).catch(() => {});
    return () => { isCurrent = false; };
  }, [isTeamScoped]);

  const [analysisPeriod, setAnalysisPeriod] = useState('year');
  const [analysisYear, setAnalysisYear] = useState(now.getFullYear());
  const [analysisMonth, setAnalysisMonth] = useState(now.getMonth() + 1);
  const [trendStart, setTrendStart] = useState(shiftMonth(currentMonth, -11));
  const [trendEnd, setTrendEnd] = useState(currentMonth);
  const [trendType, setTrendType] = useState('All');
  const [mtdPeriod, setMtdPeriod] = useState(currentMonth);
  const [mtdType, setMtdType] = useState('All');
  const [result, setResult] = useState(null);
  const [requestError, setRequestError] = useState(null);

  const requestRange = useMemo(() => {
    if (activeTab === 'Load Analysis') {
      const endMonth = analysisYear === now.getFullYear() ? now.getMonth() + 1 : 12;
      return analysisPeriod === 'year'
        ? { startMonth: `${analysisYear - 1}-01`, endMonth: monthKey(analysisYear, endMonth), serviceType: 'All' }
        : {
          startMonth: monthKey(analysisYear - 1, analysisMonth),
          endMonth: monthKey(analysisYear, analysisMonth),
          serviceType: 'All',
        };
    }
    if (activeTab === 'Load Trend') {
      return { startMonth: shiftMonth(trendStart, -1), endMonth: trendEnd, serviceType: trendType };
    }
    return { startMonth: shiftMonth(mtdPeriod, -12), endMonth: mtdPeriod, serviceType: mtdType };
  }, [activeTab, analysisPeriod, analysisYear, analysisMonth, trendStart, trendEnd, trendType, mtdPeriod, mtdType, now]);

  const requestParams = useMemo(() => ({ ...requestRange, ...(ccmId ? { ccmId } : {}) }), [requestRange, ccmId]);
  const requestKey = JSON.stringify(requestParams);
  const data = result?.key === requestKey ? result.data : null;
  const error = requestError?.key === requestKey ? requestError.message : '';
  const loading = data === null && !error;

  useEffect(() => {
    let isCurrent = true;
    api.get('/performance/workshop-services', { params: requestParams })
      .then((response) => {
        if (isCurrent) {
          setRequestError(null);
          setResult({ key: requestKey, data: response.data });
        }
      })
      .catch((requestError) => {
        if (isCurrent) setRequestError({
          key: requestKey,
          message: requestError.response?.data?.message || 'Could not load workshop service analytics.',
        });
      });
    return () => { isCurrent = false; };
  }, [requestKey, requestParams]);

  const byMonth = useMemo(() => new Map((data?.months || []).map((entry) => [entry.month, entry])), [data]);
  const availableMonths = months.filter((month) => month <= currentMonth);

  const analysisRows = useMemo(() => CATEGORIES.map((category) => {
    const monthStart = analysisPeriod === 'year' ? 1 : analysisMonth;
    const monthEnd = analysisPeriod === 'year'
      ? (analysisYear === now.getFullYear() ? now.getMonth() + 1 : 12)
      : analysisMonth;
    const isPartial = analysisYear === now.getFullYear()
      && (analysisPeriod === 'year' || analysisMonth === now.getMonth() + 1);
    const cutoffDay = isPartial ? now.getDate() : 31;
    const sumPeriod = (year) => (data?.daily || []).reduce((sum, entry) => {
      const [entryYear, entryMonth, entryDay] = entry.date.split('-').map(Number);
      if (entryYear !== year || entryMonth < monthStart || entryMonth > monthEnd) return sum;
      if (isPartial && entryMonth === monthEnd && entryDay > cutoffDay) return sum;
      return sum + (entry.categories[category] || 0);
    }, 0);
    const previous = sumPeriod(analysisYear - 1);
    const current = sumPeriod(analysisYear);
    return { category, previous, current, change: current - previous, percent: getPercentChange(current, previous) };
  }), [analysisPeriod, analysisYear, analysisMonth, data, now]);
  const analysisTotals = useMemo(() => ({
    previous: analysisRows.reduce((sum, row) => sum + row.previous, 0),
    current: analysisRows.reduce((sum, row) => sum + row.current, 0),
  }), [analysisRows]);

  const trendRangeMonths = useMemo(() => {
    const result = [];
    for (let current = trendStart; current <= trendEnd; current = shiftMonth(current, 1)) result.push(current);
    return result;
  }, [trendStart, trendEnd]);
  const trendRows = useMemo(() => trendRangeMonths.map((month, index) => {
    const source = byMonth.get(month);
    const current = getMonthCount(source, trendType);
    const previous = getMonthCount(byMonth.get(index === 0 ? shiftMonth(month, -1) : trendRangeMonths[index - 1]), trendType);
    return {
      month,
      label: monthLabel(month),
      total: current,
      change: current - previous,
      percent: getPercentChange(current, previous),
      ...(source?.categories || Object.fromEntries(CATEGORIES.map((category) => [category, 0]))),
    };
  }), [trendRangeMonths, byMonth, trendType]);

  const mtdValues = useMemo(() => {
    const [selectedYear, selectedMonth] = mtdPeriod.split('-').map(Number);
    const previousYear = selectedYear - 1;
    const selectedMonthDays = new Date(selectedYear, selectedMonth, 0).getDate();
    const previousMonthDays = new Date(previousYear, selectedMonth, 0).getDate();
    const isCurrentMonth = selectedYear === now.getFullYear() && selectedMonth === now.getMonth() + 1;
    const days = Math.min(selectedMonthDays, previousMonthDays, isCurrentMonth ? now.getDate() : selectedMonthDays);
    const dailyCurrent = new Map();
    const dailyPrevious = new Map();
    (data?.daily || []).forEach((entry) => {
      const [year, month, day] = entry.date.split('-').map(Number);
      const target = year === selectedYear && month === selectedMonth ? dailyCurrent
        : year === previousYear && month === selectedMonth ? dailyPrevious : null;
      if (target) target.set(day, getMonthCount({ total: entry.total, categories: entry.categories }, mtdType));
    });
    const dailyChartRows = Array.from({ length: days }, (_, index) => index + 1).reduce((rows, day) => {
      const prior = rows.at(-1) || { current: 0, previous: 0 };
      return [...rows, {
        day,
        current: prior.current + (dailyCurrent.get(day) || 0),
        previous: prior.previous + (dailyPrevious.get(day) || 0),
      }];
    }, []);
    const currentTotal = dailyChartRows.at(-1)?.current || 0;
    const previousTotal = dailyChartRows.at(-1)?.previous || 0;
    return {
      days,
      chartRows: dailyChartRows,
      currentTotal,
      previousTotal,
      change: currentTotal - previousTotal,
      percent: getPercentChange(currentTotal, previousTotal),
    };
  }, [mtdPeriod, mtdType, data, now]);

  const hasDataInActiveRange = (data?.filteredRangeCount || 0) > 0;

  return (
    <section className="customer-workspace service-performance">
      {!isTeamScoped && (
        <section className="panel service-filters">
          <label>Team
            <select value={teamCcmId} onChange={(event) => setTeamCcmId(event.target.value)}>
              <option value="">All teams (combined)</option>
              {teams.map((team) => <option key={team.ccmId} value={team.ccmId}>{team.name}{team.dealerCode ? ` · ${team.dealerCode}` : ''}</option>)}
            </select>
          </label>
        </section>
      )}
      <nav className="service-tabs" role="tablist" aria-label="Workshop service analytics">
        {TABS.map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={activeTab === tab}
            className={`service-tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </nav>

      {activeTab === 'Load Analysis' && (
        <>
          <FilterPanel>
            <label>Compare<select value={analysisPeriod} onChange={(event) => setAnalysisPeriod(event.target.value)}><option value="year">Full year</option><option value="month">Same month</option></select></label>
            <label>Year<select value={analysisYear} onChange={(event) => setAnalysisYear(Number(event.target.value))}>{years.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
            {analysisPeriod === 'month' && <label>Month<select value={analysisMonth} onChange={(event) => setAnalysisMonth(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option key={month} value={month} disabled={analysisYear === now.getFullYear() && month > now.getMonth() + 1}>{new Date(2000, month - 1, 1).toLocaleDateString(undefined, { month: 'long' })}</option>)}</select></label>}
          </FilterPanel>
          {error && <p className="form-alert error" role="alert">{error}</p>}
          <DataNotice data={data} selectedRange={`${analysisYear - 1}–${analysisYear}`} />
          {loading ? <p className="panel service-empty">Loading service history…</p> : (
            <>
              <section className="stats-grid">
                <article className="stat-card"><p>{analysisYear - 1} service volume</p><strong>{analysisTotals.previous}</strong></article>
                <article className="stat-card"><p>{analysisYear} service volume</p><strong>{analysisTotals.current}</strong></article>
              </section>
              {!analysisTotals.previous && !analysisTotals.current && data?.rangeCount > 0 && <p className="form-alert info" role="status">No service records were found through the equivalent day in either selected period.</p>}
              {(analysisTotals.previous > 0 || analysisTotals.current > 0) && (
                <>
                  <section className="panel">
                    <div className="panel-header"><h3>Service volume by category</h3><span>{analysisPeriod === 'year' ? `${analysisYear === now.getFullYear() ? `Jan–${new Date(2000, now.getMonth(), 1).toLocaleDateString(undefined, { month: 'short' })} ` : ''}${analysisYear - 1} vs ${analysisYear}` : `${monthLabel(monthKey(analysisYear - 1, analysisMonth))} vs ${monthLabel(monthKey(analysisYear, analysisMonth))}`}</span></div>
                    <div className="service-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={analysisRows} margin={{ top: 12, right: 12, left: 0, bottom: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="category" /><YAxis allowDecimals={false} /><Tooltip /><Legend />
                      <Bar dataKey="previous" name={String(analysisYear - 1)} fill="#aeb8bc" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="current" name={String(analysisYear)} fill="#145a62" radius={[4, 4, 0, 0]} />
                    </BarChart></ResponsiveContainer></div>
                  </section>
                  <section className="panel customer-list-panel">
                    <div className="panel-header"><h3>Year-over-year comparison</h3></div>
                    <div className="table-scroll"><table><thead><tr><th>Service category</th><th>Previous period</th><th>Current period</th><th>Change</th><th>Change %</th></tr></thead><tbody>
                      {analysisRows.map((row) => <tr key={row.category}><td>{row.category}</td><td>{row.previous}</td><td>{row.current}</td><td className={row.change > 0 ? 'service-increase' : row.change < 0 ? 'service-decrease' : ''}>{row.change > 0 ? '+' : ''}{row.change}</td><td>{row.percent == null ? (row.current > 0 ? 'New' : 'N/A') : changeLabel(row.percent)}</td></tr>)}
                    </tbody></table></div>
                  </section>
                </>
              )}
            </>
          )}
        </>
      )}

      {activeTab === 'Load Trend' && (
        <>
          <FilterPanel>
            <label>From month<input type="month" value={trendStart} max={trendEnd} onChange={(event) => setTrendStart(event.target.value)} /></label>
            <label>To month<input type="month" value={trendEnd} min={trendStart} max={currentMonth} onChange={(event) => setTrendEnd(event.target.value)} /></label>
            <label>Service type<select value={trendType} onChange={(event) => setTrendType(event.target.value)}><option value="All">All services</option>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
          </FilterPanel>
          {error && <p className="form-alert error" role="alert">{error}</p>}
          <DataNotice data={data} selectedRange={`${trendStart} to ${trendEnd}`} />
          {loading ? <p className="panel service-empty">Loading service history…</p> : hasDataInActiveRange && (
            <>
              <section className="panel">
                <div className="panel-header"><h3>Monthly service volume</h3><span>{trendType === 'All' ? 'Overall and category trends' : trendType}</span></div>
                <div className="service-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={trendRows} margin={{ top: 12, right: 18, left: 0, bottom: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" /><YAxis allowDecimals={false} /><Tooltip /><Legend />
                  {trendType === 'All'
                    ? <Line type="monotone" dataKey="total" name="Overall" stroke="#202a2f" strokeWidth={3} dot={false} />
                    : <Line type="monotone" dataKey="total" name={trendType} stroke={COLORS[CATEGORIES.indexOf(trendType)]} strokeWidth={3} dot={false} />}
                  {trendType === 'All' && CATEGORIES.map((category, index) => <Line key={category} type="monotone" dataKey={category} stroke={COLORS[index]} name={category} dot={false} />)}
                </LineChart></ResponsiveContainer></div>
              </section>
              <section className="panel customer-list-panel">
                <div className="panel-header"><h3>Month-on-month growth</h3><span>{trendType === 'All' ? 'All services' : trendType}</span></div>
                <div className="table-scroll"><table><thead><tr><th>Month</th><th>Service volume</th><th>Change</th><th>Change %</th></tr></thead><tbody>
                  {trendRows.map((row) => <tr key={row.month}><td>{row.label}</td><td>{row.total}</td><td className={row.change > 0 ? 'service-increase' : row.change < 0 ? 'service-decrease' : ''}>{row.change > 0 ? '+' : ''}{row.change}</td><td>{row.percent == null ? (row.total > 0 ? 'New' : 'N/A') : changeLabel(row.percent)}</td></tr>)}
                </tbody></table></div>
              </section>
            </>
          )}
        </>
      )}

      {activeTab === 'MTD Load' && (
        <>
          <FilterPanel>
            <label>Month<input type="month" value={mtdPeriod} max={currentMonth} min={availableMonths.at(-1)} onChange={(event) => setMtdPeriod(event.target.value)} /></label>
            <label>Service type<select value={mtdType} onChange={(event) => setMtdType(event.target.value)}><option value="All">All services</option>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
          </FilterPanel>
          {error && <p className="form-alert error" role="alert">{error}</p>}
          <DataNotice data={data} selectedRange={`${shiftMonth(mtdPeriod, -12)} to ${mtdPeriod}`} />
          {loading ? <p className="panel service-empty">Loading service history…</p> : (
            <>
              <p className="service-comparison-label">Comparing equivalent days: {mtdPeriod} vs {shiftMonth(mtdPeriod, -12)} · through day {mtdValues.days}</p>
              <section className="stats-grid">
                <article className="stat-card"><p>Current MTD · {mtdPeriod}</p><strong>{mtdValues.currentTotal}</strong></article>
                <article className="stat-card"><p>Previous-year MTD · {shiftMonth(mtdPeriod, -12)}</p><strong>{mtdValues.previousTotal}</strong></article>
                <article className="stat-card"><p>Absolute difference</p><strong className={mtdValues.change > 0 ? 'service-increase' : mtdValues.change < 0 ? 'service-decrease' : ''}>{mtdValues.change > 0 ? '+' : ''}{mtdValues.change}</strong></article>
                <article className="stat-card"><p>Percentage change</p><strong>{mtdValues.percent == null ? (mtdValues.currentTotal > 0 ? 'New' : 'N/A') : changeLabel(mtdValues.percent)}</strong></article>
              </section>
              {!mtdValues.currentTotal && !mtdValues.previousTotal && hasDataInActiveRange && <p className="form-alert info" role="status">No service records were found through the equivalent day in either selected period.</p>}
              {(mtdValues.currentTotal > 0 || mtdValues.previousTotal > 0) && <section className="panel">
                <div className="panel-header"><h3>Cumulative daily service volume</h3><span>{mtdType === 'All' ? 'All services' : mtdType}</span></div>
                <div className="service-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={mtdValues.chartRows} margin={{ top: 12, right: 18, left: 0, bottom: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" label={{ value: 'Day of month', position: 'insideBottom', offset: -4 }} /><YAxis allowDecimals={false} /><Tooltip /><Legend />
                  <Line type="monotone" dataKey="current" name={mtdPeriod} stroke="#145a62" strokeWidth={3} dot={false} />
                  <Line type="monotone" dataKey="previous" name={shiftMonth(mtdPeriod, -12)} stroke="#aeb8bc" strokeWidth={3} dot={false} />
                </LineChart></ResponsiveContainer></div>
              </section>}
            </>
          )}
        </>
      )}
    </section>
  );
}
