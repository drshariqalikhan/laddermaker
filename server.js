const http = require('http');
const url = require('url');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3000;
const BASE_MAS_URL = 'https://eservices.mas.gov.sg/statistics/api/v1/bondsandbills/m';
const SECONDARY_MARKET_URL = 'https://eservices.mas.gov.sg/statistics/fdanet/BondPricesAndYields.aspx';
const YIELD_CURVE_URL = 'https://eservices.mas.gov.sg/statistics/fdanet/SgsBenchmarkIssuePrices.aspx';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Helper: Parse dates in "YYYY-MM-DD" or "DD MMM YYYY"
function parseFlexibleDate(str) {
  if (!str || str === '-' || str === 'N/A') return null;
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d;

  const parts = str.trim().split(/[\s\-]+/);
  if (parts.length === 3) {
    const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    const day = parseInt(parts[0], 10);
    const mStr = parts[1].slice(0, 3).toLowerCase();
    const year = parseInt(parts[2], 10);
    if (!isNaN(day) && months[mStr] !== undefined && !isNaN(year)) {
      return new Date(year, months[mStr], day);
    }
  }
  return null;
}

// Helper: Format Date to "DD MMM YYYY"
function formatDateStr(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '-';
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${day} ${MONTH_NAMES[dateObj.getMonth()]} ${dateObj.getFullYear()}`;
}

// Helper: Calculate Coupon Payment Schedule
function getCouponPaymentInfo(secType, matDateObj, interestDate1, interestDate2) {
  if (secType.includes('T-Bill')) {
    const matStr = matDateObj ? formatDateStr(matDateObj) : 'Maturity';
    return {
      summary: `At maturity (${matStr})`,
      detail: 'Paid at maturity with face value (Zero-coupon)',
      isTbill: true
    };
  }

  let day1, month1, day2, month2;

  if (interestDate1 && interestDate1.includes('/')) {
    const p1 = interestDate1.split('/');
    day1 = parseInt(p1[0], 10);
    month1 = parseInt(p1[1], 10) - 1;
  }
  if (interestDate2 && interestDate2.includes('/')) {
    const p2 = interestDate2.split('/');
    day2 = parseInt(p2[0], 10);
    month2 = parseInt(p2[1], 10) - 1;
  }

  if ((day1 === undefined || isNaN(day1)) && matDateObj) {
    day1 = matDateObj.getDate();
    month1 = (matDateObj.getMonth() + 6) % 12;
    day2 = matDateObj.getDate();
    month2 = matDateObj.getMonth();

    if (month1 > month2) {
      const temp = month1; month1 = month2; month2 = temp;
    }
  }

  if (day1 !== undefined && month1 !== undefined && day2 !== undefined && month2 !== undefined) {
    const d1 = `${String(day1).padStart(2, '0')} ${MONTH_NAMES[month1]}`;
    const d2 = `${String(day2).padStart(2, '0')} ${MONTH_NAMES[month2]}`;
    return {
      summary: `Every 6M (${d1} & ${d2})`,
      detail: `Paid semi-annually on ${d1} and ${d2} until maturity`,
      isTbill: false
    };
  }

  return {
    summary: 'Every 6 months',
    detail: 'Paid semi-annually from issue until maturity',
    isTbill: false
  };
}

// Helper: Linear Interpolation for Yield Curve
function calculateIndicativeYield(durationYears, curve) {
  if (!curve || durationYears <= 0) return null;

  const points = [
    { years: 0.5, y: curve['6M'] },
    { years: 1.0, y: curve['1Y'] },
    { years: 2.0, y: curve['2Y'] },
    { years: 5.0, y: curve['5Y'] },
    { years: 10.0, y: curve['10Y'] },
    { years: 15.0, y: curve['15Y'] },
    { years: 20.0, y: curve['20Y'] },
    { years: 30.0, y: curve['30Y'] },
    { years: 50.0, y: curve['50Y'] }
  ].filter(p => typeof p.y === 'number' && !isNaN(p.y) && p.y > 0);

  if (!points.length) return null;

  if (durationYears <= points[0].years) return points[0].y;
  if (durationYears >= points[points.length - 1].years) return points[points.length - 1].y;

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    if (durationYears >= p1.years && durationYears <= p2.years) {
      const slope = (p2.y - p1.y) / (p2.years - p1.years);
      const interpolated = p1.y + slope * (durationYears - p1.years);
      return parseFloat(interpolated.toFixed(2));
    }
  }

  return null;
}

// 1. Scrape SGS Yield Curve from MAS
async function getSGSYieldCurve() {
  try {
    const { data: html } = await axios.get(YIELD_CURVE_URL, {
      headers: { 'User-Agent': BROWSER_UA },
      timeout: 8000
    });

    const $ = cheerio.load(html);
    let latestCurve = null;

    $('tr').each((_, row) => {
      const rowText = $(row).text();
      if (rowText.includes('High / Low') || rowText.includes('High/Low')) return false;

      const cols = $(row).find('td').map((_, td) => $(td).text().trim().replace(/\s+/g, ' ')).get();
      const dateIndex = cols.findIndex(c => /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/.test(c));
      if (dateIndex === -1) return;

      const dateStr = cols[dateIndex];
      const allNums = cols.slice(dateIndex + 1).map(c => parseFloat(c)).filter(n => !isNaN(n));
      const yields = allNums.filter(n => n > 0 && n < 20);

      if (yields.length >= 9) {
        latestCurve = {
          date: dateStr,
          '6M': yields[0], '1Y': yields[1], '2Y': yields[2],
          '5Y': yields[3], '10Y': yields[4], '15Y': yields[5],
          '20Y': yields[6], '30Y': yields[7], '50Y': yields[8]
        };
      }
    });

    return latestCurve;
  } catch (err) {
    console.warn('[Yield Curve] Fetch warning:', err.message);
    return null;
  }
}

// 2. Scrape Secondary Market Bonds
async function scrapeMASSecondaryMarket() {
  try {
    const { data } = await axios.get(SECONDARY_MARKET_URL, {
      headers: { 'User-Agent': BROWSER_UA },
      timeout: 8000
    });

    const $ = cheerio.load(data);
    const bonds = [];

    $('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 9) {
        const row = [];
        tds.each((_, td) => row.push($(td).text().replace(/\s+/g, ' ').trim()));
        const issueCode = row[2];
        if (!issueCode || issueCode.length < 4) return;

        bonds.push({
          _category: 'Secondary SGS',
          benchmark: row[0] || '-',
          issueCode: row[2],
          isin: row[3],
          couponRate: row[4],
          interestDate1: row[5],
          interestDate2: row[6],
          maturityDate: row[7],
          issueSizeMillion: row[8],
          bidPrice: row[9] || row[1] || '-',
          yieldPct: row[10] || '-'
        });
      }
    });

    return bonds;
  } catch (err) {
    console.warn('[Secondary Market] Fetch warning:', err.message);
    return [];
  }
}

// 3. Fetch Primary MAS API
async function fetchMasApi(endpoint, filters, sort = 'ann_date asc') {
  try {
    const res = await axios.get(`${BASE_MAS_URL}${endpoint}`, {
      params: {
        rows: 200,
        filters: filters,
        sort: sort
      },
      headers: { 'User-Agent': BROWSER_UA },
      timeout: 8000
    });
    return res.data?.result?.records || [];
  } catch (err) {
    console.warn(`[MAS API ${endpoint}] Fetch warning:`, err.message);
    return [];
  }
}

// 4. Build Master Table Data
async function getMasterTableData() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const currentYear = today.getFullYear();
  const nextYear = currentYear + 1;
  const startDate = `${currentYear}-01-01`;
  const endDate = `${nextYear}-12-31`;

  const sgsFilters = `issue_type:("B" OR "I" OR "G") AND ann_date:[${startDate} TO ${endDate}]`;
  const tbillFilters = `issue_type:"T" AND ann_date:[${startDate} TO ${endDate}]`;

  const [sgsRecords, tbillRecords, secondaryBonds, yieldCurve] = await Promise.all([
    fetchMasApi('/issuancecalendar', sgsFilters),
    fetchMasApi('/issuancecalendar', tbillFilters),
    scrapeMASSecondaryMarket(),
    getSGSYieldCurve()
  ]);

  const masterList = [];

  // Primary SGS & T-Bills (Auction Date >= Today)
  const primaryAll = [
    ...sgsRecords.map(r => ({ ...r, _secType: 'Primary SGS' })),
    ...tbillRecords.map(r => ({ ...r, _secType: 'Primary T-Bill' }))
  ];

  primaryAll.forEach(r => {
    const auctionDateObj = parseFlexibleDate(r.auction_date);
    if (!auctionDateObj || auctionDateObj < today) return;

    let matDateObj = parseFlexibleDate(r.maturity_date);
    const issueDateObj = parseFlexibleDate(r.issue_date);

    if (!matDateObj && issueDateObj && r.auction_tenor) {
      const tenorYears = parseFloat(r.auction_tenor) || 0.5;
      matDateObj = new Date(issueDateObj.getTime() + tenorYears * 365.25 * 86400000);
    }

    const durationYears = matDateObj ? Math.max(0.1, (matDateObj - today) / (365.25 * 86400000)) : (parseFloat(r.auction_tenor) || 0.5);
    const indicativeYield = calculateIndicativeYield(durationYears, yieldCurve);
    const couponInfo = getCouponPaymentInfo(r._secType, matDateObj, null, null);

    masterList.push({
      secType: r._secType,
      issueCode: r.issue_code || r.issue_name || '-',
      isin: r.isin_code || '-',
      maturityDate: matDateObj ? formatDateStr(matDateObj) : (r.maturity_date || '-'),
      maturityTimestamp: matDateObj ? matDateObj.getTime() : 0,
      auctionDate: formatDateStr(auctionDateObj),
      auctionTimestamp: auctionDateObj.getTime(),
      issueDate: issueDateObj ? formatDateStr(issueDateObj) : (r.issue_date || '-'),
      couponSchedule: couponInfo.summary,
      couponDetail: couponInfo.detail,
      isTbill: couponInfo.isTbill,
      durationYears: parseFloat(durationYears.toFixed(2)),
      indicativeYield: indicativeYield !== null ? indicativeYield : null
    });
  });

  // Secondary Market Bonds (Maturity Date > Today)
  secondaryBonds.forEach(b => {
    const matDateObj = parseFlexibleDate(b.maturityDate);
    if (!matDateObj || matDateObj <= today) return;

    const durationYears = Math.max(0.1, (matDateObj - today) / (365.25 * 86400000));
    const indicativeYield = calculateIndicativeYield(durationYears, yieldCurve);
    const couponInfo = getCouponPaymentInfo('Secondary SGS', matDateObj, b.interestDate1, b.interestDate2);

    masterList.push({
      secType: 'Secondary SGS',
      issueCode: b.issueCode,
      isin: b.isin || '-',
      maturityDate: formatDateStr(matDateObj),
      maturityTimestamp: matDateObj.getTime(),
      auctionDate: '-',
      auctionTimestamp: 0,
      issueDate: b.interestDate1 ? `Int: ${b.interestDate1}, ${b.interestDate2}` : '-',
      couponSchedule: couponInfo.summary,
      couponDetail: couponInfo.detail,
      isTbill: couponInfo.isTbill,
      durationYears: parseFloat(durationYears.toFixed(2)),
      indicativeYield: indicativeYield !== null ? indicativeYield : (parseFloat(b.yieldPct) || null)
    });
  });

  masterList.sort((a, b) => (a.maturityTimestamp || 0) - (b.maturityTimestamp || 0));

  return {
    curveDate: yieldCurve?.date || 'Latest',
    count: masterList.length,
    records: masterList
  };
}

// 5. Frontend HTML Application
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#12161a">
  <title>LadderMaker - Singapore Government Bond Ladder & Cashflows</title>
  
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/bulma.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <script src="https://cdn.jsdelivr.net/npm/axios/dist/axios.min.js"></script>
  <link rel="manifest" id="manifest-placeholder">

  <style>
    body { min-height: 100vh; display: flex; flex-direction: column; background: #0d1117; color: #e6edf3; }
    .main-container { flex: 1; }
    .table-container { border: 1px solid #30363d; border-radius: 8px; overflow-x: auto; background-color: #161b22; }
    .table thead th { cursor: pointer; background-color: #21262d !important; color: #58a6ff !important; border-bottom: 2px solid #30363d; white-space: nowrap; }
    .table thead th:hover { background-color: #30363d !important; }
    .table tbody tr:hover { background-color: rgba(255, 255, 255, 0.04) !important; }
    .summary-card { background-color: #161b22; border: 1px solid #30363d; border-radius: 8px; }
    .monospace { font-family: monospace; }
    .tabs.is-boxed li.is-active a { background-color: #21262d; border-color: #30363d #30363d transparent; color: #58a6ff; font-weight: bold; }
    .tabs.is-boxed a { border-color: transparent; }
    .chart-container { background-color: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.5rem; }
    .ladder-card { background-color: #161b22; border: 1px solid #30363d; border-radius: 8px; }
    .rung-step { width: 34px; height: 34px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: bold; }
  </style>
</head>
<body>

  <nav class="navbar is-dark" style="border-bottom: 1px solid #30363d;">
    <div class="container">
      <div class="navbar-brand">
        <span class="navbar-item has-text-weight-bold is-size-5">
          <i class="fa-solid fa-stairs mr-2 has-text-info"></i> LadderMaker
        </span>
      </div>
      <div class="navbar-end">
        <div class="navbar-item">
          <button id="btn-refresh" class="button is-small is-info is-outlined">
            <span class="icon"><i class="fa-solid fa-arrows-rotate"></i></span>
            <span>Refresh</span>
          </button>
        </div>
      </div>
    </div>
  </nav>

  <main class="section main-container">
    <div class="container">

      <!-- Header Level -->
      <div class="level mb-4">
        <div class="level-left">
          <div>
            <h1 class="title is-4 has-text-light" id="page-title">Singapore Government Securities</h1>
            <p class="subtitle is-6 has-text-grey" id="page-subtitle">Build customized annual spending ladders, track cashflow timelines, and optimize yields</p>
          </div>
        </div>
        <div class="level-right">
          <button id="btn-export" class="button is-small is-dark is-outlined">
            <span class="icon"><i class="fa-solid fa-download"></i></span>
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      <!-- Quick Metrics Panel -->
      <div class="columns is-multiline mb-4" id="metrics-panel">
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-1">Total Available</p>
            <p class="title is-4 has-text-light" id="stat-val-1">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-2">Primary Auctions</p>
            <p class="title is-4 has-text-primary" id="stat-val-2">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-3">Secondary Bonds</p>
            <p class="title is-4 has-text-warning" id="stat-val-3">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-4">Curve Source Date</p>
            <p class="title is-4 has-text-success monospace" id="stat-val-4">-</p>
          </div>
        </div>
      </div>

      <!-- Navigation Tabs & Year Selector -->
      <div class="level mb-3">
        <div class="level-left">
          <div class="tabs is-boxed is-small mb-0" id="category-tabs">
            <ul>
              <li class="is-active" data-type="ladder"><a><i class="fa-solid fa-stairs mr-2 has-text-success"></i> Bond Ladder</a></li>
              <li data-type="master"><a><i class="fa-solid fa-layer-group mr-2 has-text-warning"></i> Master Table</a></li>
              <li data-type="all"><a><i class="fa-solid fa-list mr-2"></i> All Primary</a></li>
              <li data-type="sgs"><a><i class="fa-solid fa-building-columns mr-2"></i> Primary SGS</a></li>
              <li data-type="tbill"><a><i class="fa-solid fa-money-bill-trend-up mr-2"></i> Primary T-Bills</a></li>
              <li data-type="ssb"><a><i class="fa-solid fa-piggy-bank mr-2"></i> SSB</a></li>
              <li data-type="secondary"><a><i class="fa-solid fa-chart-line mr-2"></i> Secondary Market</a></li>
              <li data-type="curve"><a><i class="fa-solid fa-bezier-curve mr-2 has-text-danger"></i> Yield Curve</a></li>
            </ul>
          </div>
        </div>
        <div class="level-right" id="year-wrapper">
          <div class="field is-grouped">
            <div class="control">
              <div class="select is-small is-dark">
                <select id="year-select"></select>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Bond Ladder Configuration Controls -->
      <div id="ladder-controls-panel" class="box ladder-card mb-4 p-4">
        <div class="columns is-multiline is-vcentered">
          <!-- Start Payment Date -->
          <div class="column is-3">
            <label class="label is-small has-text-warning"><i class="fa-solid fa-calendar-star mr-1"></i> First Payment Date (Maturity #1)</label>
            <div class="control has-icons-left">
              <input class="input is-small is-dark monospace" type="date" id="ladder-start-date">
              <span class="icon is-small is-left has-text-grey"><i class="fa-regular fa-calendar"></i></span>
            </div>
            <p class="help has-text-grey-light" style="font-size: 0.7rem;">Target date for your 1st annual income lump sum</p>
          </div>

          <!-- Frequency -->
          <div class="column is-2">
            <label class="label is-small has-text-grey">Payment Frequency</label>
            <div class="control">
              <div class="select is-small is-fullwidth is-dark">
                <select id="ladder-freq">
                  <option value="1.0" selected>Every 1 Year (Annual)</option>
                  <option value="0.5">Every 6M (Semi-Annual)</option>
                  <option value="0.25">Every 3M (Quarterly)</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Horizon -->
          <div class="column is-2">
            <label class="label is-small has-text-grey">Income Horizon (Years)</label>
            <div class="control">
              <div class="select is-small is-fullwidth is-dark">
                <select id="ladder-horizon">
                  <option value="1">1 Year</option>
                  <option value="2">2 Years</option>
                  <option value="3">3 Years</option>
                  <option value="5" selected>5 Years</option>
                  <option value="10">10 Years</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Total Capital -->
          <div class="column is-2">
            <label class="label is-small has-text-grey">Total Capital (SGD)</label>
            <div class="control has-icons-left">
              <input class="input is-small is-dark monospace" type="number" id="ladder-capital" value="100000" step="5000" min="1000">
              <span class="icon is-small is-left has-text-grey">$</span>
            </div>
          </div>

          <!-- Strategy -->
          <div class="column is-3">
            <label class="label is-small has-text-grey">Optimization Mode</label>
            <div class="control">
              <div class="select is-small is-fullwidth is-dark">
                <select id="ladder-strategy">
                  <option value="max-yield" selected>Max Yield (Highest Ladder Return)</option>
                  <option value="closest">Closest to Exact Target Date</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Search Box (Hidden in Yield Curve & Ladder views) -->
      <div class="field mb-4" id="search-wrapper">
        <p class="control has-icons-left">
          <input id="search-input" class="input is-rounded is-dark" type="text" placeholder="Search by issue code, ISIN, maturity date, yield...">
          <span class="icon is-small is-left"><i class="fas fa-search"></i></span>
        </p>
      </div>

      <!-- Loading Spinner / Alert Container -->
      <div id="status-container" class="has-text-centered py-6">
        <span class="icon is-large has-text-info"><i class="fas fa-2x fa-spinner fa-spin"></i></span>
        <p class="mt-3 has-text-grey" id="status-text">Fetching data from MAS...</p>
      </div>

      <!-- Bond Ladder View: Timeline Toggle + Timeline + Table -->
      <div id="ladder-view" class="is-hidden">
        
        <!-- Toggle Bar for Cashflow Timeline -->
        <div class="level mb-3">
          <div class="level-left">
            <h3 class="subtitle is-6 has-text-weight-bold has-text-light mb-0">
              <i class="fa-solid fa-layer-group mr-2 has-text-success"></i> Scheduled Spending Ladder
            </h3>
          </div>
          <div class="level-right">
            <button id="btn-toggle-timeline" class="button is-small is-info is-outlined">
              <span class="icon"><i class="fa-solid fa-timeline"></i></span>
              <span id="btn-timeline-text">Show Cash Flow Timeline</span>
            </button>
          </div>
        </div>

        <!-- Horizontal Scrollable Cashflow Timeline -->
        <div id="ladder-timeline-card" class="box ladder-card mb-4 p-4 is-hidden">
          <div class="level mb-2">
            <div class="level-left">
              <h3 class="subtitle is-6 has-text-weight-bold has-text-info mb-0">
                <i class="fa-solid fa-timeline mr-2"></i> Cash Flow Timeline (Coupons & Maturity Lump Sums)
              </h3>
            </div>
            <div class="level-right">
              <span class="tag is-dark monospace is-size-7" id="timeline-count-badge">0 Scheduled Payments</span>
            </div>
          </div>
          <p class="is-size-7 has-text-grey mb-3">Scroll horizontally to view upcoming coupon payouts and principal maturity returns coming in over your horizon.</p>
          
          <div style="overflow-x: auto; padding: 15px 5px 10px 5px; -webkit-overflow-scrolling: touch;">
            <div style="position: relative; min-width: max-content; padding-bottom: 5px;">
              <!-- Horizontal Rail Line -->
              <div style="position: absolute; bottom: 31px; left: 0; right: 0; height: 3px; background: #30363d; z-index: 1;"></div>
              <!-- Timeline Nodes Container -->
              <div id="ladder-timeline-track" style="display: flex; align-items: flex-end; position: relative; z-index: 2;"></div>
            </div>
          </div>
        </div>

        <!-- Ladder Rung Table -->
        <div class="table-container mb-4">
          <table class="table is-fullwidth is-hoverable is-narrow">
            <thead>
              <tr>
                <th>RUNG</th>
                <th>TARGET PAYOUT DATE</th>
                <th>SELECTED SECURITY</th>
                <th>ACTUAL MATURITY</th>
                <th>COUPON PAYMENT SCHEDULE</th>
                <th>ALLOCATED CAPITAL</th>
                <th>INDICATIVE YIELD</th>
                <th>EST. ANNUAL CASHFLOW</th>
              </tr>
            </thead>
            <tbody id="ladder-table-body"></tbody>
          </table>
        </div>
      </div>

      <!-- Master & Standard Table Section -->
      <div id="table-wrapper" class="table-container is-hidden">
        <table class="table is-fullwidth is-hoverable is-narrow">
          <thead><tr id="table-head-row"></tr></thead>
          <tbody id="table-body"></tbody>
        </table>
      </div>

      <!-- Dedicated Yield Curve View -->
      <div id="curve-wrapper" class="is-hidden">
        <div class="box chart-container mb-4">
          <div class="level mb-2">
            <div class="level-left">
              <h3 class="subtitle is-6 has-text-weight-bold has-text-info mb-0">
                <i class="fa-solid fa-chart-area mr-2"></i> SGS Benchmark Yield Curve (% p.a.)
              </h3>
            </div>
            <div class="level-right">
              <span class="tag is-dark monospace" id="curve-date-badge">As of: -</span>
            </div>
          </div>
          <div style="width: 100%; max-width: 900px; margin: 0 auto;">
            <svg id="curve-svg" viewBox="0 0 800 280" style="width: 100%; height: auto; display: block;"></svg>
          </div>
        </div>

        <div class="table-container">
          <table class="table is-fullwidth is-hoverable is-narrow">
            <thead>
              <tr>
                <th>TENOR</th>
                <th>BENCHMARK YIELD (% P.A.)</th>
                <th>SPREAD TO 6M (BPS)</th>
                <th>SEGMENT</th>
              </tr>
            </thead>
            <tbody id="curve-table-body"></tbody>
          </table>
        </div>
      </div>

      <!-- Empty State -->
      <div id="empty-state" class="notification is-dark has-text-centered is-hidden mt-4">
        <i class="fa-solid fa-circle-info mr-2"></i> No records found matching the criteria.
      </div>
    </div>
  </main>

  <script>
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    let currentType = 'ladder';
    let currentYear = new Date().getFullYear();
    let allRecords = [];
    let displayedRecords = [];
    let masterDataCache = null;
    let yieldCurveData = null;
    let ladderSchedule = [];
    let isTimelineVisible = false;
    let sortColumn = null;
    let sortAsc = true;

    function parseFlexibleDate(str) {
      if (!str || str === '-' || str === 'N/A') return null;
      const d = new Date(str);
      if (!isNaN(d.getTime())) return d;

      const parts = str.trim().split(/[\\s\\-]+/);
      if (parts.length === 3) {
        const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
        const day = parseInt(parts[0], 10);
        const mStr = parts[1].slice(0, 3).toLowerCase();
        const year = parseInt(parts[2], 10);
        if (!isNaN(day) && months[mStr] !== undefined && !isNaN(year)) {
          return new Date(year, months[mStr], day);
        }
      }
      return null;
    }

    function formatDateStr(dateObj) {
      if (!dateObj || isNaN(dateObj.getTime())) return '-';
      const day = String(dateObj.getDate()).padStart(2, '0');
      return day + ' ' + MONTH_NAMES[dateObj.getMonth()] + ' ' + dateObj.getFullYear();
    }

    // 1. Initialize PWA & Default Start Payment Date
    (function initPWA() {
      const manifest = {
        name: "LadderMaker - Singapore Bond Ladder",
        short_name: "LadderMaker",
        start_url: "./",
        display: "standalone",
        background_color: "#0d1117",
        theme_color: "#12161a",
        icons: [{
          src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🪜</text></svg>",
          sizes: "192x192 512x512",
          type: "image/svg+xml"
        }]
      };
      const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
      document.getElementById('manifest-placeholder').setAttribute('href', URL.createObjectURL(blob));

      if ('serviceWorker' in navigator) {
        const sw = "self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));";
        navigator.serviceWorker.register(URL.createObjectURL(new Blob([sw], { type: 'application/javascript' }))).catch(() => {});
      }

      // Default First Payment Date to 1 Year from Today
      const defaultFirstDate = new Date();
      defaultFirstDate.setFullYear(defaultFirstDate.getFullYear() + 1);
      const yyyy = defaultFirstDate.getFullYear();
      const mm = String(defaultFirstDate.getMonth() + 1).padStart(2, '0');
      const dd = String(defaultFirstDate.getDate()).padStart(2, '0');
      document.getElementById('ladder-start-date').value = yyyy + '-' + mm + '-' + dd;

      const yearSelect = document.getElementById('year-select');
      for (let y = currentYear + 1; y >= currentYear - 2; y--) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = 'Year ' + y;
        if (y === currentYear) opt.selected = true;
        yearSelect.appendChild(opt);
      }
    })();

    // 2. Fetch Data from Backend
    async function loadData() {
      showLoading(true);
      document.getElementById('empty-state').classList.add('is-hidden');

      const isLadder = currentType === 'ladder';
      const isMaster = currentType === 'master';
      const isCurve = currentType === 'curve';
      const isSecondary = currentType === 'secondary';

      document.getElementById('year-wrapper').style.visibility = (isLadder || isMaster || isSecondary || isCurve) ? 'hidden' : 'visible';
      document.getElementById('ladder-controls-panel').classList.toggle('is-hidden', !isLadder);
      document.getElementById('search-wrapper').classList.toggle('is-hidden', isCurve || isLadder);

      try {
        if (isCurve) {
          const res = await axios.get('/api/yield-curve', { timeout: 10000 });
          yieldCurveData = res.data;
          renderYieldCurveView();
        } else if (isLadder || isMaster) {
          if (!masterDataCache) {
            const res = await axios.get('/api/master', { timeout: 12000 });
            masterDataCache = res.data;
          }
          allRecords = masterDataCache?.records || [];
          displayedRecords = [...allRecords];

          document.getElementById('curve-wrapper').classList.add('is-hidden');

          if (isLadder) {
            document.getElementById('table-wrapper').classList.add('is-hidden');
            document.getElementById('ladder-view').classList.remove('is-hidden');
            buildBondLadder();
          } else {
            document.getElementById('ladder-view').classList.add('is-hidden');
            document.getElementById('table-wrapper').classList.remove('is-hidden');
            updateMasterMetrics();
            renderMasterHeaders();
            renderMasterBody();
          }
        } else {
          const endpoint = isSecondary 
            ? '/api/secondary-market'
            : '/api/calendar?type=' + currentType + '&year=' + currentYear;

          const res = await axios.get(endpoint, { timeout: 10000 });
          allRecords = res.data || [];
          displayedRecords = [...allRecords];

          document.getElementById('ladder-view').classList.add('is-hidden');
          document.getElementById('curve-wrapper').classList.add('is-hidden');
          document.getElementById('table-wrapper').classList.remove('is-hidden');

          updateStandardMetrics(isSecondary);
          renderStandardHeaders(isSecondary);
          renderStandardBody(isSecondary);
        }
      } catch (err) {
        console.error('loadData error:', err);
        const sc = document.getElementById('status-container');
        sc.innerHTML = '<div class="notification is-danger is-light p-3">' +
          '<i class="fa-solid fa-triangle-exclamation mr-2"></i>' + (err.message || 'Error fetching data') + 
          '<button class="button is-small is-danger is-outlined ml-3" onclick="loadData()">Retry</button></div>';
        sc.classList.remove('is-hidden');
      } finally {
        showLoading(false);
      }
    }

    // 3. Robust Bond Ladder Engine (Strict Tenor & Chronological Constraints)
    function buildBondLadder() {
      const stepYears = parseFloat(document.getElementById('ladder-freq').value) || 1.0;
      const horizonYears = parseFloat(document.getElementById('ladder-horizon').value) || 5.0;
      const totalCapital = parseFloat(document.getElementById('ladder-capital').value) || 100000;
      const strategy = document.getElementById('ladder-strategy').value;

      const startDateInput = document.getElementById('ladder-start-date').value;
      let firstPaymentDate = new Date(startDateInput);
      if (isNaN(firstPaymentDate.getTime())) {
        firstPaymentDate = new Date();
        firstPaymentDate.setFullYear(firstPaymentDate.getFullYear() + 1);
      }
      firstPaymentDate.setHours(0, 0, 0, 0);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const numRungs = Math.round(horizonYears / stepYears);
      const capitalPerRung = totalCapital / Math.max(1, numRungs);

      const availableBonds = [...allRecords];
      const usedIssueCodes = new Set();
      ladderSchedule = [];

      let lastMaturityTimestamp = 0;

      for (let i = 1; i <= numRungs; i++) {
        // Calculate the target maturity date for this rung
        const targetDateObj = new Date(firstPaymentDate.getTime());
        const monthsToAdd = Math.round((i - 1) * stepYears * 12);
        targetDateObj.setMonth(targetDateObj.getMonth() + monthsToAdd);

        const durationFromTodayYears = (targetDateObj - today) / (365.25 * 86400000);

        // Window tolerance: +/- 200 days for annual, +/- 100 days for 6M
        const windowDays = Math.max(45, Math.round(stepYears * 365.25 * 0.55));

        // Filter valid candidates with strict rules:
        let candidates = availableBonds.filter(b => {
          if (usedIssueCodes.has(b.issueCode)) return false;

          const mat = parseFlexibleDate(b.maturityDate);
          if (!mat) return false;

          // RULE 1: T-Bills can NEVER be matched to target dates > 1.2 years away!
          if (b.isTbill && durationFromTodayYears > 1.2) {
            return false;
          }

          // RULE 2: Chronological progression - maturity cannot be months before previous rung
          if (lastMaturityTimestamp > 0 && mat.getTime() < (lastMaturityTimestamp - 45 * 86400000)) {
            return false;
          }

          // RULE 3: Must fall within the target date window
          const diffDays = Math.abs((mat - targetDateObj) / 86400000);
          return diffDays <= windowDays;
        });

        // Fallback for multi-year SGS bonds only (never T-bills) within 1 year maximum buffer
        if (!candidates.length && durationFromTodayYears > 1.2) {
          const maxAllowedDiffDays = Math.min(365, stepYears * 365.25 * 0.9);
          candidates = availableBonds.filter(b => {
            if (usedIssueCodes.has(b.issueCode) || b.isTbill) return false;
            const mat = parseFlexibleDate(b.maturityDate);
            if (!mat) return false;
            if (lastMaturityTimestamp > 0 && mat.getTime() < lastMaturityTimestamp) return false;
            const diffDays = Math.abs((mat - targetDateObj) / 86400000);
            return diffDays <= maxAllowedDiffDays;
          });
        }

        let selected = null;
        if (candidates.length > 0) {
          if (strategy === 'max-yield') {
            candidates.sort((a, b) => (b.indicativeYield || 0) - (a.indicativeYield || 0));
            selected = candidates[0];
          } else {
            candidates.sort((a, b) => {
              const diffA = Math.abs((parseFlexibleDate(a.maturityDate) - targetDateObj) / 86400000);
              const diffB = Math.abs((parseFlexibleDate(b.maturityDate) - targetDateObj) / 86400000);
              return diffA - diffB;
            });
            selected = candidates[0];
          }

          usedIssueCodes.add(selected.issueCode);
          const selMat = parseFlexibleDate(selected.maturityDate);
          if (selMat) lastMaturityTimestamp = selMat.getTime();
        }

        ladderSchedule.push({
          rungIndex: i,
          targetDateObj: targetDateObj,
          targetDateStr: formatDateStr(targetDateObj),
          selectedBond: selected,
          allocatedCapital: capitalPerRung,
          candidates: candidates
        });
      }

      const cashflows = generateLadderCashflows(ladderSchedule);
      renderLadderTimeline(cashflows);
      renderLadderTable(totalCapital);
    }

    // 4. Generate & Render Scrollable Cashflow Timeline with Coupons & Maturity Inflows
    function generateLadderCashflows(schedule) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const cashflows = [];

      schedule.forEach(rung => {
        const b = rung.selectedBond;
        if (!b) return; // Skip unfilled rungs

        const C = rung.allocatedCapital;
        const y = b.indicativeYield || 0;
        const matDate = parseFlexibleDate(b.maturityDate);

        if (b.isTbill) {
          const totalPayout = C + (C * (y / 100) * (b.durationYears || 0.5));
          if (matDate && matDate > today) {
            cashflows.push({
              dateObj: matDate,
              dateStr: formatDateStr(matDate),
              amount: Math.round(totalPayout),
              principalAmt: Math.round(C),
              interestAmt: Math.round(totalPayout - C),
              issueCode: b.issueCode,
              secType: b.secType,
              type: 'T-Bill Maturity (Payout #' + rung.rungIndex + ')',
              isMaturity: true
            });
          }
        } else {
          let d1 = 1, m1 = 1, d2 = 1, m2 = 7;
          if (b.couponSchedule && b.couponSchedule.includes('&')) {
            const match = b.couponSchedule.match(/\\((\\d{1,2})\\s+([A-Za-z]{3})\\s+&\\s+(\\d{1,2})\\s+([A-Za-z]{3})\\)/);
            if (match) {
              d1 = parseInt(match[1], 10);
              m1 = MONTH_NAMES.indexOf(match[2]);
              d2 = parseInt(match[3], 10);
              m2 = MONTH_NAMES.indexOf(match[4]);
            }
          } else if (matDate) {
            d1 = matDate.getDate();
            m1 = (matDate.getMonth() + 6) % 12;
            d2 = matDate.getDate();
            m2 = matDate.getMonth();
          }

          const semiCouponAmt = Math.round(C * (y / 100) / 2);
          const startYear = today.getFullYear();
          const endYear = matDate ? matDate.getFullYear() : startYear + 5;

          for (let yr = startYear; yr <= endYear; yr++) {
            [ { d: d1, m: m1 }, { d: d2, m: m2 } ].forEach(item => {
              if (item.m >= 0) {
                const cDate = new Date(yr, item.m, item.d);
                cDate.setHours(0, 0, 0, 0);

                if (cDate > today && (!matDate || cDate.getTime() < matDate.getTime())) {
                  cashflows.push({
                    dateObj: cDate,
                    dateStr: formatDateStr(cDate),
                    amount: semiCouponAmt,
                    issueCode: b.issueCode,
                    secType: b.secType,
                    type: 'Coupon Payment',
                    isMaturity: false
                  });
                }
              }
            });
          }

          if (matDate && matDate > today) {
            cashflows.push({
              dateObj: matDate,
              dateStr: formatDateStr(matDate),
              amount: Math.round(C + semiCouponAmt),
              principalAmt: Math.round(C),
              interestAmt: semiCouponAmt,
              issueCode: b.issueCode,
              secType: b.secType,
              type: 'Maturity Lump Sum (Payout #' + rung.rungIndex + ')',
              isMaturity: true
            });
          }
        }
      });

      cashflows.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
      return cashflows;
    }

    function renderLadderTimeline(cashflows) {
      const container = document.getElementById('ladder-timeline-track');
      container.innerHTML = '';

      document.getElementById('timeline-count-badge').textContent = cashflows.length + ' Scheduled Payments';

      if (!cashflows.length) {
        container.innerHTML = '<div class="has-text-grey p-4">No cashflows scheduled for this configuration.</div>';
        return;
      }

      cashflows.forEach(cf => {
        const node = document.createElement('div');
        node.style.cssText = 'display: inline-flex; flex-direction: column; align-items: center; min-width: 160px; text-align: center; margin-right: 20px;';

        const badgeClass = cf.isMaturity ? 'is-success' : 'is-info';
        const arrowColor = cf.isMaturity ? '#48c78e' : '#58a6ff';
        const dotColor = cf.isMaturity ? '#48c78e' : '#58a6ff';
        const amountColor = cf.isMaturity ? 'has-text-success' : 'has-text-info';

        let subDetail = '';
        if (cf.isMaturity && cf.principalAmt) {
          subDetail = '<div class="is-size-7 has-text-grey mt-1">Lump Sum Principal: $' + cf.principalAmt.toLocaleString() + '</div>';
        }

        node.innerHTML = 
          '<div class="box p-2 mb-2" style="background: #21262d; border: 1px solid #30363d; border-radius: 6px; width: 100%; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">' +
            '<div class="is-size-6 monospace has-text-weight-bold ' + amountColor + '">+$' + cf.amount.toLocaleString() + '</div>' +
            '<div class="is-size-7 has-text-weight-semibold has-text-light mt-1">' + cf.dateStr + '</div>' +
            '<div class="is-size-7 monospace has-text-grey-light">' + cf.issueCode + '</div>' +
            subDetail +
            '<span class="tag is-small mt-1 ' + badgeClass + ' is-light" style="font-size: 0.65rem; height: 1.5em; padding: 0 5px;">' + cf.type + '</span>' +
          '</div>' +
          '<div style="color: ' + arrowColor + '; font-size: 15px; margin-bottom: -6px; z-index: 2;">' +
            '<i class="fa-solid fa-arrow-down"></i>' +
          '</div>' +
          '<div style="width: 12px; height: 12px; border-radius: 50%; background: ' + dotColor + '; border: 2px solid #0d1117; z-index: 2;"></div>' +
          '<div class="is-size-7 has-text-grey mt-1 monospace">' + MONTH_NAMES[cf.dateObj.getMonth()] + ' \\'' + String(cf.dateObj.getFullYear()).slice(-2) + '</div>';

        container.appendChild(node);
      });
    }

    // Toggle Button Handler for Timeline
    document.getElementById('btn-toggle-timeline').onclick = () => {
      isTimelineVisible = !isTimelineVisible;
      const card = document.getElementById('ladder-timeline-card');
      card.classList.toggle('is-hidden', !isTimelineVisible);
      document.getElementById('btn-timeline-text').textContent = isTimelineVisible ? 'Hide Cash Flow Timeline' : 'Show Cash Flow Timeline';
      const btn = document.getElementById('btn-toggle-timeline');
      btn.classList.toggle('is-info', !isTimelineVisible);
      btn.classList.toggle('is-success', isTimelineVisible);
    };

    function renderLadderTable(totalCapital) {
      const tbody = document.getElementById('ladder-table-body');
      tbody.innerHTML = '';

      if (!ladderSchedule.length) {
        document.getElementById('empty-state').classList.remove('is-hidden');
        return;
      }
      document.getElementById('empty-state').classList.add('is-hidden');

      let weightedYieldSum = 0;
      let totalEstAnnualIncome = 0;
      let filledCapital = 0;

      ladderSchedule.forEach(rung => {
        const b = rung.selectedBond;
        const tr = document.createElement('tr');
        const badgeColor = rung.rungIndex % 2 === 0 ? 'background-color: #238636;' : 'background-color: #1f6feb;';

        // Case A: No security matching this rung's window in the Singapore bond market
        if (!b) {
          tr.innerHTML = '<td><span class="rung-step has-text-grey" style="background-color: #30363d;">' + rung.rungIndex + '</span></td>' +
            '<td><span class="tag is-warning is-light monospace has-text-weight-bold"><i class="fa-regular fa-calendar-check mr-1"></i> ' + rung.targetDateStr + '</span></td>' +
            '<td colspan="2"><span class="tag is-dark has-text-warning"><i class="fa-solid fa-triangle-exclamation mr-1"></i> No SGS issue maturing in this period</span></td>' +
            '<td><span class="has-text-grey">Hold in SORA / Cash Reserve</span></td>' +
            '<td class="monospace has-text-grey">$' + Math.round(rung.allocatedCapital).toLocaleString() + '</td>' +
            '<td><span class="has-text-grey">-</span></td>' +
            '<td><span class="has-text-grey">-</span></td>';
          tbody.appendChild(tr);
          return;
        }

        // Case B: Valid matching security
        const yieldVal = b.indicativeYield || 0;
        const annualIncome = (rung.allocatedCapital * yieldVal) / 100;

        weightedYieldSum += yieldVal * rung.allocatedCapital;
        totalEstAnnualIncome += annualIncome;
        filledCapital += rung.allocatedCapital;

        const tagClass = b.secType === 'Primary SGS' ? 'is-primary' : (b.secType === 'Primary T-Bill' ? 'is-info' : 'is-warning');

        tr.innerHTML = '<td><span class="rung-step has-text-white is-size-7" style="' + badgeColor + '">' + rung.rungIndex + '</span></td>' +
          '<td><span class="tag is-warning is-light monospace has-text-weight-bold"><i class="fa-regular fa-calendar-check mr-1"></i> ' + rung.targetDateStr + '</span></td>' +
          '<td><span class="monospace has-text-weight-bold has-text-light">' + b.issueCode + '</span> <span class="tag is-small ml-2 ' + tagClass + '">' + b.secType + '</span></td>' +
          '<td class="has-text-weight-medium">' + b.maturityDate + '</td>' +
          '<td>' + (b.isTbill 
            ? '<span class="tag is-dark is-light"><i class="fa-solid fa-flag-checkered mr-1 has-text-info"></i> ' + b.couponSchedule + '</span>' 
            : '<span class="tag is-primary is-light has-text-weight-bold"><i class="fa-solid fa-arrows-rotate mr-1"></i> ' + b.couponSchedule + '</span>') + '</td>' +
          '<td class="monospace has-text-light">$' + Math.round(rung.allocatedCapital).toLocaleString() + '</td>' +
          '<td><span class="tag is-success is-light monospace has-text-weight-bold is-medium">' + yieldVal.toFixed(2) + '%</span></td>' +
          '<td class="monospace has-text-success has-text-weight-bold">+$' + Math.round(annualIncome).toLocaleString() + '/yr</td>';

        tbody.appendChild(tr);
      });

      const avgLadderYield = filledCapital > 0 ? (weightedYieldSum / filledCapital) : 0;
      const filledCount = ladderSchedule.filter(r => r.selectedBond !== null).length;

      document.getElementById('stat-label-1').textContent = 'Overall Ladder Yield';
      document.getElementById('stat-val-1').innerHTML = '<span class="has-text-success">' + avgLadderYield.toFixed(2) + '% p.a.</span>';

      document.getElementById('stat-label-2').textContent = 'Total Capital';
      document.getElementById('stat-val-2').textContent = '$' + Math.round(totalCapital).toLocaleString();

      document.getElementById('stat-label-3').textContent = 'Est. Annual Income';
      document.getElementById('stat-val-3').innerHTML = '<span class="has-text-info">+$' + Math.round(totalEstAnnualIncome).toLocaleString() + '</span>';

      document.getElementById('stat-label-4').textContent = 'Active Rungs';
      document.getElementById('stat-val-4').textContent = filledCount + ' of ' + ladderSchedule.length + ' Payouts';
    }

    document.getElementById('ladder-start-date').onchange = buildBondLadder;
    document.getElementById('ladder-freq').onchange = buildBondLadder;
    document.getElementById('ladder-horizon').onchange = buildBondLadder;
    document.getElementById('ladder-capital').oninput = buildBondLadder;
    document.getElementById('ladder-strategy').onchange = buildBondLadder;

    // 5. Master Table View Handlers
    function updateMasterMetrics() {
      document.getElementById('stat-label-1').textContent = 'Total Valid Issues';
      document.getElementById('stat-val-1').textContent = allRecords.length;

      document.getElementById('stat-label-2').textContent = 'Primary Auctions';
      const primaryCount = allRecords.filter(r => r.secType && r.secType.startsWith('Primary')).length;
      document.getElementById('stat-val-2').textContent = primaryCount;

      document.getElementById('stat-label-3').textContent = 'Secondary Bonds';
      const secCount = allRecords.filter(r => r.secType === 'Secondary SGS').length;
      document.getElementById('stat-val-3').textContent = secCount;

      document.getElementById('stat-label-4').textContent = 'Curve Benchmark Date';
      document.getElementById('stat-val-4').textContent = masterDataCache?.curveDate || '-';
    }

    function renderMasterHeaders() {
      const row = document.getElementById('table-head-row');
      row.innerHTML = '';

      const cols = [
        { id: 'issueCode', title: 'COL 1: ISSUE CODE' },
        { id: 'isin', title: 'COL 2: ISIN' },
        { id: 'maturityDate', title: 'COL 3: MATURITY DATE' },
        { id: 'auctionDate', title: 'COL 4: AUCTION DATE' },
        { id: 'issueDate', title: 'COL 5: ISSUE DATE' },
        { id: 'couponSchedule', title: 'COL 6: COUPON PAYMENT DATES' },
        { id: 'indicativeYield', title: 'COL 7: INDICATIVE YIELD (% P.A.)' }
      ];

      cols.forEach(c => {
        const th = document.createElement('th');
        th.innerHTML = '<span>' + c.title + '</span> <i class="fa-solid fa-sort ml-1 has-text-grey-dark"></i>';
        th.onclick = () => {
          sortAsc = sortColumn === c.id ? !sortAsc : true;
          sortColumn = c.id;
          displayedRecords.sort((a, b) => {
            const vA = a[c.id] ?? '';
            const vB = b[c.id] ?? '';
            if (typeof vA === 'number' && typeof vB === 'number') {
              return sortAsc ? vA - vB : vB - vA;
            }
            return sortAsc ? String(vA).localeCompare(String(vB)) : String(vB).localeCompare(String(a[k]));
          });
          renderMasterBody();
        };
        row.appendChild(th);
      });
    }

    function renderMasterBody() {
      const tbody = document.getElementById('table-body');
      tbody.innerHTML = '';
      if (!displayedRecords.length) {
        document.getElementById('empty-state').classList.remove('is-hidden');
        return;
      }
      document.getElementById('empty-state').classList.add('is-hidden');

      displayedRecords.forEach(r => {
        const tr = document.createElement('tr');
        const tagClass = r.secType === 'Primary SGS' ? 'is-primary' : (r.secType === 'Primary T-Bill' ? 'is-info' : 'is-warning');
        const col1 = '<td><span class="monospace has-text-weight-bold has-text-light">' + r.issueCode + '</span> <span class="tag is-small ml-2 ' + tagClass + '">' + r.secType + '</span></td>';
        const col2 = '<td><span class="monospace has-text-grey-light">' + (r.isin || '-') + '</span></td>';
        const col3 = '<td class="has-text-weight-medium">' + r.maturityDate + '</td>';
        const col4 = '<td>' + (r.auctionDate !== '-' ? '<span class="has-text-info monospace"><i class="fa-regular fa-calendar-check mr-1"></i>' + r.auctionDate + '</span>' : '<span class="has-text-grey">-</span>') + '</td>';
        const col5 = '<td class="has-text-grey-light">' + r.issueDate + '</td>';
        const col6Content = r.isTbill 
          ? '<span class="tag is-dark is-light"><i class="fa-solid fa-flag-checkered mr-1 has-text-info"></i> ' + r.couponSchedule + '</span>' 
          : '<span class="tag is-primary is-light has-text-weight-bold"><i class="fa-solid fa-arrows-rotate mr-1"></i> ' + r.couponSchedule + '</span>';
        const col6 = '<td>' + col6Content + '</td>';
        const yieldVal = r.indicativeYield !== null ? r.indicativeYield.toFixed(2) + '%' : '<span class="has-text-grey">-</span>';
        const col7 = '<td><span class="tag is-success is-light monospace has-text-weight-bold is-medium">' + yieldVal + '</span> <span class="is-size-7 has-text-grey ml-1">(' + r.durationYears + 'Y)</span></td>';

        tr.innerHTML = col1 + col2 + col3 + col4 + col5 + col6 + col7;
        tbody.appendChild(tr);
      });
    }

    // 6. Yield Curve View Handlers
    function renderYieldCurveView() {
      document.getElementById('ladder-view').classList.add('is-hidden');
      document.getElementById('table-wrapper').classList.add('is-hidden');
      document.getElementById('curve-wrapper').classList.remove('is-hidden');

      if (!yieldCurveData || !yieldCurveData.date) {
        document.getElementById('empty-state').classList.remove('is-hidden');
        document.getElementById('curve-wrapper').classList.add('is-hidden');
        return;
      }
      document.getElementById('empty-state').classList.add('is-hidden');

      const c = yieldCurveData;
      document.getElementById('curve-date-badge').textContent = 'As of: ' + c.date;

      document.getElementById('stat-label-1').textContent = 'Curve Date';
      document.getElementById('stat-val-1').textContent = c.date;

      document.getElementById('stat-label-2').textContent = '2-Year Yield';
      document.getElementById('stat-val-2').textContent = c['2Y'] ? c['2Y'].toFixed(2) + '%' : 'N/A';

      document.getElementById('stat-label-3').textContent = '10-Year Yield';
      document.getElementById('stat-val-3').textContent = c['10Y'] ? c['10Y'].toFixed(2) + '%' : 'N/A';

      const spread10_2 = (c['10Y'] && c['2Y']) ? ((c['10Y'] - c['2Y']) * 100).toFixed(0) : null;
      document.getElementById('stat-label-4').textContent = '10Y - 2Y Spread';
      document.getElementById('stat-val-4').innerHTML = spread10_2 
        ? '<span class="' + (spread10_2 >= 0 ? 'has-text-success' : 'has-text-danger') + '">' + (spread10_2 >= 0 ? '+' : '') + spread10_2 + ' bps</span>' 
        : 'N/A';

      const tenors = [
        { label: '6M', years: 0.5, val: c['6M'], seg: 'Money Market' },
        { label: '1Y', years: 1, val: c['1Y'], seg: 'Short-Term' },
        { label: '2Y', years: 2, val: c['2Y'], seg: 'Short-Term' },
        { label: '5Y', years: 5, val: c['5Y'], seg: 'Medium-Term' },
        { label: '10Y', years: 10, val: c['10Y'], seg: 'Long-Term (Benchmark)' },
        { label: '15Y', years: 15, val: c['15Y'], seg: 'Long-Term' },
        { label: '20Y', years: 20, val: c['20Y'], seg: 'Ultra-Long' },
        { label: '30Y', years: 30, val: c['30Y'], seg: 'Ultra-Long' },
        { label: '50Y', years: 50, val: c['50Y'], seg: 'Ultra-Long' }
      ].filter(t => t.val !== null && t.val !== undefined && t.val < 20);

      renderSvgCurve(tenors);

      const tbody = document.getElementById('curve-table-body');
      tbody.innerHTML = '';
      const base6M = c['6M'] || tenors[0]?.val || 0;

      tenors.forEach(t => {
        const spreadTo6M = ((t.val - base6M) * 100).toFixed(1);
        const spreadClass = spreadTo6M >= 0 ? 'has-text-success' : 'has-text-danger';
        const spreadSign = spreadTo6M >= 0 ? '+' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = '<td><span class="tag is-info is-light monospace has-text-weight-bold">' + t.label + '</span></td>' +
          '<td class="has-text-weight-bold has-text-light monospace">' + t.val.toFixed(2) + '%</td>' +
          '<td class="monospace ' + spreadClass + '">' + spreadSign + spreadTo6M + ' bps</td>' +
          '<td><span class="has-text-grey">' + t.seg + '</span></td>';
        tbody.appendChild(tr);
      });
    }

    function renderSvgCurve(tenors) {
      const svg = document.getElementById('curve-svg');
      svg.innerHTML = '';
      if (!tenors.length) return;

      const w = 800, h = 280;
      const padL = 60, padR = 40, padT = 30, padB = 40;
      const chartW = w - padL - padR;
      const chartH = h - padT - padB;

      const vals = tenors.map(t => t.val);
      const minVal = Math.max(0, Math.floor(Math.min(...vals) * 10) / 10 - 0.2);
      const maxVal = Math.ceil(Math.max(...vals) * 10) / 10 + 0.2;

      const getX = (idx) => padL + (idx / Math.max(1, tenors.length - 1)) * chartW;
      const getY = (val) => padT + chartH - ((val - minVal) / Math.max(0.01, maxVal - minVal)) * chartH;

      for (let i = 0; i <= 4; i++) {
        const yVal = minVal + (i / 4) * (maxVal - minVal);
        const yPos = getY(yVal);

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', padL);
        line.setAttribute('y1', yPos);
        line.setAttribute('x2', w - padR);
        line.setAttribute('y2', yPos);
        line.setAttribute('stroke', '#30363d');
        line.setAttribute('stroke-dasharray', '3,3');
        svg.appendChild(line);

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', padL - 10);
        text.setAttribute('y', yPos + 4);
        text.setAttribute('text-anchor', 'end');
        text.setAttribute('fill', '#8b949e');
        text.setAttribute('font-size', '11');
        text.textContent = yVal.toFixed(2) + '%';
        svg.appendChild(text);
      }

      let areaPathD = 'M ' + getX(0) + ' ' + (padT + chartH) + ' ';
      for (let i = 0; i < tenors.length; i++) {
        areaPathD += 'L ' + getX(i) + ' ' + getY(tenors[i].val) + ' ';
      }
      areaPathD += 'L ' + getX(tenors.length - 1) + ' ' + (padT + chartH) + ' Z';

      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      defs.innerHTML = '<linearGradient id="curveGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#58a6ff" stop-opacity="0.35"/><stop offset="100%" stop-color="#58a6ff" stop-opacity="0.0"/></linearGradient>';
      svg.appendChild(defs);

      const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      area.setAttribute('d', areaPathD);
      area.setAttribute('fill', 'url(#curveGrad)');
      svg.appendChild(area);

      let linePathD = '';
      for (let i = 0; i < tenors.length; i++) {
        linePathD += (i === 0 ? 'M ' : 'L ') + getX(i) + ' ' + getY(tenors[i].val) + ' ';
      }

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', linePathD);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#58a6ff');
      path.setAttribute('stroke-width', '3');
      svg.appendChild(path);

      tenors.forEach((t, i) => {
        const cx = getX(i);
        const cy = getY(t.val);

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', '5');
        circle.setAttribute('fill', '#0d1117');
        circle.setAttribute('stroke', '#58a6ff');
        circle.setAttribute('stroke-width', '2.5');
        svg.appendChild(circle);

        const valText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        valText.setAttribute('x', cx);
        valText.setAttribute('y', cy - 10);
        valText.setAttribute('text-anchor', 'middle');
        valText.setAttribute('fill', '#ffffff');
        valText.setAttribute('font-weight', 'bold');
        valText.setAttribute('font-size', '11');
        valText.textContent = t.val.toFixed(2) + '%';
        svg.appendChild(valText);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', cx);
        label.setAttribute('y', h - padB + 20);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('fill', '#8b949e');
        label.setAttribute('font-size', '12');
        label.setAttribute('font-weight', '600');
        label.textContent = t.label;
        svg.appendChild(label);
      });
    }

    // 7. Standard Tab Handlers (All, Primary, Secondary)
    function updateStandardMetrics(isSecondary) {
      document.getElementById('stat-label-1').textContent = 'Securities Listed';
      document.getElementById('stat-val-1').textContent = allRecords.length;

      if (isSecondary) {
        document.getElementById('stat-label-2').textContent = 'Benchmark Bonds';
        document.getElementById('stat-val-2').textContent = allRecords.filter(r => r.benchmark && r.benchmark !== '-').length;
        document.getElementById('stat-label-3').textContent = 'With Bid Price';
        document.getElementById('stat-val-3').textContent = allRecords.filter(r => r.bidPrice && r.bidPrice !== '-').length;
        document.getElementById('stat-label-4').textContent = 'Total Size (S$M)';
        const totalSize = allRecords.reduce((acc, r) => acc + (parseFloat(r.issueSizeMillion) || 0), 0);
        document.getElementById('stat-val-4').textContent = totalSize ? '$' + Math.round(totalSize).toLocaleString() : 'N/A';
      } else {
        document.getElementById('stat-label-2').textContent = 'SGS Bonds';
        document.getElementById('stat-val-2').textContent = allRecords.filter(r => r._category === 'SGS Bond').length;
        document.getElementById('stat-label-3').textContent = 'T-Bills';
        document.getElementById('stat-val-3').textContent = allRecords.filter(r => r._category === 'T-Bill').length;
        document.getElementById('stat-label-4').textContent = 'SSB Issues';
        document.getElementById('stat-val-4').textContent = allRecords.filter(r => r._category === 'SSB').length;
      }
    }

    function renderStandardHeaders(isSecondary) {
      const row = document.getElementById('table-head-row');
      row.innerHTML = '';
      if (!allRecords.length) return;

      const keys = isSecondary
        ? ['benchmark', 'issueCode', 'isin', 'couponRate', 'maturityDate', 'issueSizeMillion', 'bidPrice', 'yieldPct', 'interestDate1', 'interestDate2']
        : ['_category', 'issue_code', 'ann_date', 'auction_date', 'open_date', 'close_date', 'issue_date', 'maturity_date', 'auction_tenor', 'status'];

      keys.forEach(k => {
        const th = document.createElement('th');
        let label = k.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').toUpperCase();
        if (k === '_category') label = 'SECURITY';
        if (k === 'issueSizeMillion') label = 'SIZE (S$M)';
        if (k === 'bidPrice') label = 'BUYING / BID PRICE';
        if (k === 'yieldPct') label = 'CLOSING YIELD';
        
        th.innerHTML = '<span>' + label + '</span> <i class="fa-solid fa-sort ml-1 has-text-grey-dark"></i>';
        th.onclick = () => {
          sortAsc = sortColumn === k ? !sortAsc : true;
          sortColumn = k;
          displayedRecords.sort((a, b) => sortAsc ? String(a[k] ?? '').localeCompare(String(b[k] ?? '')) : String(b[k] ?? '').localeCompare(String(a[k] ?? '')));
          renderStandardBody(isSecondary);
        };
        row.appendChild(th);
      });
    }

    function renderStandardBody(isSecondary) {
      const tbody = document.getElementById('table-body');
      tbody.innerHTML = '';
      if (!displayedRecords.length) {
        document.getElementById('empty-state').classList.remove('is-hidden');
        return;
      }
      document.getElementById('empty-state').classList.add('is-hidden');

      const keys = isSecondary
        ? ['benchmark', 'issueCode', 'isin', 'couponRate', 'maturityDate', 'issueSizeMillion', 'bidPrice', 'yieldPct', 'interestDate1', 'interestDate2']
        : ['_category', 'issue_code', 'ann_date', 'auction_date', 'open_date', 'close_date', 'issue_date', 'maturity_date', 'auction_tenor', 'status'];

      displayedRecords.forEach(r => {
        const tr = document.createElement('tr');
        keys.forEach(k => {
          const td = document.createElement('td');
          const val = r[k] ?? '-';
          if (k === '_category') {
            const badgeClass = val === 'SGS Bond' ? 'is-primary' : (val === 'T-Bill' ? 'is-info' : 'is-success');
            td.innerHTML = '<span class="tag is-small ' + badgeClass + '">' + val + '</span>';
          } else if (k === 'benchmark' && val !== '-') {
            td.innerHTML = '<span class="tag is-small is-warning is-light has-text-weight-bold">' + val + '</span>';
          } else if (k.toLowerCase().includes('status')) {
            const isClosed = /closed|ended/i.test(val);
            const isOpen = /open|upcoming/i.test(val);
            const tagClass = isOpen ? 'is-success' : isClosed ? 'is-dark' : 'is-info';
            td.innerHTML = '<span class="tag is-small ' + tagClass + '">' + (val || 'UPCOMING') + '</span>';
          } else if (k === 'issueCode' || k === 'isin' || k.toLowerCase().includes('code')) {
            td.innerHTML = '<span class="monospace has-text-info-light">' + val + '</span>';
          } else {
            td.textContent = val;
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    // 8. Navigation Tabs
    document.querySelectorAll('#category-tabs li').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('#category-tabs li').forEach(t => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        currentType = tab.getAttribute('data-type');
        loadData();
      };
    });

    document.getElementById('year-select').onchange = (e) => {
      currentYear = e.target.value;
      loadData();
    };

    document.getElementById('search-input').oninput = (e) => {
      const q = e.target.value.toLowerCase().trim();
      displayedRecords = allRecords.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
      if (currentType === 'master') {
        renderMasterBody();
      } else {
        renderStandardBody(currentType === 'secondary');
      }
    };

    // 9. Refresh & CSV Export
    document.getElementById('btn-refresh').onclick = () => {
      masterDataCache = null;
      loadData();
    };

    document.getElementById('btn-export').onclick = () => {
      if (currentType === 'ladder') {
        if (!ladderSchedule.length) return;
        const csvRows = ['Rung,TargetPayoutDate,Type,IssueCode,ISIN,MaturityDate,CouponSchedule,AllocatedCapital,IndicativeYield,EstAnnualIncome'];
        ladderSchedule.forEach(r => {
          const b = r.selectedBond;
          const y = b ? (b.indicativeYield || 0) : 0;
          const inc = b ? ((r.allocatedCapital * y) / 100) : 0;
          csvRows.push([
            r.rungIndex, r.targetDateStr, b ? b.secType : 'No Issue', b ? b.issueCode : '-', b ? b.isin : '-',
            b ? b.maturityDate : '-', b ? b.couponSchedule : '-', r.allocatedCapital, b ? (y + '%') : '-', inc
          ].map(x => '"' + (x ?? '') + '"').join(','));
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csvRows.join('\\n')], { type: 'text/csv' }));
        a.download = 'sgs_bond_ladder_schedule.csv';
        a.click();
        return;
      }

      if (currentType === 'master') {
        if (!displayedRecords.length) return;
        const csvRows = ['Type,IssueCode,ISIN,MaturityDate,AuctionDate,IssueDate,CouponPaymentDates,DurationYears,IndicativeYield'];
        displayedRecords.forEach(r => {
          csvRows.push([
            r.secType, r.issueCode, r.isin, r.maturityDate,
            r.auctionDate, r.issueDate, r.couponSchedule, r.durationYears,
            r.indicativeYield !== null ? r.indicativeYield + '%' : ''
          ].map(x => '"' + (x ?? '') + '"').join(','));
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csvRows.join('\\n')], { type: 'text/csv' }));
        a.download = 'mas_sgs_master_table.csv';
        a.click();
        return;
      }

      if (currentType === 'curve' && yieldCurveData) {
        const c = yieldCurveData;
        const csvRows = ['Tenor,Yield (% p.a.),AsOfDate'];
        const list = [
          ['6M', c['6M']], ['1Y', c['1Y']], ['2Y', c['2Y']],
          ['5Y', c['5Y']], ['10Y', c['10Y']], ['15Y', c['15Y']],
          ['20Y', c['20Y']], ['30Y', c['30Y']], ['50Y', c['50Y']]
        ];
        list.forEach(item => {
          csvRows.push(item[0] + ',' + (item[1] !== null ? item[1] : '') + ',' + c.date);
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csvRows.join('\\n')], { type: 'text/csv' }));
        a.download = 'sgs_yield_curve_' + c.date.replace(/\\s+/g, '_') + '.csv';
        a.click();
        return;
      }

      if (!displayedRecords.length) return;
      const headers = Object.keys(displayedRecords[0]);
      const csv = [headers.join(','), ...displayedRecords.map(r => headers.map(h => '"' + (r[h] ?? '') + '"').join(','))].join('\\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = (currentType === 'secondary' ? 'sgs_secondary_market' : 'mas_issuances_' + currentType) + '.csv';
      a.click();
    };

    function showLoading(show) {
      const spinner = document.getElementById('status-container');
      if (spinner) spinner.classList.toggle('is-hidden', !show);
    }

    loadData();
  </script>
</body>
</html>`;

// 6. HTTP Router
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/api/master') {
    try {
      const data = await getMasterTableData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (parsedUrl.pathname === '/api/yield-curve') {
    const curve = await getSGSYieldCurve();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(curve));
  } else if (parsedUrl.pathname === '/api/secondary-market') {
    const bonds = await scrapeMASSecondaryMarket();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bonds));
  } else if (parsedUrl.pathname === '/api/calendar') {
    const type = parsedUrl.query.type || 'all';
    const year = parsedUrl.query.year || new Date().getFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    try {
      let results = [];
      const sgsFilters = `issue_type:("B" OR "I" OR "G") AND ann_date:[${startDate} TO ${endDate}]`;
      const tbillFilters = `issue_type:"T" AND ann_date:[${startDate} TO ${endDate}]`;
      const ssbFilters = `issue_type:"S" AND ann_date:[${startDate} TO ${endDate}]`;

      if (type === 'sgs') {
        const sgs = await fetchMasApi('/issuancecalendar', sgsFilters);
        results = sgs.map(r => ({ _category: 'SGS Bond', ...r }));
      } else if (type === 'tbill') {
        const tbills = await fetchMasApi('/issuancecalendar', tbillFilters);
        results = tbills.map(r => ({ _category: 'T-Bill', ...r }));
      } else if (type === 'ssb') {
        const ssb = await fetchMasApi('/savingbondsissuancecalendar', ssbFilters);
        results = ssb.map(r => ({ _category: 'SSB', ...r }));
      } else {
        const [sgs, tbills, ssb] = await Promise.all([
          fetchMasApi('/issuancecalendar', sgsFilters),
          fetchMasApi('/issuancecalendar', tbillFilters),
          fetchMasApi('/savingbondsissuancecalendar', ssbFilters)
        ]);

        results = [
          ...sgs.map(r => ({ _category: 'SGS Bond', ...r })),
          ...tbills.map(r => ({ _category: 'T-Bill', ...r })),
          ...ssb.map(r => ({ _category: 'SSB', ...r }))
        ];

        results.sort((a, b) => String(a.ann_date || '').localeCompare(String(b.ann_date || '')));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_CONTENT);
  }
});

server.listen(PORT, () => {
  console.log(`LadderMaker running on port ${PORT}`);
});