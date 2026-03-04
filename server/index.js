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

// Serve client static files
app.use('/', express.static(path.join(__dirname, '..', 'client')));

// GET items
app.get('/api/items', (req, res) => {
  db.all(`SELECT id,label,category FROM items ORDER BY label`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
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
        stmt.run(ev.id, ev.itemId, ev.type, ev.qty, ev.timestamp, ev.sessionId || null, ev.note || null, ev.source || 'mobile', function(err) {
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

// GET summary - compute current quantity per item
app.get('/api/summary', (req, res) => {
  db.all(`SELECT id FROM items`, (err, items) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all(`SELECT * FROM events ORDER BY timestamp ASC`, (err2, events) => {
      if (err2) return res.status(500).json({ error: err2.message });

      const map = {};
      items.forEach(it => map[it.id] = { itemId: it.id, qty: 0, lastUpdate: null });

      // For each item, compute as spec: find most recent SET then apply DELTA after it; if no SET, sum DELTA
      const byItem = {};
      items.forEach(it => byItem[it.id] = []);
      events.forEach(ev => {
        if (!byItem[ev.itemId]) byItem[ev.itemId] = [];
        byItem[ev.itemId].push(ev);
      });

      Object.keys(byItem).forEach(itemId => {
        const evs = byItem[itemId] || [];
        if (evs.length === 0) return;
        // find last SET index
        let lastSetIndex = -1;
        for (let i = 0; i < evs.length; i++) {
          if (evs[i].type === 'SET') lastSetIndex = i;
        }
        let qty = 0;
        if (lastSetIndex >= 0) {
          qty = evs[lastSetIndex].qty;
          for (let j = lastSetIndex + 1; j < evs.length; j++) {
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

app.listen(port, () => {
  console.log(`InvApp server listening on http://localhost:${port}`);
});
