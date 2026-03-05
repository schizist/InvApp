const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const { db, init } = require('./db');

const app = express();
const port = process.env.PORT || 3000;

init();

app.use(cors());
app.use(bodyParser.json());

// simple request logger to aid debugging
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.path);
  next();
});

// Serve client static files
app.use('/', express.static(path.join(__dirname, '..', 'client')));

// GET items
app.get('/api/items', (req, res) => {
  db.all(`SELECT id,label,category,reorderLevel,reorderQty,unit,packSize FROM items ORDER BY label`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // compute summary and merge
    db.all(`SELECT * FROM events ORDER BY timestamp ASC`, (err2, events) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const byItem = {};
      rows.forEach(r => byItem[r.id] = []);
      events.forEach(ev => { if (!byItem[ev.itemId]) byItem[ev.itemId]=[]; byItem[ev.itemId].push(ev); });
      const out = rows.map(r => {
        const evs = byItem[r.id] || [];
        let qty = 0; let lastUpdate = null;
        // find last COUNT
        let lastCountIndex = -1;
        for (let i=0;i<evs.length;i++){ if (evs[i].type==='COUNT') lastCountIndex = i; }
        if (lastCountIndex >= 0){ qty = evs[lastCountIndex].qty; for (let j=lastCountIndex+1;j<evs.length;j++){ if (evs[j].type==='DELTA') qty += evs[j].qty; } }
        else { evs.forEach(e => { if (e.type==='DELTA') qty += e.qty; }); }
        if (evs.length>0) lastUpdate = evs[evs.length-1].timestamp;
        return Object.assign({}, r, { qty, lastUpdate });
      });
      res.json(out);
    });
  });
});

// POST events (accept array)
app.post('/api/events', (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  let inserted = 0;
  let ignored = 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO events(id,itemId,type,qty,timestamp,sessionId,note,source) VALUES(?,?,?,?,?,?,?,?)`);
  db.serialize(() => {
    events.forEach(ev => {
      try {
        // enforce allowed types
        const t = (ev.type||'').toUpperCase();
        if (t !== 'DELTA' && t !== 'COUNT') { ignored++; return; }
        stmt.run(ev.id, ev.itemId, t, ev.qty, ev.timestamp, ev.sessionId || null, ev.note || null, ev.source || 'mobile', function(err) {
          if (err) ignored++;
          else {
            if (this.changes && this.changes > 0) inserted++;
          }
        });
      } catch (e) {
        ignored++;
      }
    });
    stmt.finalize(() => {
      res.json({ inserted, ignored });
    });
  });
});

// GET events since timestamp
app.get('/api/events', (req, res) => {
  const since = req.query.since;
  if (since) {
    db.all(`SELECT * FROM events WHERE timestamp > ? ORDER BY timestamp ASC`, [since], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  } else {
    db.all(`SELECT * FROM events ORDER BY timestamp ASC`, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }
});

// GET item history and time series
app.get('/api/items/:id/history', (req, res) => {
  const id = req.params.id;
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const params = [id];
  let sql = `SELECT * FROM events WHERE itemId = ? ORDER BY timestamp ASC`;
  if (from && to){ sql = `SELECT * FROM events WHERE itemId = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`; params.push(from.toISOString(), to.toISOString()); }
  else if (from){ sql = `SELECT * FROM events WHERE itemId = ? AND timestamp >= ? ORDER BY timestamp ASC`; params.push(from.toISOString()); }
  else if (to){ sql = `SELECT * FROM events WHERE itemId = ? AND timestamp <= ? ORDER BY timestamp ASC`; params.push(to.toISOString()); }
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // compute running qty and produce daily buckets
    const events = rows;
    // determine range for series
    const start = from ? new Date(from) : (events.length? new Date(events[0].timestamp) : new Date());
    const end = to ? new Date(to) : new Date();
    // normalize start to midnight
    const series = [];
    const dayMs = 24*60*60*1000;
    // iterate days
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= end; d = new Date(d.getTime()+dayMs)){
      const dayEnd = new Date(d.getTime() + dayMs - 1).toISOString();
      // compute qty up to dayEnd
      let qty = 0; let lastCountIndex = -1;
      for (let i=0;i<events.length;i++){ if (events[i].timestamp <= dayEnd && events[i].type==='COUNT') lastCountIndex = i; }
      if (lastCountIndex >= 0){ qty = events[lastCountIndex].qty; for (let j=lastCountIndex+1;j<events.length && events[j].timestamp <= dayEnd;j++){ if (events[j].type==='DELTA') qty += events[j].qty; } }
      else { for (let i=0;i<events.length && events[i].timestamp <= dayEnd;i++){ if (events[i].type==='DELTA') qty += events[i].qty; } }
      series.push({ date: d.toISOString().slice(0,10), qty });
    }
    res.json({ events, series });
  });
});

// GET single item
app.get('/api/items/:id', (req, res) => {
  const id = req.params.id;
  db.get(`SELECT id,label,category,reorderLevel,reorderQty,unit,packSize FROM items WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'not found' });
    db.all(
      `SELECT id,itemId,vendorCompany,contactName,contactEmail,partNumber,price,shippingCost,moq,leadTimeDays,onTimeScore,updatedAt
       FROM vendor_options WHERE itemId = ? ORDER BY onTimeScore DESC, price ASC`,
      [id],
      (vendorErr, vendors) => {
        if (vendorErr) return res.status(500).json({ error: vendorErr.message });
        res.json(Object.assign({}, row, { vendors: vendors || [] }));
      }
    );
  });
});

// Update item fields (partial)
app.put('/api/items/:id', (req, res) => {
  const id = req.params.id;
  const { reorderLevel, reorderQty, label } = req.body || {};
  // build dynamic set
  const sets = [];
  const params = [];
  if (typeof reorderLevel !== 'undefined') { sets.push('reorderLevel = ?'); params.push(reorderLevel); }
  if (typeof reorderQty !== 'undefined') { sets.push('reorderQty = ?'); params.push(reorderQty); }
  if (typeof label !== 'undefined') { sets.push('label = ?'); params.push(label); }
  if (sets.length === 0) return res.status(400).json({ error: 'no fields' });
  params.push(id);
  const sql = `UPDATE items SET ${sets.join(', ')} WHERE id = ?`;
  db.run(sql, params, function(err){
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT id,label,category,reorderLevel,reorderQty,unit,packSize FROM items WHERE id = ?`, [id], (err2, row) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json(row);
    });
  });
});

// GET summary - compute current quantity per item
app.get('/api/summary', (req, res) => {
  db.all(`SELECT id FROM items`, (err, items) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all(`SELECT * FROM events ORDER BY timestamp ASC`, (err2, events) => {
      if (err2) return res.status(500).json({ error: err2.message });

      const map = {};
      items.forEach(it => map[it.id] = { itemId: it.id, qty: 0, lastUpdate: null });

      // For each item, compute as spec: find most recent COUNT then apply DELTA after it; if no COUNT, sum DELTA
      const byItem = {};
      items.forEach(it => byItem[it.id] = []);
      events.forEach(ev => {
        if (!byItem[ev.itemId]) byItem[ev.itemId] = [];
        byItem[ev.itemId].push(ev);
      });

      Object.keys(byItem).forEach(itemId => {
        const evs = byItem[itemId] || [];
        if (evs.length === 0) return;
        // find last COUNT index
        let lastCountIndex = -1;
        for (let i = 0; i < evs.length; i++) {
          if (evs[i].type === 'COUNT') lastCountIndex = i;
        }
        let qty = 0;
        if (lastCountIndex >= 0) {
          qty = evs[lastCountIndex].qty;
          for (let j = lastCountIndex + 1; j < evs.length; j++) {
            if (evs[j].type === 'DELTA') qty += evs[j].qty;
          }
        } else {
          // sum all deltas
          evs.forEach(e => { if (e.type === 'DELTA') qty += e.qty; });
        }
        const last = evs[evs.length - 1];
        map[itemId] = { itemId, qty, lastUpdate: last ? last.timestamp : null };
      });

      res.json(Object.values(map));
    });
  });
});

// Dump registered routes for debugging
function listRoutes(){
  console.log('Registered routes:');
  if (!app._router) return;
  app._router.stack.forEach(m => {
    if (m.route && m.route.path){
      const methods = Object.keys(m.route.methods).map(s=>s.toUpperCase()).join(',');
      console.log(methods, m.route.path);
    } else if (m.name === 'router' && m.handle && m.handle.stack){
      m.handle.stack.forEach(r => { if (r.route && r.route.path){ const methods = Object.keys(r.route.methods).map(s=>s.toUpperCase()).join(','); console.log(methods, r.route.path); } });
    }
  });
}

listRoutes();

app.listen(port, () => {
  console.log(`InvApp server listening on http://localhost:${port}`);
});
