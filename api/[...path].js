const CACHE_TTL = 5 * 60_000;
const STALE_CACHE_TTL = 60 * 60_000;
const cache = new Map();

function validUsername(value) {
  return /^[A-Za-z0-9_]{3,20}$/.test(value);
}

function getLocalSettings() {
  const username = String(process.env.ROBLOX_USERNAME || 'toxicyofc').trim();
  const initialBalance = Number(process.env.INITIAL_ROBUX || 25000);

  return {
    username: validUsername(username) ? username : 'toxicyofc',
    initialBalance: Number.isFinite(initialBalance) && initialBalance >= 0
      ? Math.floor(initialBalance)
      : 25000
  };
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
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
        'User-Agent': 'RobuxVercelLookup/1.0',
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
  const payload = await robloxJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    body: JSON.stringify({
      usernames: [keyword],
      excludeBannedUsers: false
    })
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
  const requestUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
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
  const settings = getLocalSettings();
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

module.exports = async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.end();
      return;
    }

    if (pathname === '/api/local-user') {
      await handleLocalUser(req, res);
      return;
    }

    if (pathname === '/api/roblox-users') {
      await handleUserSearch(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { error: error?.message || 'Internal server error' });
  }
};
