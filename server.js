const http = require('http');
const https = require('https');
const url = require('url');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3000;
const BASE_MAS_URL = 'https://eservices.mas.gov.sg/statistics/api/v1/bondsandbills/m';
const SECONDARY_MARKET_URL = 'https://eservices.mas.gov.sg/statistics/fdanet/BondPricesAndYields.aspx';
const YIELD_CURVE_URL = 'https://eservices.mas.gov.sg/statistics/fdanet/SgsBenchmarkIssuePrices.aspx';

// 1. Scrape SGS Yield Curve from MAS (Extracting Yields, not Prices)
async function getSGSYieldCurve() {
  try {
    const { data: html } = await axios.get(YIELD_CURVE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    const $ = cheerio.load(html);
    let latestCurve = null;

    $('tr').each((_, row) => {
      const cols = $(row)
        .find('td')
        .map((_, td) => $(td).text().trim().replace(/\s+/g, ' '))
        .get();

      // Check for date row (e.g., "16 Oct 2026" or "16-Oct-2026")
      if (cols.length >= 10 && /\d{1,2}[\s\-]+[A-Za-z]{3}[\s\-]+\d{4}/.test(cols[0])) {
        // Collect numeric values from the row
        const rowVals = cols.slice(1).map(c => parseFloat(c)).filter(n => !isNaN(n));

        // Function to pick strictly the yield (< 20%) from a pair of price & yield
        function pickYield(valA, valB) {
          if (valA !== undefined && valA > 0 && valA < 20) return valA;
          if (valB !== undefined && valB > 0 && valB < 20) return valB;
          return null;
        }

        latestCurve = {
          date: cols[0],
          '6M': rowVals[0] !== undefined ? rowVals[0] : null,
          '1Y': rowVals[1] !== undefined ? rowVals[1] : null,
          '2Y': pickYield(rowVals[2], rowVals[3]),
          '5Y': pickYield(rowVals[4], rowVals[5]),
          '10Y': pickYield(rowVals[6], rowVals[7]),
          '15Y': pickYield(rowVals[8], rowVals[9]),
          '20Y': pickYield(rowVals[10], rowVals[11]),
          '30Y': pickYield(rowVals[12], rowVals[13]),
          '50Y': pickYield(rowVals[14], rowVals[15])
        };
      }
    });

    return latestCurve;
  } catch (err) {
    console.error('Error fetching yield curve:', err.message);
    return null;
  }
}

// 2. Scrape MAS Secondary Market Bonds
async function scrapeMASSecondaryMarket() {
  try {
    const { data } = await axios.get(SECONDARY_MARKET_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    const $ = cheerio.load(data);
    const bonds = [];

    $('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 9) {
        const row = [];
        tds.each((_, td) => {
          row.push($(td).text().replace(/\s+/g, ' ').trim());
        });

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
    console.error('Error scraping secondary market:', err.message);
    return [];
  }
}

// 3. Fetch MAS Primary Issuance Calendar API
function fetchMasApi(targetUrl) {
  return new Promise((resolve, reject) => {
    https.get(encodeURI(targetUrl), (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json?.result?.records || []);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', err => reject(err));
  });
}

// 4. Frontend Application
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#12161a">
  <title>LadderMaker - SGS Issuances, Secondary Market & Yield Curve</title>
  
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
  </style>
</head>
<body>

  <!-- Navbar -->
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

  <!-- Main Content -->
  <main class="section main-container">
    <div class="container">

      <!-- Header Level -->
      <div class="level mb-4">
        <div class="level-left">
          <div>
            <h1 class="title is-4 has-text-light" id="page-title">Singapore Government Securities</h1>
            <p class="subtitle is-6 has-text-grey" id="page-subtitle">Track primary auctions, secondary market prices, and benchmark yield curves</p>
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
            <p class="heading has-text-grey" id="stat-label-1">Total Items</p>
            <p class="title is-4 has-text-light" id="stat-val-1">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-2">Metric 2</p>
            <p class="title is-4 has-text-primary" id="stat-val-2">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-3">Metric 3</p>
            <p class="title is-4 has-text-info" id="stat-val-3">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-4">Metric 4</p>
            <p class="title is-4 has-text-success" id="stat-val-4">0</p>
          </div>
        </div>
      </div>

      <!-- Navigation Tabs & Year Selector -->
      <div class="level mb-3">
        <div class="level-left">
          <div class="tabs is-boxed is-small mb-0" id="category-tabs">
            <ul>
              <li class="is-active" data-type="all"><a><i class="fa-solid fa-list mr-2"></i> All Primary</a></li>
              <li data-type="sgs"><a><i class="fa-solid fa-building-columns mr-2"></i> SGS Bonds</a></li>
              <li data-type="tbill"><a><i class="fa-solid fa-money-bill-trend-up mr-2"></i> T-Bills</a></li>
              <li data-type="ssb"><a><i class="fa-solid fa-piggy-bank mr-2"></i> SSB</a></li>
              <li data-type="secondary"><a><i class="fa-solid fa-chart-line mr-2 has-text-warning"></i> Secondary Market</a></li>
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

      <!-- Search Box (Hidden in Yield Curve view) -->
      <div class="field mb-4" id="search-wrapper">
        <p class="control has-icons-left">
          <input id="search-input" class="input is-rounded is-dark" type="text" placeholder="Search by issue code, ISIN, benchmark, date...">
          <span class="icon is-small is-left"><i class="fas fa-search"></i></span>
        </p>
      </div>

      <!-- Loading Spinner -->
      <div id="status-container" class="has-text-centered py-6">
        <span class="icon is-large has-text-info"><i class="fas fa-2x fa-spinner fa-spin"></i></span>
        <p class="mt-3 has-text-grey" id="status-text">Fetching data from MAS...</p>
      </div>

      <!-- Standard Table Section -->
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
    let currentType = 'all';
    let currentYear = new Date().getFullYear();
    let allRecords = [];
    let displayedRecords = [];
    let yieldCurveData = null;
    let sortColumn = null;
    let sortAsc = true;

    // 1. Initialize PWA
    (function initPWA() {
      const manifest = {
        name: "LadderMaker - SGS Suite",
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

      const isSecondary = currentType === 'secondary';
      const isCurve = currentType === 'curve';

      document.getElementById('year-wrapper').style.visibility = (isSecondary || isCurve) ? 'hidden' : 'visible';
      document.getElementById('search-wrapper').classList.toggle('is-hidden', isCurve);

      try {
        if (isCurve) {
          const res = await axios.get('/api/yield-curve');
          yieldCurveData = res.data;
          renderYieldCurveView();
        } else {
          const endpoint = isSecondary 
            ? '/api/secondary-market'
            : '/api/calendar?type=' + currentType + '&year=' + currentYear;

          const res = await axios.get(endpoint);
          allRecords = res.data || [];
          displayedRecords = [...allRecords];

          document.getElementById('curve-wrapper').classList.add('is-hidden');
          document.getElementById('table-wrapper').classList.remove('is-hidden');

          updateMetrics(isSecondary);
          renderHeaders(isSecondary);
          renderBody(isSecondary);
        }

        showLoading(false);
      } catch (err) {
        showLoading(false);
        document.getElementById('status-container').innerHTML = '<div class="notification is-danger is-light">' + err.message + '</div>';
        document.getElementById('status-container').classList.remove('is-hidden');
      }
    }

    // 3. Render Yield Curve View
    function renderYieldCurveView() {
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
      ].filter(t => t.val !== null && t.val !== undefined);

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

    // Render SVG Yield Curve
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

      // Draw Grid Lines (Y-Axis)
      const gridSteps = 4;
      for (let i = 0; i <= gridSteps; i++) {
        const yVal = minVal + (i / gridSteps) * (maxVal - minVal);
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

      // Draw Area Fill Under Curve
      let areaPathD = 'M ' + getX(0) + ' ' + (padT + chartH) + ' ';
      for (let i = 0; i < tenors.length; i++) {
        areaPathD += 'L ' + getX(i) + ' ' + getY(tenors[i].val) + ' ';
      }
      areaPathD += 'L ' + getX(tenors.length - 1) + ' ' + (padT + chartH) + ' Z';

      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      defs.innerHTML = '<linearGradient id="curveGrad" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#58a6ff" stop-opacity="0.35"/>' +
        '<stop offset="100%" stop-color="#58a6ff" stop-opacity="0.0"/>' +
        '</linearGradient>';
      svg.appendChild(defs);

      const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      area.setAttribute('d', areaPathD);
      area.setAttribute('fill', 'url(#curveGrad)');
      svg.appendChild(area);

      // Draw Curve Line
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

      // Draw Points & Labels
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

    // 4. Update Metrics for Standard Tables
    function updateMetrics(isSecondary) {
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

    // 5. Render Table Headers
    function renderHeaders(isSecondary) {
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
          renderBody(isSecondary);
        };
        row.appendChild(th);
      });
    }

    // 6. Render Table Body
    function renderBody(isSecondary) {
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
            const badgeClass = val === 'SGS Bond' ? 'is-primary' : val === 'T-Bill' ? 'is-info' : 'is-success';
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

    // 7. Navigation Tabs
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
      renderBody(currentType === 'secondary');
    };

    // 8. Refresh & CSV Export
    document.getElementById('btn-refresh').onclick = loadData;

    document.getElementById('btn-export').onclick = () => {
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
      document.getElementById('status-container').classList.toggle('is-hidden', !show);
      if (show) {
        document.getElementById('table-wrapper').classList.add('is-hidden');
        document.getElementById('curve-wrapper').classList.add('is-hidden');
        document.getElementById('empty-state').classList.add('is-hidden');
      }
    }

    loadData();
  </script>
</body>
</html>`;

// 5. Backend HTTP Router
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/api/yield-curve') {
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
      const sgsUrl = `${BASE_MAS_URL}/issuancecalendar?rows=200&filters=issue_type:("B" OR "I" OR "G") AND ann_date:[${startDate} TO ${endDate}]&sort=ann_date asc`;
      const tbillUrl = `${BASE_MAS_URL}/issuancecalendar?rows=200&filters=issue_type:"T" AND ann_date:[${startDate} TO ${endDate}]&sort=ann_date asc`;
      const ssbUrl = `${BASE_MAS_URL}/savingbondsissuancecalendar?rows=200&filters=issue_type:"S" AND ann_date:[${startDate} TO ${endDate}]&sort=ann_date asc`;

      if (type === 'sgs') {
        const sgs = await fetchMasApi(sgsUrl);
        results = sgs.map(r => ({ _category: 'SGS Bond', ...r }));
      } else if (type === 'tbill') {
        const tbills = await fetchMasApi(tbillUrl);
        results = tbills.map(r => ({ _category: 'T-Bill', ...r }));
      } else if (type === 'ssb') {
        const ssb = await fetchMasApi(ssbUrl);
        results = ssb.map(r => ({ _category: 'SSB', ...r }));
      } else {
        const [sgs, tbills, ssb] = await Promise.all([
          fetchMasApi(sgsUrl),
          fetchMasApi(tbillUrl),
          fetchMasApi(ssbUrl),
        ]);

        results = [
          ...sgs.map(r => ({ _category: 'SGS Bond', ...r })),
          ...tbills.map(r => ({ _category: 'T-Bill', ...r })),
          ...ssb.map(r => ({ _category: 'SSB', ...r })),
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