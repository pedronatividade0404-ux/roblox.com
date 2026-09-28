const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 8775);
const HOST = '127.0.0.1';
const ROOT = __dirname;
const CACHE_TTL = 5 * 60_000;
const STALE_CACHE_TTL = 60 * 60_000;
const cache = new Map();

async function readDotEnv() {
  const envPath = path.join(ROOT, '.env');
  const values = {};

  try {
    const content = await fs.readFile(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const separator = line.indexOf('=');
      if (separator === -1) continue;

      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
  } catch {
  }

  return values;
}

function validUsername(value) {
  return /^[A-Za-z0-9_]{3,20}$/.test(value);
}

async function getLocalSettings() {
  const env = await readDotEnv();
  const username = String(env.ROBLOX_USERNAME || process.env.ROBLOX_USERNAME || 'toxicyofc').trim();
  const initialBalance = Number(env.INITIAL_ROBUX || process.env.INITIAL_ROBUX || 25000);

  return {
    username: validUsername(username) ? username : 'toxicyofc',
    initialBalance: Number.isFinite(initialBalance) && initialBalance >= 0 ? Math.floor(initialBalance) : 25000
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function safeKeyword(value) {
  return String(value || '').trim().replace(/^@/, '').slice(0, 20);
}

async function robloxJson(url, options = {}) {
  const attempts = Number(options.attempts || 2);
  const requestOptions = { ...options };
  delete requestOptions.attempts;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      ...requestOptions,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'RobuxLocalLookup/1.0',
        ...(requestOptions.headers || {})
      }
    });

    if (response.ok) return response.json();

    const error = new Error(`Roblox API returned ${response.status}`);
    error.status = response.status;
    lastError = error;

    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) break;
    await new Promise(resolve => setTimeout(resolve, 400 * attempt));
  }

  throw lastError;
}

async function lookupExactUsername(keyword) {
  const body = JSON.stringify({
    usernames: [keyword],
    excludeBannedUsers: false
  });

  const payload = await robloxJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    body
  });

  return Array.isArray(payload.data) ? payload.data : [];
}

async function searchUsers(keyword) {
  const url = `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(keyword)}&limit=10`;
  const payload = await robloxJson(url);
  return Array.isArray(payload.data) ? payload.data : [];
}

async function getHeadshots(userIds) {
  if (!userIds.length) return new Map();

  const ids = userIds.join(',');
  const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids}&size=150x150&format=Png&isCircular=false`;
  const payload = await robloxJson(url);
  const map = new Map();

  for (const item of payload.data || []) {
    map.set(Number(item.targetId), item.imageUrl || '');
  }

  return map;
}

async function handleUserSearch(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const keyword = safeKeyword(requestUrl.searchParams.get('keyword'));

  if (!/^[A-Za-z0-9_]{3,20}$/.test(keyword)) {
    sendJson(res, 200, { users: [] });
    return;
  }

  const cacheKey = keyword.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    sendJson(res, 200, cached.payload);
    return;
  }

  const warnings = [];
  let exact = [];
  let searched = [];

  try {
    exact = await lookupExactUsername(keyword);
  } catch (error) {
    warnings.push(`exact:${error.status || 'failed'}`);
  }

  try {
    searched = await searchUsers(keyword);
  } catch (error) {
    warnings.push(`search:${error.status || 'failed'}`);
  }

  if (!exact.length && !searched.length && cached && Date.now() - cached.createdAt < STALE_CACHE_TTL) {
    sendJson(res, 200, {
      ...cached.payload,
      stale: true,
      warnings: [...(cached.payload.warnings || []), ...warnings, 'cache:stale']
    });
    return;
  }

  const byId = new Map();
  for (const user of [...exact, ...searched]) {
    if (!user || !user.id || byId.has(Number(user.id))) continue;
    byId.set(Number(user.id), {
      id: Number(user.id),
      name: user.name || user.requestedUsername || '',
      displayName: user.displayName || user.name || user.requestedUsername || '',
      hasVerifiedBadge: Boolean(user.hasVerifiedBadge)
    });
  }

  const users = Array.from(byId.values()).slice(0, 10);
  const headshots = await getHeadshots(users.map(user => user.id)).catch(() => new Map());

  const payload = {
    users: users.map(user => ({
      ...user,
      avatarUrl: headshots.get(user.id) || ''
    })),
    warnings
  };

  cache.set(cacheKey, { createdAt: Date.now(), payload });
  sendJson(res, 200, payload);
}

async function handleLocalUser(req, res) {
  const settings = await getLocalSettings();
  const warnings = [];
  let users = [];

  try {
    users = await lookupExactUsername(settings.username);
  } catch (error) {
    warnings.push(`exact:${error.status || 'failed'}`);
  }

  const user = users.find(item => item.name && item.name.toLowerCase() === settings.username.toLowerCase()) || users[0];
  let avatarUrl = '';

  if (user && user.id) {
    const headshots = await getHeadshots([Number(user.id)]).catch(() => new Map());
    avatarUrl = headshots.get(Number(user.id)) || '';
  }

  sendJson(res, 200, {
    username: user?.name || settings.username,
    displayName: user?.displayName || user?.name || settings.username,
    userId: user?.id || null,
    avatarUrl,
    initialBalance: settings.initialBalance,
    warnings
  });
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const fileName = pathname === '/' || pathname === '/pt/robuxcomprar.html'
    ? 'robuxcomprar.html'
    : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, fileName);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    let content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.html') {
      const env = await readDotEnv();
      const username = String(env.ROBLOX_USERNAME || process.env.ROBLOX_USERNAME || 'toxicyofc').trim();
      const balance = String(env.INITIAL_ROBUX || process.env.INITIAL_ROBUX || '25000');
      let html = content.toString('utf8');
      html = html.replace(/LOCAL_USER_NAME:\s*"[^"]*"/g, `LOCAL_USER_NAME: "${username}"`);
      html = html.replace(/INITIAL_BALANCE:\s*\d+/g, `INITIAL_BALANCE: ${balance}`);
      html = html.replace(/initialBalance:\s*\d+/g, `initialBalance: ${balance}`);
      content = Buffer.from(html, 'utf8');
    }

    const type = ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/local-user')) {
    handleLocalUser(req, res).catch(error => {
      sendJson(res, 500, { error: error.message });
    });
    return;
  }

  if (req.url.startsWith('/api/roblox-users')) {
    handleUserSearch(req, res).catch(error => {
      sendJson(res, 500, { users: [], error: error.message });
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Robux local server running at http://${HOST}:${PORT}/robuxcomprar.html`);
});
