/**
 * 24/7 CLOUD UNLIMITED WINGO RECORDER (30s, 1M, 3M, 5M)
 * Zero external npm dependencies — 100% pure Node.js
 * 
 * Runs 24/7 in cloud (Render, Railway, VPS, or laptop)
 * Permanently records EVERY SINGLE WinGo round to unlimited JSON files.
 * NEVER deletes or trims past results (No 500 limit!).
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3098', 10);

// Auto-detect data directory: backend/data/unlimited if in full project, or ./data/unlimited if standalone in cloud
const DATA_DIR = fs.existsSync(path.resolve(__dirname, '..', 'backend', 'data'))
  ? path.resolve(__dirname, '..', 'backend', 'data', 'unlimited')
  : path.resolve(__dirname, 'data', 'unlimited');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const GAMES = {
  WinGo_30S: {
    name: 'WinGo 30S',
    file: path.join(DATA_DIR, 'wingo_30s_unlimited.json'),
    url: 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json',
    intervalMs: 3000,
  },
  WinGo_1M: {
    name: 'WinGo 1M',
    file: path.join(DATA_DIR, 'wingo_1m_unlimited.json'),
    url: 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json',
    intervalMs: 6000,
  },
  WinGo_3M: {
    name: 'WinGo 3M',
    file: path.join(DATA_DIR, 'wingo_3m_unlimited.json'),
    url: 'https://draw.ar-lottery01.com/WinGo/WinGo_3M/GetHistoryIssuePage.json',
    intervalMs: 12000,
  },
  WinGo_5M: {
    name: 'WinGo 5M',
    file: path.join(DATA_DIR, 'wingo_5m_unlimited.json'),
    url: 'https://draw.ar-lottery01.com/WinGo/WinGo_5M/GetHistoryIssuePage.json',
    intervalMs: 15000,
  },
};

// In-memory maps for fast deduplication
const archives = {
  WinGo_30S: new Map(),
  WinGo_1M: new Map(),
  WinGo_3M: new Map(),
  WinGo_5M: new Map(),
};

// Load existing files
for (const [key, cfg] of Object.entries(GAMES)) {
  if (fs.existsSync(cfg.file)) {
    try {
      const data = JSON.parse(fs.readFileSync(cfg.file, 'utf8'));
      if (Array.isArray(data)) {
        for (const r of data) {
          if (r.issueNumber) archives[key].set(r.issueNumber, r);
        }
        console.log(`[Loaded] ${cfg.name}: ${archives[key].size} existing rounds from disk`);
      }
    } catch (e) {
      console.warn(`[Warning] Could not parse ${cfg.file}:`, e.message);
    }
  }
}

function fetchJson(targetUrl) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      parsed.searchParams.set('ts', String(Date.now()));

      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'Origin': 'https://pakgames.top',
          'Referer': 'https://pakgames.top/',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Encoding': 'gzip, deflate',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 9000,
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          try {
            let text = '';
            if (encoding === 'gzip') text = zlib.gunzipSync(buffer).toString('utf8');
            else if (encoding === 'deflate') text = zlib.inflateSync(buffer).toString('utf8');
            else text = buffer.toString('utf8');
            resolve(JSON.parse(text));
          } catch (e) {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    } catch (e) {
      resolve(null);
    }
  });
}

function persistGame(gameKey) {
  try {
    const list = Array.from(archives[gameKey].values());
    list.sort((a, b) => b.issueNumber.localeCompare(a.issueNumber));
    const tmp = `${GAMES[gameKey].file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, GAMES[gameKey].file);
  } catch (err) {
    console.error(`[Error] Persisting ${gameKey}:`, err.message);
  }
}

async function recordGame(gameKey) {
  const cfg = GAMES[gameKey];
  const json = await fetchJson(cfg.url);
  if (!json || json.code !== 0 || !json.data?.list) return;

  let added = 0;
  for (const raw of json.data.list) {
    const issue = String(raw.issueNumber || '').trim();
    const num = parseInt(raw.number, 10);
    if (!issue || isNaN(num)) continue;

    if (!archives[gameKey].has(issue)) {
      const colors = raw.color ? raw.color.split(',').map(c => c.trim().toLowerCase()) : (num % 2 === 0 ? ['red'] : ['green']);
      archives[gameKey].set(issue, {
        issueNumber: issue,
        number: num,
        size: num >= 5 ? 'BIG' : 'SMALL',
        colors,
        premium: raw.premium || String(num),
        sum: raw.sum || 0,
        recordedAt: new Date().toISOString(),
      });
      added++;
    }
  }

  if (added > 0) {
    persistGame(gameKey);
    const total = archives[gameKey].size;
    console.log(`[${new Date().toLocaleTimeString('en-IN')}] ${cfg.name}: +${added} saved | Total Unlimited: ${total}`);
  }
}

// ── HTTP API & DOWNLOAD SERVER ────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Download raw unlimited JSON file
  if (parsed.pathname === '/download') {
    const game = parsed.searchParams.get('game') || 'WinGo_30S';
    if (!GAMES[game]) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Invalid game parameter');
    }
    const list = Array.from(archives[game].values());
    list.sort((a, b) => b.issueNumber.localeCompare(a.issueNumber));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${game.toLowerCase()}_unlimited_history.json"`,
    });
    return res.end(JSON.stringify(list, null, 2));
  }

  // Live status page
  const statusData = {
    service: '24/7 WinGo Unlimited Recorder',
    status: 'ONLINE',
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    totalStored: {
      WinGo_30S: archives.WinGo_30S.size,
      WinGo_1M: archives.WinGo_1M.size,
      WinGo_3M: archives.WinGo_3M.size,
      WinGo_5M: archives.WinGo_5M.size,
    },
    latestIssues: {
      WinGo_30S: Array.from(archives.WinGo_30S.values()).slice(-1)[0]?.issueNumber || null,
      WinGo_1M: Array.from(archives.WinGo_1M.values()).slice(-1)[0]?.issueNumber || null,
      WinGo_3M: Array.from(archives.WinGo_3M.values()).slice(-1)[0]?.issueNumber || null,
      WinGo_5M: Array.from(archives.WinGo_5M.values()).slice(-1)[0]?.issueNumber || null,
    },
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(statusData, null, 2));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log(`🚀 24/7 WinGo Unlimited Recorder Running on port ${PORT}!`);
  console.log(`💾 Data saved permanently to: ${DATA_DIR}`);
  console.log(`📥 Download any game JSON via: http://localhost:${PORT}/download?game=WinGo_30S`);
  console.log('='.repeat(60));

  for (const [key, cfg] of Object.entries(GAMES)) {
    recordGame(key);
    setInterval(() => recordGame(key), cfg.intervalMs);
  }
});
