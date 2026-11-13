import PDFDocument from 'pdfkit';
import { queryWorkshopServiceData, SERVICE_CATEGORIES } from './workshopServicePerformanceController.js';
import { queryWorkshopReportsData } from './workshopPerformanceController.js';

const PRIMARY_COLOR = '#145a62';
const SECONDARY_COLOR = '#94a3b8';
const ACCENT_COLOR = '#dc5c43';
const TEXT_DARK = '#1f2937';
const TEXT_MUTED = '#64748b';
const BORDER_COLOR = '#e2e8f0';

function formatNumber(num) {
  return Number(num || 0).toLocaleString('en-IN');
}

function formatPercent(val) {
  if (val == null || !Number.isFinite(val)) return 'N/A';
  return `${val > 0 ? '+' : ''}${val.toFixed(1)}%`;
}

function drawReportHeader(doc, { title, subtitle, meta }) {
  doc.rect(40, 36, 515, 5).fill(PRIMARY_COLOR);

  doc.fontSize(18).fillColor(PRIMARY_COLOR).font('Helvetica-Bold')
    .text('Lakshmi Hyundai Workshop CRM', 40, 48);

  doc.fontSize(13).fillColor(TEXT_DARK).font('Helvetica-Bold')
    .text(title, 40, 72);

  if (subtitle) {
    doc.fontSize(10).fillColor(TEXT_MUTED).font('Helvetica')
      .text(subtitle, 40, 90);
  }

  if (meta) {
    doc.fontSize(8.5).fillColor(TEXT_MUTED).font('Helvetica')
      .text(meta, 40, 105, { align: 'right', width: 515 });
  }

  doc.moveTo(40, 120).lineTo(555, 120).strokeColor(BORDER_COLOR).lineWidth(1).stroke();
}

function drawKpiBox(doc, { x, y, width, height, label, value, subtext, color = PRIMARY_COLOR }) {
  doc.rect(x, y, width, height).fillAndStroke('#f8fafc', BORDER_COLOR);
  doc.rect(x, y, width, 3).fill(color);

  doc.fontSize(8.5).fillColor(TEXT_MUTED).font('Helvetica')
    .text(label, x + 10, y + 10, { width: width - 20 });

  doc.fontSize(14).fillColor(TEXT_DARK).font('Helvetica-Bold')
    .text(String(value), x + 10, y + 24, { width: width - 20 });

  if (subtext) {
    doc.fontSize(7.5).fillColor(TEXT_MUTED).font('Helvetica')
      .text(subtext, x + 10, y + 42, { width: width - 20 });
  }
}

function drawSimpleTable(doc, { startX, startY, colWidths, headers, rows, headerBg = '#f1f5f9' }) {
  let curY = startY;
  const rowHeight = 20;

  // Header
  doc.rect(startX, curY, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(headerBg);
  let curX = startX;
  headers.forEach((h, i) => {
    doc.fontSize(8).fillColor(TEXT_DARK).font('Helvetica-Bold')
      .text(h.text, curX + 4, curY + 6, { width: colWidths[i] - 8, align: h.align || 'left' });
    curX += colWidths[i];
  });
  curY += rowHeight;

  // Rows
  rows.forEach((r, rowIdx) => {
    if (curY > 740) {
      doc.addPage();
      curY = 50;
    }
    const bg = rowIdx % 2 === 0 ? '#ffffff' : '#f8fafc';
    doc.rect(startX, curY, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(bg);

    let cellX = startX;
    r.forEach((cell, cellIdx) => {
      const align = headers[cellIdx]?.align || 'left';
      const color = cell.color || TEXT_DARK;
      doc.fontSize(8).fillColor(color).font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
        .text(String(cell.text ?? cell), cellX + 4, curY + 6, { width: colWidths[cellIdx] - 8, align });
      cellX += colWidths[cellIdx];
    });
    curY += rowHeight;
  });

  return curY;
}

function applyPageNumbers(doc, reportName) {
  const range = doc.bufferedPageRange();
  const timestamp = new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica')
      .text(
        `Lakshmi Hyundai Workshop CRM · ${reportName} · Page ${i + 1} of ${range.count} · Generated on ${timestamp}`,
        40,
        785,
        { align: 'center', width: 515, lineBreak: false },
      );
  }
}

// -----------------------------------------------------------------------------------
// 1. WORKSHOP SERVICE PERFORMANCE PDF (3 CHARTS: Load Analysis, Load Trend, MTD Load)
// -----------------------------------------------------------------------------------
export async function exportWorkshopPerformancePdf(req, res) {
  const role = String(req.user?.role || '').toUpperCase();
  if (!['ADMIN', 'GM', 'CCM'].includes(role)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const ccmId = role === 'CCM'
    ? String(req.user.ccmId || '').trim()
    : String(req.query.ccmId || '').trim() || null;
  if (role === 'CCM' && !ccmId) {
    return res.status(403).json({ message: 'A CCM assignment is required to export workshop performance.' });
  }
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthNum = now.getMonth() + 1;
  const currentMonthKey = `${currentYear}-${String(currentMonthNum).padStart(2, '0')}`;
  const prevYearStart = `${currentYear - 1}-01`;
  const validYear = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 2015 && parsed <= currentYear ? parsed : fallback;
  };
  const validMonth = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 12 ? parsed : fallback;
  };
  const requestedAnalysisPeriod = req.query.analysisPeriod === 'month' ? 'month' : 'year';
  const analysisYear = validYear(req.query.analysisYear, currentYear);
  const analysisCompareYear = validYear(req.query.analysisCompareYear, Math.max(analysisYear - 1, 2015));
  const analysisMonth = validMonth(req.query.analysisMonth, currentMonthNum);
  const analysisCompareMonth = validMonth(req.query.analysisCompareMonth, analysisMonth);
  const defaultMtdDate = new Date(currentYear, currentMonthNum - 2, 1);
  const requestedMtdPeriod = /^\d{4}-\d{2}$/.test(String(req.query.mtdPeriod || ''))
    ? String(req.query.mtdPeriod)
    : `${defaultMtdDate.getFullYear()}-${String(defaultMtdDate.getMonth() + 1).padStart(2, '0')}`;
  const [requestedMtdYear, requestedMtdMonth] = requestedMtdPeriod.split('-').map(Number);
  const safeMtdYear = validYear(requestedMtdYear, defaultMtdDate.getFullYear());
  const safeMtdMonth = validMonth(requestedMtdMonth, defaultMtdDate.getMonth() + 1);
  const mtdComparisonYear = validYear(req.query.mtdComparisonYear, Math.max(safeMtdYear - 1, 2015));
  const requestedServiceType = String(req.query.serviceType || 'All');
  const serviceType = SERVICE_CATEGORIES.includes(requestedServiceType) ? requestedServiceType : 'All';
  const periodKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
  const rangeSpecs = [
    { startMonth: prevYearStart, endMonth: currentMonthKey },
    requestedAnalysisPeriod === 'year'
      ? { startMonth: `${analysisYear}-01`, endMonth: `${analysisYear}-12` }
      : { startMonth: periodKey(analysisYear, analysisMonth), endMonth: periodKey(analysisYear, analysisMonth) },
    requestedAnalysisPeriod === 'year'
      ? { startMonth: `${analysisCompareYear}-01`, endMonth: `${analysisCompareYear}-12` }
      : { startMonth: periodKey(analysisCompareYear, analysisCompareMonth), endMonth: periodKey(analysisCompareYear, analysisCompareMonth) },
    { startMonth: periodKey(safeMtdYear, safeMtdMonth), endMonth: periodKey(safeMtdYear, safeMtdMonth) },
    { startMonth: periodKey(mtdComparisonYear, safeMtdMonth), endMonth: periodKey(mtdComparisonYear, safeMtdMonth) },
  ];
  const uniqueRanges = [...new Map(rangeSpecs.map((range) => [`${range.startMonth}|${range.endMonth}`, range])).values()];
  const responses = await Promise.all(uniqueRanges.map((range) => queryWorkshopServiceData({ ...range, serviceType, ccmId })));
  if (responses.some((response) => !response)) {
    return res.status(500).json({ message: 'Failed to retrieve workshop service data.' });
  }
  const mergedMonths = new Map();
  const mergedDaily = new Map();
  responses.forEach((response) => {
    response.months.forEach((month) => mergedMonths.set(month.month, month));
    response.daily.forEach((entry) => {
      mergedDaily.set(entry.date, entry);
    });
  });
  const serviceData = { ...responses[0], serviceType, months: [...mergedMonths.values()].sort((a, b) => a.month.localeCompare(b.month)), daily: [...mergedDaily.values()].sort((a, b) => a.date.localeCompare(b.date)) };

  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  const filename = `Workshop_Performance_${now.toISOString().slice(0, 10)}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const teamMeta = ccmId ? `CCM Team: ${ccmId}` : 'All Teams Combined';
  const metaText = `${teamMeta} | Service Type: ${serviceData.serviceType || 'All'}`;

  // =========================================================================
  // PAGE 1: HEADER & CHART 1 - LOAD ANALYSIS
  // =========================================================================
  drawReportHeader(doc, {
    title: 'Workshop Service Analytics Report',
    subtitle: 'Section 1: Load Analysis — Year-Over-Year Category Volume',
    meta: metaText,
  });

  // Calculate Load Analysis figures using the selected comparison periods.
  const periodMatches = (date, year, month) => requestedAnalysisPeriod === 'year'
    ? date.startsWith(String(year))
    : date.startsWith(periodKey(year, month));
  const prevYearDaily = (serviceData.daily || []).filter((d) => periodMatches(d.date, analysisCompareYear, requestedAnalysisPeriod === 'year' ? 1 : analysisCompareMonth));
  const currYearDaily = (serviceData.daily || []).filter((d) => periodMatches(d.date, analysisYear, requestedAnalysisPeriod === 'year' ? 1 : analysisMonth));
  const analysisPreviousLabel = requestedAnalysisPeriod === 'year' ? String(analysisCompareYear) : new Date(`${periodKey(analysisCompareYear, analysisCompareMonth)}-01`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const analysisCurrentLabel = requestedAnalysisPeriod === 'year' ? String(analysisYear) : new Date(`${periodKey(analysisYear, analysisMonth)}-01`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  const analysisRows = SERVICE_CATEGORIES.map((cat) => {
    const prev = prevYearDaily.reduce((acc, d) => acc + (d.categories[cat] || 0), 0);
    const curr = currYearDaily.reduce((acc, d) => acc + (d.categories[cat] || 0), 0);
    const diff = curr - prev;
    const pct = prev === 0 ? null : ((curr - prev) / prev) * 100;
    return { category: cat, prev, curr, diff, pct };
  });

  const totalPrev = analysisRows.reduce((a, b) => a + b.prev, 0);
  const totalCurr = analysisRows.reduce((a, b) => a + b.curr, 0);
  const totalDiff = totalCurr - totalPrev;
  const totalPct = totalPrev === 0 ? null : (totalDiff / totalPrev) * 100;

  // KPI boxes for Load Analysis
  drawKpiBox(doc, {
    x: 40, y: 130, width: 165, height: 58,
    label: `${analysisPreviousLabel} Total Volume`, value: formatNumber(totalPrev), subtext: 'Previous Year', color: SECONDARY_COLOR,
  });
  drawKpiBox(doc, {
    x: 215, y: 130, width: 165, height: 58,
    label: `${analysisCurrentLabel} Total Volume`, value: formatNumber(totalCurr), subtext: 'Current Period (YTD)', color: PRIMARY_COLOR,
  });
  drawKpiBox(doc, {
    x: 390, y: 130, width: 165, height: 58,
    label: 'YoY Volume Change', value: `${totalDiff >= 0 ? '+' : ''}${formatNumber(totalDiff)}`, subtext: formatPercent(totalPct), color: totalDiff >= 0 ? '#16a34a' : ACCENT_COLOR,
  });

  // Load Analysis Bar Chart
  doc.fontSize(11).fillColor(TEXT_DARK).font('Helvetica-Bold')
    .text(`Chart 1: Load Analysis — ${currentYear - 1} vs ${currentYear}`, 40, 202);

  // Chart Legend
  doc.rect(370, 204, 10, 8).fill(SECONDARY_COLOR);
  doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica').text(analysisPreviousLabel, 385, 204);
  doc.rect(450, 204, 10, 8).fill(PRIMARY_COLOR);
  doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica').text(analysisCurrentLabel, 465, 204);

  // Draw grouped bars
  const chartX = 40;
  const chartY = 220;
  const chartW = 515;
  const chartH = 150;
  const analysisChartRows = [...analysisRows, { category: 'Total services', prev: totalPrev, curr: totalCurr }];
  const maxVal = Math.max(1, ...analysisChartRows.map((r) => Math.max(r.prev, r.curr)));

  // Grid lines
  for (let step = 0; step <= 4; step += 1) {
    const yLine = chartY + (chartH / 4) * step;
    doc.moveTo(chartX, yLine).lineTo(chartX + chartW, yLine).strokeColor('#f1f5f9').lineWidth(0.8).stroke();
    const tickVal = Math.round(maxVal * (1 - step / 4));
    doc.fontSize(7).fillColor(TEXT_MUTED).text(String(tickVal), chartX - 25, yLine - 4, { width: 20, align: 'right' });
  }

  const catWidth = chartW / analysisChartRows.length;
  const barW = 20;

  analysisChartRows.forEach((r, idx) => {
    const groupX = chartX + idx * catWidth + (catWidth - (barW * 2 + 4)) / 2;
    const h1 = (r.prev / maxVal) * chartH;
    const h2 = (r.curr / maxVal) * chartH;

    // Prev bar
    doc.rect(groupX, chartY + chartH - h1, barW, h1).fill(SECONDARY_COLOR);
    // Curr bar
    doc.rect(groupX + barW + 4, chartY + chartH - h2, barW, h2).fill(PRIMARY_COLOR);

    // Labels
    doc.fontSize(7.5).fillColor(TEXT_DARK).font('Helvetica')
      .text(r.category, chartX + idx * catWidth + 2, chartY + chartH + 6, { width: catWidth - 4, align: 'center' });
  });

  // Table below Chart 1
  const tableHeaders = [
    { text: 'Service Category', align: 'left' },
    { text: `${analysisPreviousLabel} Count`, align: 'right' },
    { text: `${analysisCurrentLabel} Count`, align: 'right' },
    { text: 'Absolute Change', align: 'right' },
    { text: 'YoY Change %', align: 'right' },
  ];
  const tableRows = analysisRows.map((r) => [
    { text: r.category, bold: true },
    { text: formatNumber(r.prev) },
    { text: formatNumber(r.curr) },
    { text: `${r.diff > 0 ? '+' : ''}${formatNumber(r.diff)}`, color: r.diff >= 0 ? '#16a34a' : ACCENT_COLOR },
    { text: formatPercent(r.pct), color: r.pct >= 0 ? '#16a34a' : ACCENT_COLOR },
  ]);
  tableRows.push([
    { text: 'Total services', bold: true },
    { text: formatNumber(totalPrev), bold: true },
    { text: formatNumber(totalCurr), bold: true },
    { text: `${totalDiff > 0 ? '+' : ''}${formatNumber(totalDiff)}`, bold: true, color: totalDiff >= 0 ? '#16a34a' : ACCENT_COLOR },
    { text: formatPercent(totalPct), bold: true, color: totalPct >= 0 ? '#16a34a' : ACCENT_COLOR },
  ]);

  drawSimpleTable(doc, {
    startX: 40,
    startY: 400,
    colWidths: [155, 90, 90, 90, 90],
    headers: tableHeaders,
    rows: tableRows,
  });

  // =========================================================================
  // PAGE 2: CHART 2 - LOAD TREND
  // =========================================================================
  doc.addPage();
  drawReportHeader(doc, {
    title: 'Workshop Service Analytics Report',
    subtitle: 'Section 2: Load Trend — Monthly Service Volume Over Time',
    meta: metaText,
  });

  // Take the last 12 months for trend
  const serviceCount = (entry) => (serviceType === 'All' ? entry.total : entry.categories[serviceType] || 0);
  const trendMonths = (serviceData.months || []).slice(-12).map((month) => ({
    ...month,
    total: serviceCount(month),
  }));

  doc.fontSize(11).fillColor(TEXT_DARK).font('Helvetica-Bold')
    .text('Chart 2: Monthly Load Trend (12 Months)', 40, 135);

  const tChartX = 40;
  const tChartY = 160;
  const tChartW = 515;
  const tChartH = 160;
  const maxTrend = Math.max(1, ...trendMonths.map((m) => m.total));

  // Grid
  for (let s = 0; s <= 4; s += 1) {
    const yL = tChartY + (tChartH / 4) * s;
    doc.moveTo(tChartX, yL).lineTo(tChartX + tChartW, yL).strokeColor('#f1f5f9').lineWidth(0.8).stroke();
    const v = Math.round(maxTrend * (1 - s / 4));
    doc.fontSize(7).fillColor(TEXT_MUTED).text(String(v), tChartX - 25, yL - 4, { width: 20, align: 'right' });
  }

  // Draw trend line
  if (trendMonths.length > 1) {
    const stepX = tChartW / (trendMonths.length - 1);
    const points = trendMonths.map((m, idx) => ({
      x: tChartX + idx * stepX,
      y: tChartY + tChartH - (m.total / maxTrend) * tChartH,
      val: m.total,
      month: m.month,
    }));

    doc.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      doc.lineTo(points[i].x, points[i].y);
    }
    doc.strokeColor(PRIMARY_COLOR).lineWidth(2.5).stroke();

    // Dots and month labels
    points.forEach((p) => {
      doc.circle(p.x, p.y, 3.5).fill(PRIMARY_COLOR);
      const mLabel = new Date(`${p.month}-01`).toLocaleDateString('en-US', { month: 'short' });
      doc.fontSize(7).fillColor(TEXT_MUTED).text(mLabel, p.x - 15, tChartY + tChartH + 6, { width: 30, align: 'center' });
      doc.fontSize(7.5).fillColor(TEXT_DARK).font('Helvetica-Bold').text(String(p.val), p.x - 15, p.y - 12, { width: 30, align: 'center' });
    });
  }

  // MoM Growth Table
  const trendTableHeaders = [
    { text: 'Month', align: 'left' },
    { text: 'Total Volume', align: 'right' },
    { text: 'Free Service', align: 'right' },
    { text: 'Paid Service', align: 'right' },
    { text: 'Accidental', align: 'right' },
    { text: 'Running Rep.', align: 'right' },
    { text: 'MoM Change %', align: 'right' },
  ];
  const trendTableRows = trendMonths.map((m, idx) => {
    const prevM = idx === 0 ? null : trendMonths[idx - 1];
    const diff = prevM ? m.total - prevM.total : null;
    const pct = prevM && prevM.total > 0 ? (diff / prevM.total) * 100 : null;
    const monthFormatted = new Date(`${m.month}-01`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return [
      { text: monthFormatted, bold: true },
      { text: formatNumber(m.total), bold: true },
      { text: formatNumber(m.categories['Free Service'] || 0) },
      { text: formatNumber(m.categories['Paid Service'] || 0) },
      { text: formatNumber(m.categories['Accidental Repair'] || 0) },
      { text: formatNumber(m.categories['Running Repair'] || 0) },
      { text: formatPercent(pct), color: pct >= 0 ? '#16a34a' : ACCENT_COLOR },
    ];
  });

  drawSimpleTable(doc, {
    startX: 40,
    startY: 360,
    colWidths: [95, 70, 70, 70, 70, 70, 70],
    headers: trendTableHeaders,
    rows: trendTableRows,
  });

  // =========================================================================
  // PAGE 3: CHART 3 - MTD LOAD
  // =========================================================================
  doc.addPage();
  drawReportHeader(doc, {
    title: 'Workshop Service Analytics Report',
    subtitle: 'Section 3: MTD Load — Cumulative Daily Trajectory vs Previous Year',
    meta: metaText,
  });

  // Match the UI default: previous completed month versus the same month in the comparison year.
  const mtdYear = safeMtdYear;
  const mtdMonthNum = safeMtdMonth;
  const mtdMonthKey = `${mtdYear}-${String(mtdMonthNum).padStart(2, '0')}`;
  const prevYearSameMonthKey = `${mtdComparisonYear}-${String(mtdMonthNum).padStart(2, '0')}`;
  const daysInMonth = new Date(mtdYear, mtdMonthNum, 0).getDate();
  const comparisonDays = new Date(mtdComparisonYear, mtdMonthNum, 0).getDate();
  const cutoffDay = Math.min(daysInMonth, comparisonDays,
    mtdYear === currentYear && mtdMonthNum === currentMonthNum ? now.getDate() : daysInMonth);

  const dailyCurrMap = new Map();
  const dailyPrevMap = new Map();
  (serviceData.daily || []).forEach((d) => {
    const [y, m, dayNum] = d.date.split('-').map(Number);
    if (y === mtdYear && m === mtdMonthNum) dailyCurrMap.set(dayNum, serviceCount(d));
    if (y === mtdComparisonYear && m === mtdMonthNum) dailyPrevMap.set(dayNum, serviceCount(d));
  });

  let cumCurr = 0;
  let cumPrev = 0;
  const mtdDays = [];
  for (let d = 1; d <= cutoffDay; d += 1) {
    cumCurr += dailyCurrMap.get(d) || 0;
    cumPrev += dailyPrevMap.get(d) || 0;
    mtdDays.push({
      day: d,
      curr: cumCurr,
      prev: cumPrev,
    });
  }

  const mtdCurrTotal = cumCurr;
  // Compare equivalent days for fair YoY
  const mtdPrevEquiv = mtdDays[cutoffDay - 1]?.prev || 0;
  const mtdDiff = mtdCurrTotal - mtdPrevEquiv;
  const mtdPct = mtdPrevEquiv === 0 ? null : (mtdDiff / mtdPrevEquiv) * 100;

  drawKpiBox(doc, {
    x: 40, y: 130, width: 165, height: 58,
    label: `${new Date(`${prevYearSameMonthKey}-01`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} MTD (Day ${cutoffDay})`,
    value: formatNumber(mtdPrevEquiv), subtext: 'Previous Year Equivalent', color: SECONDARY_COLOR,
  });
  drawKpiBox(doc, {
    x: 215, y: 130, width: 165, height: 58,
    label: `${new Date(`${mtdMonthKey}-01`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} MTD (Day ${cutoffDay})`,
    value: formatNumber(mtdCurrTotal), subtext: 'Current Month Cumulative', color: PRIMARY_COLOR,
  });
  drawKpiBox(doc, {
    x: 390, y: 130, width: 165, height: 58,
    label: 'MTD Difference',
    value: `${mtdDiff >= 0 ? '+' : ''}${formatNumber(mtdDiff)}`, subtext: formatPercent(mtdPct), color: mtdDiff >= 0 ? '#16a34a' : ACCENT_COLOR,
  });

  // MTD Chart
  doc.fontSize(11).fillColor(TEXT_DARK).font('Helvetica-Bold')
    .text(`Chart 3: Cumulative Daily MTD Trajectory (Through Day ${cutoffDay})`, 40, 202);

  doc.rect(370, 204, 10, 8).fill(SECONDARY_COLOR);
  doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica').text(String(mtdComparisonYear), 385, 204);
  doc.rect(450, 204, 10, 8).fill(PRIMARY_COLOR);
  doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica').text(String(mtdYear), 465, 204);

  const mChartX = 40;
  const mChartY = 220;
  const mChartW = 515;
  const mChartH = 150;
  const maxMtd = Math.max(1, mtdCurrTotal, mtdDays[cutoffDay - 1]?.prev || 0);

  // Grid
  for (let s = 0; s <= 4; s += 1) {
    const yL = mChartY + (mChartH / 4) * s;
    doc.moveTo(mChartX, yL).lineTo(mChartX + mChartW, yL).strokeColor('#f1f5f9').lineWidth(0.8).stroke();
    const v = Math.round(maxMtd * (1 - s / 4));
    doc.fontSize(7).fillColor(TEXT_MUTED).text(String(v), mChartX - 25, yL - 4, { width: 20, align: 'right' });
  }

  const mStepX = cutoffDay > 1 ? mChartW / (cutoffDay - 1) : 0;

  // Prev year curve
  doc.moveTo(mChartX, mChartY + mChartH - (mtdDays[0].prev / maxMtd) * mChartH);
  for (let i = 1; i < mtdDays.length; i += 1) {
    doc.lineTo(mChartX + i * mStepX, mChartY + mChartH - (mtdDays[i].prev / maxMtd) * mChartH);
  }
  doc.strokeColor(SECONDARY_COLOR).lineWidth(1.8).stroke();

  // Selected completed month curve
  doc.moveTo(mChartX, mChartY + mChartH - (mtdDays[0].curr / maxMtd) * mChartH);
  for (let i = 1; i < cutoffDay; i += 1) {
    doc.lineTo(mChartX + i * mStepX, mChartY + mChartH - (mtdDays[i].curr / maxMtd) * mChartH);
  }
  doc.strokeColor(PRIMARY_COLOR).lineWidth(2.5).stroke();

  // Day markers on X axis (every 5 days)
  for (let d = 1; d <= cutoffDay; d += 5) {
    const xPos = mChartX + (d - 1) * mStepX;
    doc.fontSize(7).fillColor(TEXT_MUTED).text(`D${d}`, xPos - 8, mChartY + mChartH + 6, { width: 16, align: 'center' });
  }

  // MTD Table
  const mtdTableHeaders = [
    { text: 'Day of Month', align: 'left' },
    { text: `${mtdComparisonYear} Cumulative`, align: 'right' },
    { text: `${mtdYear} Cumulative`, align: 'right' },
    { text: 'Variance', align: 'right' },
    { text: 'Status', align: 'center' },
  ];
  // Sample key checkpoint days for readability (e.g. Day 5, 10, 15, 20, 25, cutoffDay)
  const sampleDays = [5, 10, 15, 20, 25, cutoffDay].filter((d, i, arr) => d <= cutoffDay && arr.indexOf(d) === i).sort((a, b) => a - b);
  const mtdTableRows = sampleDays.map((d) => {
    const item = mtdDays[d - 1];
    const prevVal = item?.prev || 0;
    const currVal = item?.curr != null ? item.curr : null;
    const varVal = currVal != null ? currVal - prevVal : null;
    return [
      { text: `Day ${d}${d === cutoffDay ? ' (Current)' : ''}`, bold: d === cutoffDay },
      { text: formatNumber(prevVal) },
      { text: currVal != null ? formatNumber(currVal) : '—' },
      { text: varVal != null ? `${varVal >= 0 ? '+' : ''}${formatNumber(varVal)}` : '—', color: varVal == null ? TEXT_DARK : varVal >= 0 ? '#16a34a' : ACCENT_COLOR },
      { text: currVal != null ? (currVal >= prevVal ? 'Ahead' : 'Behind') : 'Projected', bold: true, color: currVal == null ? TEXT_MUTED : currVal >= prevVal ? '#16a34a' : ACCENT_COLOR },
    ];
  });

  drawSimpleTable(doc, {
    startX: 40,
    startY: 400,
    colWidths: [135, 95, 95, 95, 95],
    headers: mtdTableHeaders,
    rows: mtdTableRows,
  });

  applyPageNumbers(doc, 'Workshop Performance');
  doc.end();
}

// -----------------------------------------------------------------------------------
// 2. CRM REPORTS PDF (ADMIN & GM ONLY)
// -----------------------------------------------------------------------------------
export async function exportReportsPdf(req, res) {
  const role = String(req.user?.role || '').toUpperCase();
  if (!['ADMIN', 'GM'].includes(role)) {
    return res.status(403).json({ message: 'Only Admin and GM are authorized to export Reports.' });
  }

  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || (now.getMonth() + 1);
  const tzOffset = Number(req.query.tzOffset || 0);
  const ccmId = req.query.ccmId ? String(req.query.ccmId) : '';
  const creId = req.query.creId ? String(req.query.creId) : '';

  const reportData = await queryWorkshopReportsData({ year, month, tzOffset, ccmId, creId });
  if (!reportData || reportData.error) {
    return res.status(404).json({ message: reportData?.error || 'Report data not found.' });
  }

  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  const filename = `Reports_${now.toISOString().slice(0, 10)}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const scopeText = `Scope: ${reportData.scope?.name || 'All Teams'} | Reporting Period: ${monthName}`;

  // =========================================================================
  // PAGE 1: KPI SUMMARY & DAILY ACTIVITY CHART
  // =========================================================================
  drawReportHeader(doc, {
    title: 'CRM Performance & Productivity Report',
    subtitle: `Monthly Workshop CRM Activity — ${monthName}`,
    meta: scopeText,
  });

  // Top 6 KPI Cards in 2 rows
  const totals = reportData.totals || {};
  drawKpiBox(doc, {
    x: 40, y: 130, width: 165, height: 55,
    label: 'Calls Made', value: formatNumber(totals.calls), subtext: 'Total logged this month', color: PRIMARY_COLOR,
  });
  drawKpiBox(doc, {
    x: 215, y: 130, width: 165, height: 55,
    label: 'Customers Reached', value: formatNumber(totals.customersReached), subtext: 'Unique customers spoken to', color: '#0284c7',
  });
  drawKpiBox(doc, {
    x: 390, y: 130, width: 165, height: 55,
    label: 'Appointments Booked', value: formatNumber(totals.appointmentsBooked), subtext: `${totals.conversionPercent ?? 0}% conversion rate`, color: '#16a34a',
  });

  drawKpiBox(doc, {
    x: 40, y: 195, width: 165, height: 55,
    label: 'Assigned Workload', value: formatNumber(totals.assignedRecords), subtext: 'Active assigned customers', color: '#d97706',
  });
  drawKpiBox(doc, {
    x: 215, y: 195, width: 165, height: 55,
    label: 'Reach of Assigned', value: `${totals.reachPercent ?? 0}%`, subtext: 'Customers reached / assigned', color: '#9333ea',
  });
  drawKpiBox(doc, {
    x: 390, y: 195, width: 165, height: 55,
    label: 'Call-to-Appointment', value: `${totals.conversionPercent ?? 0}%`, subtext: 'Appointments / calls made', color: '#0d9488',
  });

  // Daily Activity Chart
  doc.fontSize(11).fillColor(TEXT_DARK).font('Helvetica-Bold')
    .text('Daily Call and Appointment Activity', 40, 265);

  doc.rect(380, 267, 10, 8).fill(PRIMARY_COLOR);
  doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica').text('Calls', 395, 267);
  doc.rect(450, 267, 10, 8).fill(ACCENT_COLOR);
  doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica').text('Appointments', 465, 267);

  const dailyList = reportData.daily || [];
  const dChartX = 40;
  const dChartY = 285;
  const dChartW = 515;
  const dChartH = 140;
  const maxDaily = Math.max(1, ...dailyList.map((d) => Math.max(d.calls, d.appointments)));

  // Grid
  for (let s = 0; s <= 4; s += 1) {
    const yL = dChartY + (dChartH / 4) * s;
    doc.moveTo(dChartX, yL).lineTo(dChartX + dChartW, yL).strokeColor('#f1f5f9').lineWidth(0.8).stroke();
    const v = Math.round(maxDaily * (1 - s / 4));
    doc.fontSize(7).fillColor(TEXT_MUTED).text(String(v), dChartX - 22, yL - 4, { width: 18, align: 'right' });
  }

  // Draw day bars
  const dayColW = dChartW / dailyList.length;
  dailyList.forEach((d, i) => {
    const xPos = dChartX + i * dayColW + 2;
    const barWidth = Math.max(2, (dayColW - 6) / 2);
    const hCalls = (d.calls / maxDaily) * dChartH;
    const hAppts = (d.appointments / maxDaily) * dChartH;

    doc.rect(xPos, dChartY + dChartH - hCalls, barWidth, hCalls).fill(PRIMARY_COLOR);
    doc.rect(xPos + barWidth + 1, dChartY + dChartH - hAppts, barWidth, hAppts).fill(ACCENT_COLOR);

    if (i % 3 === 0 || i === dailyList.length - 1) {
      const dayNum = Number(d.date.slice(8));
      doc.fontSize(7).fillColor(TEXT_MUTED).text(String(dayNum), xPos - 3, dChartY + dChartH + 5, { width: 16, align: 'center' });
    }
  });

  // Call Outcomes Section on Page 1
  doc.fontSize(11).fillColor(TEXT_DARK).font('Helvetica-Bold')
    .text('Call Outcomes Breakdown', 40, 445);

  const outcomesList = reportData.outcomes || [];
  const maxOutcome = Math.max(1, ...outcomesList.map((o) => o.count));
  const outStartY = 465;

  outcomesList.slice(0, 6).forEach((o, idx) => {
    const rowY = outStartY + idx * 24;
    const barWidthMax = 280;
    const barFillW = (o.count / maxOutcome) * barWidthMax;
    const outcomeLabel = o.outcome.replaceAll('_', ' ');

    doc.fontSize(8.5).fillColor(TEXT_DARK).font('Helvetica')
      .text(outcomeLabel, 40, rowY + 3, { width: 120 });
    doc.rect(165, rowY + 2, barWidthMax, 12).fill('#f1f5f9');
    doc.rect(165, rowY + 2, barFillW, 12).fill(PRIMARY_COLOR);
    doc.fontSize(8.5).fillColor(TEXT_DARK).font('Helvetica-Bold')
      .text(formatNumber(o.count), 455, rowY + 3, { width: 50, align: 'right' });
  });

  // =========================================================================
  // PAGE 2: DETAILED TEAM & CRE BREAKDOWN TABLE
  // =========================================================================
  if (reportData.breakdown && reportData.breakdown.length > 0) {
    doc.addPage();
    drawReportHeader(doc, {
      title: 'CRM Performance & Productivity Report',
      subtitle: `Detailed Team and CRE Productivity Breakdown — ${monthName}`,
      meta: scopeText,
    });

    const bHeaders = [
      { text: 'Name', align: 'left' },
      { text: 'Role', align: 'left' },
      { text: 'Calls Made', align: 'right' },
      { text: 'Customers Reached', align: 'right' },
      { text: 'Appts Booked', align: 'right' },
      { text: 'Assigned', align: 'right' },
      { text: 'Reach %', align: 'right' },
    ];

    const bRows = reportData.breakdown.map((item) => [
      { text: item.name, bold: true },
      { text: item.kind || 'CRE' },
      { text: formatNumber(item.calls) },
      { text: formatNumber(item.customersReached) },
      { text: formatNumber(item.appointmentsBooked) },
      { text: formatNumber(item.assignedRecords) },
      { text: `${item.reachPercent ?? 0}%`, bold: true, color: PRIMARY_COLOR },
    ]);

    drawSimpleTable(doc, {
      startX: 40,
      startY: 140,
      colWidths: [135, 60, 65, 85, 65, 55, 50],
      headers: bHeaders,
      rows: bRows,
    });
  }

  applyPageNumbers(doc, 'CRM Reports');
  doc.end();
}
