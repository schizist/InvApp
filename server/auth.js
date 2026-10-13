const crypto = require('crypto');
const { db } = require('./db');

const SESSION_DAYS = 30;
const SESSION_COOKIE = 'sid';

function parseCookies(req){
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function setSessionCookie(res, token){
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
}

function clearSessionCookie(res){
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function createSession(userId, cb){
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.run(
    `INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)`,
    [token, userId, now.toISOString(), expires.toISOString()],
    err => cb(err, token)
  );
}

function getSessionUser(req, cb){
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return cb(null, null);
  db.get(
    `SELECT u.id, u.email, u.alias, u.fullName, u.isAdmin, s.expiresAt
     FROM sessions s JOIN users u ON u.id = s.userId
     WHERE s.token = ?`,
    [token],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, null);
      if (row.expiresAt && new Date(row.expiresAt) < new Date()) return cb(null, null);
      cb(null, { id: row.id, email: row.email, alias: row.alias, fullName: row.fullName, isAdmin: !!row.isAdmin });
    }
  );
}

function requireAuth(req, res, next){
  getSessionUser(req, (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Sign-in required' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next){
  requireAuth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// Records who did what, for the admin-only activity log.
function logActivity(user, action, entityType, entityId, summary, details){
  db.run(
    `INSERT INTO activity_log (timestamp, userId, userEmail, userAlias, action, entityType, entityId, summary, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      new Date().toISOString(),
      user ? user.id : null,
      user ? user.email : null,
      user ? user.alias : null,
      action,
      entityType,
      entityId != null ? String(entityId) : null,
      summary,
      details ? JSON.stringify(details) : null
    ],
    err => { if (err) console.error('Failed to write activity log:', err.message); }
  );
}

function registerAuthRoutes(app){
  app.post('/api/auth/login', (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });
    db.get(`SELECT * FROM users WHERE lower(email) = ?`, [email], (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(404).json({ error: 'No user found with that email. Ask an admin to add you under Users.' });
      createSession(user.id, (sessErr, token) => {
        if (sessErr) return res.status(500).json({ error: sessErr.message });
        setSessionCookie(res, token);
        const safeUser = { id: user.id, email: user.email, alias: user.alias, fullName: user.fullName, isAdmin: !!user.isAdmin };
        logActivity(safeUser, 'login', 'user', user.id, `${user.fullName} signed in`);
        res.json(safeUser);
      });
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req)[SESSION_COOKIE];
    clearSessionCookie(res);
    if (!token) return res.json({ ok: true });
    db.run(`DELETE FROM sessions WHERE token = ?`, [token], () => res.json({ ok: true }));
  });

  app.get('/api/auth/me', (req, res) => {
    getSessionUser(req, (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(401).json({ error: 'Not signed in' });
      res.json(user);
    });
  });
}

module.exports = {
  requireAuth,
  requireAdmin,
  logActivity,
  registerAuthRoutes
};
