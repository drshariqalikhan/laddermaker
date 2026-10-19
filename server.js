const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const MAS_API_URL = 'https://eservices.mas.gov.sg/statistics/api/v1/bondsandbills/m/savingbondsissuancecalendar';

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#12161a">
  <title>LadderMaker - MAS SSB Calendar</title>
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
      <div class="level mb-4">
        <div class="level-left">
          <div>
            <h1 class="title is-4 has-text-light">Singapore Savings Bonds Issuance Calendar</h1>
            <p class="subtitle is-6 has-text-grey">Live MAS data served directly via your Render backend</p>
          </div>
        </div>
        <div class="level-right">
          <button id="btn-export" class="button is-small is-dark is-outlined">
            <span class="icon"><i class="fa-solid fa-download"></i></span>
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      <div class="columns is-multiline mb-4">
        <div class="column is-4">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey">Total Records</p>
            <p class="title is-4 has-text-light" id="stat-total">-</p>
          </div>
        </div>
        <div class="column is-4">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey">Latest Issue</p>
            <p class="title is-4 has-text-info monospace" id="stat-latest">-</p>
          </div>
        </div>
        <div class="column is-4">
          <div class="box summary-card py-3">
            <p class="heading has-text-grey">Last Updated</p>
            <p class="title is-4 has-text-light" id="stat-updated">-</p>
          </div>
        </div>
      </div>

      <div class="field mb-4">
        <p class="control has-icons-left">
          <input id="search-input" class="input is-rounded is-dark" type="text" placeholder="Search issues, dates...">
          <span class="icon is-small is-left"><i class="fas fa-search"></i></span>
        </p>
      </div>

      <div id="status-container" class="has-text-centered py-6">
        <span class="icon is-large has-text-info"><i class="fas fa-2x fa-spinner fa-spin"></i></span>
        <p class="mt-3 has-text-grey">Fetching data from MAS API...</p>
      </div>

      <div id="table-wrapper" class="table-container is-hidden">
        <table class="table is-fullwidth is-hoverable is-narrow">
          <thead><tr id="table-head-row"></tr></thead>
          <tbody id="table-body"></tbody>
        </table>
      </div>

      <div id="empty-state" class="notification is-dark has-text-centered is-hidden mt-4">
        <i class="fa-solid fa-circle-info mr-2"></i> No matching records found.
      </div>
    </div>
  </main>

  <script>
    let allRecords = [];
    let displayedRecords = [];
    let sortColumn = null;
    let sortAsc = true;

    (function initPWA() {
      const manifest = {
        name: "LadderMaker - MAS SSB",
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
        const swScript = "self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));";
        const swBlob = new Blob([swScript], { type: 'application/javascript' });
        navigator.serviceWorker.register(URL.createObjectURL(swBlob)).catch(() => {});
      }
    })();

    async function loadData() {
      showLoading(true);
      try {
        const res = await axios.get('/api/calendar');
        const payload = res.data;
        allRecords = payload?.result?.records || (Array.isArray(payload) ? payload : Object.values(payload).find(v => Array.isArray(v)) || []);

        displayedRecords = [...allRecords];
        document.getElementById('stat-total').textContent = allRecords.length;
        document.getElementById('stat-updated').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        document.getElementById('stat-latest').textContent = allRecords[0]?.issue_code || allRecords[0]?.issue_name || 'N/A';

        renderHeaders(Object.keys(allRecords[0] || {}));
        renderBody();
        showLoading(false);
      } catch (err) {
        document.getElementById('status-container').innerHTML = '<div class="notification is-danger is-light">' + err.message + '</div>';
      }
    }

    function renderHeaders(keys) {
      const row = document.getElementById('table-head-row');
      row.innerHTML = '';
      keys.forEach(k => {
        const th = document.createElement('th');
        th.textContent = k.replace(/_/g, ' ').toUpperCase();
        th.onclick = () => {
          sortAsc = sortColumn === k ? !sortAsc : true;
          sortColumn = k;
          displayedRecords.sort((a, b) => sortAsc ? String(a[k]).localeCompare(String(b[k])) : String(b[k]).localeCompare(String(a[k])));
          renderBody();
        };
        row.appendChild(th);
      });
    }

    function renderBody() {
      const tbody = document.getElementById('table-body');
      tbody.innerHTML = '';
      if (!displayedRecords.length) {
        document.getElementById('empty-state').classList.remove('is-hidden');
        return;
      }
      document.getElementById('empty-state').classList.add('is-hidden');

      const keys = Object.keys(allRecords[0]);
      displayedRecords.forEach(r => {
        const tr = document.createElement('tr');
        keys.forEach(k => {
          const td = document.createElement('td');
          const val = r[k] ?? '';
          if (k.toLowerCase().includes('status')) {
            td.innerHTML = '<span class="tag is-small ' + (/open/i.test(val) ? 'is-success' : 'is-dark') + '">' + val + '</span>';
          } else {
            td.textContent = val;
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    document.getElementById('search-input').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      displayedRecords = allRecords.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
      renderBody();
    };

    document.getElementById('btn-refresh').onclick = loadData;

    document.getElementById('btn-export').onclick = () => {
      if (!displayedRecords.length) return;
      const headers = Object.keys(displayedRecords[0]);
      const csv = [headers.join(','), ...displayedRecords.map(r => headers.map(h => '"' + (r[h] ?? '') + '"').join(','))].join('\\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'mas_ssb_calendar.csv';
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

const server = http.createServer((req, res) => {
  if (req.url === '/api/calendar') {
    https.get(MAS_API_URL, (apiRes) => {
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
      apiRes.pipe(res);
    }).on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_CONTENT);
  }
});

server.listen(PORT, () => {
  console.log(`LadderMaker running on port ${PORT}`);
});