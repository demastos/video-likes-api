// server.js — Express backend: лайки + просмотры
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const origins = ALLOWED_ORIGIN === '*'
  ? true
  : ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({ origin: origins, methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json({ limit: '16kb' }));

// ---------- Хранилище (data.json) ----------
function emptyDb() {
  return { likes: {}, views: {} };
}

function migrateDb(parsed) {
  if (!parsed || typeof parsed !== 'object') return emptyDb();
  if (parsed.likes || parsed.views) {
    return {
      likes: parsed.likes && typeof parsed.likes === 'object' ? parsed.likes : {},
      views: parsed.views && typeof parsed.views === 'object' ? parsed.views : {}
    };
  }

  // Старый формат: { "<video_id>": { count, users: { token: true|false } } }
  const likes = {};
  for (const [videoId, rec] of Object.entries(parsed)) {
    if (!rec || typeof rec !== 'object') continue;
    const users = {};
    for (const [token, liked] of Object.entries(rec.users || {})) {
      if (liked) users[token] = Date.now();
    }
    const likedCount = Object.keys(users).length;
    likes[videoId] = {
      base: Math.max(0, (Number(rec.count) || 0) - likedCount),
      users
    };
  }
  return { likes, views: {} };
}

let db = emptyDb();
try {
  if (fs.existsSync(DATA_FILE)) {
    db = migrateDb(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  }
} catch (e) {
  console.error('Не удалось прочитать data.json, начинаем с нуля:', e.message);
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('Ошибка записи data.json:', e.message);
    }
  }, 200);
}

// ---------- Защита от накруток ----------
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 240;
const hits = new Map();

function rateLimit(req, res, next) {
  const raw = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  const ip = String(raw).split(',')[0].trim();
  const now = Date.now();
  let rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    rec = { count: 0, reset: now + WINDOW_MS };
  }
  rec.count += 1;
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  if (rec.count > MAX_REQUESTS) {
    return res.status(429).json({ error: 'too_many_requests' });
  }
  next();
}
app.use(rateLimit);

function cleanToken(t) {
  if (typeof t !== 'string') return null;
  const v = t.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return v.length >= 8 ? v : null;
}

function cleanVideoId(v) {
  return String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

// ---------- Лайки ----------
// count = base (legacy) + количество пользователей, поставивших лайк
function likesCount(rec) {
  return (rec.base || 0) + Object.keys(rec.users || {}).length;
}

app.get('/api/likes', (req, res) => {
  const videoId = cleanVideoId(req.query.video_id);
  if (!videoId) return res.status(400).json({ error: 'video_id required' });
  const token = cleanToken(req.query.token);
  const rec = db.likes[videoId];
  if (!rec) return res.json({ count: 0, liked: false });
  res.json({
    count: likesCount(rec),
    liked: token ? !!(rec.users || {})[token] : false
  });
});

app.post('/api/likes', (req, res) => {
  const body = req.body || {};
  const videoId = cleanVideoId(body.video_id);
  if (!videoId) return res.status(400).json({ error: 'video_id required' });
  const token = cleanToken(body.token);
  if (!token) return res.status(400).json({ error: 'token required' });

  let rec = db.likes[videoId];
  const isNew = !rec;
  if (!rec) {
    rec = { base: 0, users: {} };
    db.likes[videoId] = rec;
  }
  if (!rec.users) rec.users = {};

  const liked = !!body.liked;
  const clientCount = Number.isFinite(body.count)
    ? Math.max(0, Math.floor(body.count))
    : 0;

  if (isNew) {
    // Первый запрос по этому видео: подхватываем счётчик клиента как базу.
    rec.base = liked ? Math.max(0, clientCount - 1) : clientCount;
  }

  if (liked) rec.users[token] = Date.now();
  else delete rec.users[token];

  save();
  res.json({ count: likesCount(rec), liked: liked });
});

// ---------- Просмотры ----------
app.get('/api/views', (req, res) => {
  const videoId = cleanVideoId(req.query.video_id);
  if (!videoId) return res.status(400).json({ error: 'video_id required' });
  const token = cleanToken(req.query.token);
  const rec = db.views[videoId];
  if (!rec) return res.json({ count: 0, total: 0, viewed: false });
  res.json({
    count: Object.keys(rec.users || {}).length,
    total: rec.total || 0,
    viewed: token ? !!(rec.users || {})[token] : false
  });
});

app.post('/api/views', (req, res) => {
  const body = req.body || {};
  const videoId = cleanVideoId(body.video_id);
  if (!videoId) return res.status(400).json({ error: 'video_id required' });
  const token = cleanToken(body.token);
  if (!token) return res.status(400).json({ error: 'token required' });

  let rec = db.views[videoId];
  if (!rec) {
    rec = { total: 0, users: {} };
    db.views[videoId] = rec;
  }
  if (!rec.users) rec.users = {};

  const firstView = !rec.users[token];
  if (firstView) rec.users[token] = Date.now();
  rec.total = (rec.total || 0) + 1;

  save();
  res.json({
    count: Object.keys(rec.users).length,
    total: rec.total,
    viewed: true,
    first: firstView
  });
});

// ---------- Служебные ----------
function health(_req, res) {
  res.json({ ok: true, likes: Object.keys(db.likes).length, views: Object.keys(db.views).length });
}
app.get('/health', health);
app.get('/api/health', health);

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log('Server listening on port ' + PORT);
});
