const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Загрузить всё хранилище из файла.
// Структура:
// {
//   "<video_id>": {
//     "count": 42,                      // общее число лайков
//     "users": { "<token>": true|false } // статус по каждому пользователю
//   }
// }
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[storage] Ошибка чтения data.json:', e);
  }
  return {};
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[storage] Ошибка записи data.json:', e);
  }
}

app.use(express.json());

// CORS — обязательно для запросов с Tilda (другой домен).
// В продакшне задайте ALLOWED_ORIGIN=https://your-project.tilda.ws
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Простой in-memory rate limiter: не более 30 запросов в минуту на IP.
// Защищает от накруток и от случайных циклов на клиенте.
const rl = new Map();
function rateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rl.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60000;
  }
  entry.count++;
  rl.set(ip, entry);
  if (entry.count > 30) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

// GET /api/likes?video_id=...&token=...
// Возвращает общее число лайков и статус для конкретного пользователя.
app.get('/api/likes', rateLimit, (req, res) => {
  const videoId = String(req.query.video_id || '').trim();
  if (!videoId) {
    return res.status(400).json({ error: 'video_id required' });
  }

  const data = loadData();
  const entry = data[videoId] || { count: 0, users: {} };
  const token = String(req.query.token || '').trim();
  const liked = token ? !!entry.users[token] : false;

  res.json({ count: entry.count, liked: liked });
});

// POST /api/likes
// body: { video_id, liked, token }
// Сервер сам пересчитывает count, опираясь на users[token].
// Клиенту не нужно присылать count — он авторитетно хранится здесь.
app.post('/api/likes', rateLimit, (req, res) => {
  const body = req.body || {};
  const videoId = typeof body.video_id === 'string' ? body.video_id.trim() : '';
  const liked = body.liked;
  const token = typeof body.token === 'string' ? body.token.trim() : '';

  if (!videoId) {
    return res.status(400).json({ error: 'video_id required' });
  }
  if (typeof liked !== 'boolean') {
    return res.status(400).json({ error: 'liked must be boolean' });
  }
  if (!token || token.length > 128) {
    return res.status(400).json({ error: 'token required (max 128 chars)' });
  }

  const data = loadData();
  if (!data[videoId]) data[videoId] = { count: 0, users: {} };
  const entry = data[videoId];

  const wasLiked = !!entry.users[token];
  if (liked && !wasLiked) entry.count += 1;
  if (!liked && wasLiked) entry.count = Math.max(0, entry.count - 1);
  entry.users[token] = liked;

  saveData(data);
  res.json({ count: entry.count, liked: liked });
});

app.listen(PORT, () => {
  console.log('[likes-api] listening on :' + PORT);
});
