const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const BASE_MAS_URL = 'https://eservices.mas.gov.sg/statistics/api/v1/bondsandbills/m';

// Helper function to query MAS API using native HTTPS
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

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#12161a">
  <title>LadderMaker - SGS, T-Bills & SSB Calendar</title>
  
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

      <!-- Header -->
      <div class="level mb-4">
        <div class="level-left">
          <div>
            <h1 class="title is-4 has-text-light">MAS Issuance Calendar</h1>
            <p class="subtitle is-6 has-text-grey">Track Singapore Government Securities (SGS), Treasury Bills (T-Bills), and Savings Bonds (SSB)</p>
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
      <div class="columns is-multiline mb-4">
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey">Total Issuances</p>
            <p class="title is-4 has-text-light" id="stat-total">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey">SGS Bonds</p>
            <p class="title is-4 has-text-primary" id="stat-sgs">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey">T-Bills</p>
            <p class="title is-4 has-text-info" id="stat-tbill">0</p>
          </div>
        </div>
        <div class="column is-3">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey">Savings Bonds (SSB)</p>
            <p class="title is-4 has-text-success" id="stat-ssb">0</p>
          </div>
        </div>
      </div>

      <!-- Controls: Tabs for Security Types & Year Selector -->
      <div class="level mb-3">
        <div class="level-left">
          <div class="tabs is-boxed is-small mb-0" id="category-tabs">
            <ul>
              <li class="is-active" data-type="all"><a><i class="fa-solid fa-list mr-2"></i> All</a></li>
              <li data-type="sgs"><a><i class="fa-solid fa-building-columns mr-2"></i> SGS Bonds</a></li>
              <li data-type="tbill"><a><i class="fa-solid fa-money-bill-trend-up mr-2"></i> T-Bills</a></li>
              <li data-type="ssb"><a><i class="fa-solid fa-piggy-bank mr-2"></i> SSB</a></li>
            </ul>
          </div>
        </div>
        <div class="level-right">
          <div class="field is-grouped">
            <div class="control">
              <div class="select is-small is-dark">
                <select id="year-select">
                  <!-- Populated by JS -->
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Search Box -->
      <div class="field mb-4">
        <p class="control has-icons-left">
          <input id="search-input" class="input is-rounded is-dark" type="text" placeholder="Search by issue code, date, tenor, ISIN...">
          <span class="icon is-small is-left"><i class="fas fa-search"></i></span>
        </p>
      </div>

      <!-- Loading Spinner -->
      <div id="status-container" class="has-text-centered py-6">
        <span class="icon is-large has-text-info"><i class="fas fa-2x fa-spinner fa-spin"></i></span>
        <p class="mt-3 has-text-grey">Fetching issuance data from MAS...</p>
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
        <i class="fa-solid fa-circle-info mr-2"></i> No matching issuances found for this criteria.
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
        name: "LadderMaker - MAS SGS, T-Bill & SSB",
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

      // Populate year selector: currentYear - 1 up to currentYear + 1
      const yearSelect = document.getElementById('year-select');
      for (let y = currentYear + 1; y >= currentYear - 2; y--) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = 'Year ' + y;
        if (y === currentYear) opt.selected = true;
        yearSelect.appendChild(opt);
      }
    })();

    // 2. Load Data from Backend
    async function loadData() {
      showLoading(true);
      try {
        const res = await axios.get('/api/calendar?type=' + currentType + '&year=' + currentYear);
        allRecords = res.data || [];
        displayedRecords = [...allRecords];

        updateMetrics();
        renderHeaders();
        renderBody();
        showLoading(false);
      } catch (err) {
        document.getElementById('status-container').innerHTML = '<div class="notification is-danger is-light">' + err.message + '</div>';
      }
    }

    function updateMetrics() {
      document.getElementById('stat-total').textContent = allRecords.length;
      document.getElementById('stat-sgs').textContent = allRecords.filter(r => r._category === 'SGS Bond').length;
      document.getElementById('stat-tbill').textContent = allRecords.filter(r => r._category === 'T-Bill').length;
      document.getElementById('stat-ssb').textContent = allRecords.filter(r => r._category === 'SSB').length;
    }

    // 3. Render Table Headers
    const PRIORITY_KEYS = ['_category', 'issue_code', 'ann_date', 'auction_date', 'open_date', 'close_date', 'issue_date', 'maturity_date', 'auction_tenor', 'status'];

    function renderHeaders() {
      const row = document.getElementById('table-head-row');
      row.innerHTML = '';
      if (!allRecords.length) return;

      // Filter keys so _category is first, followed by key dates
      const recordKeys = Object.keys(allRecords[0]);
      const keys = [...new Set([...PRIORITY_KEYS.filter(k => recordKeys.includes(k)), ...recordKeys])];

      keys.forEach(k => {
        const th = document.createElement('th');
        let label = k.replace(/_/g, ' ').toUpperCase();
        if (k === '_category') label = 'SECURITY';
        th.innerHTML = '<span>' + label + '</span> <i class="fa-solid fa-sort ml-1 has-text-grey-dark"></i>';
        
        th.onclick = () => {
          sortAsc = sortColumn === k ? !sortAsc : true;
          sortColumn = k;
          displayedRecords.sort((a, b) => sortAsc ? String(a[k] ?? '').localeCompare(String(b[k] ?? '')) : String(b[k] ?? '').localeCompare(String(a[k] ?? '')));
          renderBody();
        };
        row.appendChild(th);
      });
    }

    // 4. Render Table Body
    function renderBody() {
      const tbody = document.getElementById('table-body');
      tbody.innerHTML = '';
      if (!displayedRecords.length) {
        document.getElementById('empty-state').classList.remove('is-hidden');
        return;
      }
      document.getElementById('empty-state').classList.add('is-hidden');

      const recordKeys = Object.keys(allRecords[0]);
      const keys = [...new Set([...PRIORITY_KEYS.filter(k => recordKeys.includes(k)), ...recordKeys])];

      displayedRecords.forEach(r => {
        const tr = document.createElement('tr');
        keys.forEach(k => {
          const td = document.createElement('td');
          const val = r[k] ?? '';

          if (k === '_category') {
            const badgeClass = val === 'SGS Bond' ? 'is-primary' : val === 'T-Bill' ? 'is-info' : 'is-success';
            td.innerHTML = '<span class="tag is-small ' + badgeClass + '">' + val + '</span>';
          } else if (k.toLowerCase().includes('status')) {
            const isClosed = /closed|ended/i.test(val);
            const isOpen = /open|upcoming/i.test(val);
            const tagClass = isOpen ? 'is-success' : isClosed ? 'is-dark' : 'is-info';
            td.innerHTML = '<span class="tag is-small ' + tagClass + '">' + (val || 'UPCOMING') + '</span>';
          } else if (k.toLowerCase().includes('code')) {
            td.innerHTML = '<span class="monospace has-text-info-light">' + val + '</span>';
          } else {
            td.textContent = val;
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    // 5. Tabs & Year Filter Listeners
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

    // 6. Search Filter
    document.getElementById('search-input').oninput = (e) => {
      const q = e.target.value.toLowerCase().trim();
      displayedRecords = allRecords.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
      renderBody();
    };

    // 7. Refresh & Export
    document.getElementById('btn-refresh').onclick = loadData;

    document.getElementById('btn-export').onclick = () => {
      if (!displayedRecords.length) return;
      const headers = Object.keys(displayedRecords[0]);
      const csv = [headers.join(','), ...displayedRecords.map(r => headers.map(h => '"' + (r[h] ?? '') + '"').join(','))].join('\\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'mas_issuances_' + currentType + '_' + currentYear + '.csv';
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

// Node.js Backend Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/api/calendar') {
    const type = parsedUrl.query.type || 'all';
    const year = parsedUrl.query.year || new Date().getFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    try {
      let results = [];

      // SGS Bonds URL: issue_type:("B" OR "I" OR "G")
      const sgsUrl = `${BASE_MAS_URL}/issuancecalendar?rows=200&filters=issue_type:("B" OR "I" OR "G") AND ann_date:[${startDate} TO ${endDate}]&sort=ann_date asc`;

      // T-Bills URL: issue_type:"T"
      const tbillUrl = `${BASE_MAS_URL}/issuancecalendar?rows=200&filters=issue_type:"T" AND ann_date:[${startDate} TO ${endDate}]&sort=ann_date asc`;

      // Singapore Savings Bonds URL: issue_type:"S"
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
        // Fetch ALL concurrently in parallel
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

        // Sort combined list chronologically by announcement date
        results.sort((a, b) => String(a.ann_date || '').localeCompare(String(b.ann_date || '')));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    // Serve Frontend
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_CONTENT);
  }
});

server.listen(PORT, () => {
  console.log(`LadderMaker running on port ${PORT}`);
});