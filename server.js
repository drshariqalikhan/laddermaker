const http = require('http');
const https = require('https');
const url = require('url');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3000;
const BASE_MAS_URL = 'https://eservices.mas.gov.sg/statistics/api/v1/bondsandbills/m';
const SECONDARY_MARKET_URL = 'https://eservices.mas.gov.sg/statistics/fdanet/BondPricesAndYields.aspx';

// 1. Scrape MAS Secondary Market Bonds (Using your Cheerio parser)
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

        // Skip header/empty rows
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
    console.error('Error scraping secondary market bonds:', err.message);
    return [];
  }
}

// 2. Fetch MAS Issuance Calendar API
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

// 3. Frontend HTML Template
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#12161a">
  <title>LadderMaker - SGS Secondary Market & Issuances</title>
  
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/bulma.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <script src="https://cdn.jsdelivr.net/npm/axios/dist/axios.min.js"></script>
  <link rel="manifest" id="manifest-placeholder">

  <style>
    body { min-height: 100vh; display: flex; flex-direction: column; background: #0d1117; }
    .main-container { flex: 1; }
    .table-container { border: 1px solid #30363d; border-radius: 8px; overflow-x: auto; background-color: #161b22; }
    .table thead th { cursor: pointer; background-color: #21262d !important; color: #58a6ff !important; border-bottom: 2px solid #30363d; white-space: nowrap; }
    .table thead th:hover { background-color: #30363d !important; }
    .table tbody tr:hover { background-color: rgba(255, 255, 255, 0.04) !important; }
    .summary-card { background-color: #161b22; border: 1px solid #30363d; border-radius: 8px; }
    .monospace { font-family: monospace; }
    .tabs.is-boxed li.is-active a { background-color: #21262d; border-color: #30363d #30363d transparent; color: #58a6ff; font-weight: bold; }
    .tabs.is-boxed a { border-color: transparent; }
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

  <!-- Main Container -->
  <main class="section main-container">
    <div class="container">

      <!-- Title Level -->
      <div class="level mb-4">
        <div class="level-left">
          <div>
            <h1 class="title is-4 has-text-light" id="page-title">Singapore Government Securities</h1>
            <p class="subtitle is-6 has-text-grey" id="page-subtitle">Track primary auctions and secondary market prices & yields</p>
          </div>
        </div>
        <div class="level-right">
          <button id="btn-export" class="button is-small is-dark is-outlined">
            <span class="icon"><i class="fa-solid fa-download"></i></span>
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      <!-- Quick Metrics -->
      <div class="columns is-multiline mb-4" id="metrics-panel">
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey">Securities Listed</p>
            <p class="title is-4 has-text-light" id="stat-total">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-2">SGS Bonds</p>
            <p class="title is-4 has-text-primary" id="stat-val-2">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-3">T-Bills</p>
            <p class="title is-4 has-text-info" id="stat-val-3">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey" id="stat-label-4">SSB Issues</p>
            <p class="title is-4 has-text-success" id="stat-val-4">0</p>
          </div>
        </div>
      </div>

      <!-- Filter Controls: Tabs -->
      <div class="level mb-3">
        <div class="level-left">
          <div class="tabs is-boxed is-small mb-0" id="category-tabs">
            <ul>
              <li class="is-active" data-type="all"><a><i class="fa-solid fa-list mr-2"></i> All Primary</a></li>
              <li data-type="sgs"><a><i class="fa-solid fa-building-columns mr-2"></i> SGS Bonds</a></li>
              <li data-type="tbill"><a><i class="fa-solid fa-money-bill-trend-up mr-2"></i> T-Bills</a></li>
              <li data-type="ssb"><a><i class="fa-solid fa-piggy-bank mr-2"></i> SSB</a></li>
              <li data-type="secondary"><a><i class="fa-solid fa-chart-line mr-2 has-text-warning"></i> Secondary Market</a></li>
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

      <!-- Search Box -->
      <div class="field mb-4">
        <p class="control has-icons-left">
          <input id="search-input" class="input is-rounded is-dark" type="text" placeholder="Search by issue code, ISIN, benchmark, date...">
          <span class="icon is-small is-left"><i class="fas fa-search"></i></span>
        </p>
      </div>

      <!-- Loading Spinner -->
      <div id="status-container" class="has-text-centered py-6">
        <span class="icon is-large has-text-info"><i class="fas fa-2x fa-spinner fa-spin"></i></span>
        <p class="mt-3 has-text-grey" id="status-text">Fetching data from MAS & SGX...</p>
      </div>

      <!-- Table Section -->
      <div id="table-wrapper" class="table-container is-hidden">
        <table class="table is-fullwidth is-hoverable is-narrow">
          <thead><tr id="table-head-row"></tr></thead>
          <tbody id="table-body"></tbody>
        </table>
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
    let sortColumn = null;
    let sortAsc = true;

    // 1. Initialize PWA
    (function initPWA() {
      const manifest = {
        name: "LadderMaker - SGS & Secondary Market",
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
      document.getElementById('year-wrapper').style.visibility = isSecondary ? 'hidden' : 'visible';

      try {
        const endpoint = isSecondary 
          ? '/api/secondary-market'
          : '/api/calendar?type=' + currentType + '&year=' + currentYear;

        const res = await axios.get(endpoint);
        allRecords = res.data || [];
        displayedRecords = [...allRecords];

        updateMetrics(isSecondary);
        renderHeaders(isSecondary);
        renderBody(isSecondary);
        showLoading(false);
      } catch (err) {
        document.getElementById('status-container').innerHTML = '<div class="notification is-danger is-light">' + err.message + '</div>';
      }
    }

    function updateMetrics(isSecondary) {
      document.getElementById('stat-total').textContent = allRecords.length;

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

    // 3. Render Headers
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

    // 4. Render Body
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

    // 5. Tabs & Search
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

    // 6. CSV Export & Refresh
    document.getElementById('btn-refresh').onclick = loadData;

    document.getElementById('btn-export').onclick = () => {
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
      document.getElementById('table-wrapper').classList.toggle('is-hidden', show);
    }

    loadData();
  </script>
</body>
</html>`;

// 4. HTTP Router
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/api/secondary-market') {
    // Calls your Cheerio scraper
    try {
      const bonds = await scrapeMASSecondaryMarket();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bonds));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
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
    // Serve HTML frontend
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_CONTENT);
  }
});

server.listen(PORT, () => {
  console.log(`LadderMaker running on port ${PORT}`);
});