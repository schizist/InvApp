require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const {
  db,
  init,
  listDatabases,
  getCurrentDatabaseName,
  switchDatabase,
  createDatabase
} = require('./db');

const reorder = require('./reorder');

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

const ORDER_STATUSES = new Set(['draft', 'ordered', 'partially_received', 'received', 'cancelled']);
const ORDER_LINE_STATUSES = new Set(['pending', 'partially_received', 'complete', 'cancelled']);

function normalizeNumber(value){
  if (value === null || value === '' || typeof value === 'undefined') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOrderPayload(body, existing){
  const now = new Date().toISOString();
  return {
    id: String(body.id || (existing && existing.id) || '').trim(),
    poNumber: String(body.poNumber || (existing && existing.poNumber) || '').trim(),
    generatedPoNumber: body.generatedPoNumber ? 1 : 0,
    clientName: (body.clientName || '').trim() || null,
    jobName: (body.jobName || '').trim() || null,
    orderDate: String(body.orderDate || '').trim(),
    vendorName: String(body.vendorName || '').trim(),
    vendorContactName: (body.vendorContactName || '').trim() || null,
    vendorEmail: (body.vendorEmail || '').trim() || null,
    vendorPhone: (body.vendorPhone || '').trim() || null,
    orderedBy: (body.orderedBy || '').trim() || null,
    enteredBy: (body.enteredBy || '').trim() || null,
    status: ORDER_STATUSES.has(body.status) ? body.status : ((existing && existing.status) || 'draft'),
    notes: (body.notes || '').trim() || null,
    createdAt: body.createdAt || (existing && existing.createdAt) || now,
    updatedAt: body.updatedAt || now
  };
}

function generateId(){
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generatedPoForDate(orderDate, cb){
  const day = String(orderDate || new Date().toISOString().slice(0,10)).replace(/-/g, '');
  const prefix = `PO-${day}-`;
  db.all(`SELECT poNumber FROM orders WHERE poNumber LIKE ?`, [prefix + '%'], (err, rows) => {
    if (err) return cb(err);
    const max = (rows || []).reduce((m, row) => {
      const match = String(row.poNumber || '').match(/-(\d+)$/);
      return match ? Math.max(m, Number(match[1]) || 0) : m;
    }, 0);
    cb(null, `${prefix}${String(max + 1).padStart(3, '0')}`);
  });
}

function readOrder(id, cb){
  db.get(`SELECT * FROM orders WHERE id = ?`, [id], (err, order) => {
    if (err || !order) return cb(err, order || null);
    db.all(`SELECT * FROM order_lines WHERE orderId = ? ORDER BY sortOrder ASC, description ASC`, [id], (lineErr, lines) => {
      if (lineErr) return cb(lineErr);
      db.all(`SELECT * FROM order_receipts WHERE orderId = ? ORDER BY receivedDate ASC, createdAt ASC`, [id], (receiptErr, receipts) => {
        if (receiptErr) return cb(receiptErr);
        cb(null, decorateOrder(order, lines || [], receipts || []));
      });
    });
  });
}

function decorateOrder(order, lines, receipts){
  const byLine = {};
  receipts.forEach(r => {
    byLine[r.orderLineId] = byLine[r.orderLineId] || [];
    byLine[r.orderLineId].push(r);
  });
  let totalOrdered = 0;
  let totalReceived = 0;
  const decoratedLines = lines.map(line => {
    const lineReceipts = byLine[line.id] || [];
    const quantityReceived = lineReceipts.reduce((sum, r) => sum + (Number(r.quantityReceived) || 0), 0);
    const quantityOrdered = Number(line.quantityOrdered) || 0;
    const storedStatus = ORDER_LINE_STATUSES.has(line.status) ? line.status : 'pending';
    const lineStatus = storedStatus === 'cancelled'
      ? 'cancelled'
      : (quantityOrdered > 0 && quantityReceived >= quantityOrdered)
        ? 'complete'
        : quantityReceived > 0
          ? 'partially_received'
          : 'pending';
    totalOrdered += quantityOrdered;
    totalReceived += Math.min(quantityOrdered, quantityReceived);
    return Object.assign({}, line, {
      quantityReceived,
      remainder: quantityOrdered - quantityReceived,
      status: lineStatus,
      receipts: lineReceipts
    });
  });
  const activeLines = decoratedLines.filter(line => line.status !== 'cancelled');
  const computedStatus = order.status === 'draft' || order.status === 'cancelled'
    ? order.status
    : !activeLines.length
      ? 'ordered'
      : activeLines.every(line => (Number(line.quantityReceived) || 0) >= (Number(line.quantityOrdered) || 0))
        ? 'received'
        : activeLines.some(line => (Number(line.quantityReceived) || 0) > 0)
          ? 'partially_received'
          : 'ordered';
  return Object.assign({}, order, {
    generatedPoNumber: !!order.generatedPoNumber,
    status: computedStatus,
    lines: decoratedLines,
    receipts,
    progress: { ordered: totalOrdered, received: totalReceived }
  });
}

function computeOrderStatus(orderId, fallbackStatus, cb){
  if (fallbackStatus === 'draft' || fallbackStatus === 'cancelled') return cb(null, fallbackStatus);
  db.all(`
    SELECT l.id, l.quantityOrdered, l.status, COALESCE(SUM(r.quantityReceived), 0) AS quantityReceived
    FROM order_lines l
    LEFT JOIN order_receipts r ON r.orderLineId = l.id
    WHERE l.orderId = ?
    GROUP BY l.id
  `, [orderId], (err, rows) => {
    if (err) return cb(err);
    const activeRows = (rows || []).filter(r => r.status !== 'cancelled');
    if (activeRows.length === 0) return cb(null, 'ordered');
    const anyReceived = activeRows.some(r => (Number(r.quantityReceived) || 0) > 0);
    const allComplete = activeRows.every(r => (Number(r.quantityOrdered) || 0) > 0 && (Number(r.quantityReceived) || 0) >= (Number(r.quantityOrdered) || 0));
    if (allComplete) return cb(null, 'received');
    if (anyReceived) return cb(null, 'partially_received');
    cb(null, 'ordered');
  });
}

function updateOrderStatus(orderId, cb){
  db.get(`SELECT status FROM orders WHERE id = ?`, [orderId], (err, order) => {
    if (err || !order) return cb && cb(err);
    computeOrderStatus(orderId, order.status, (statusErr, nextStatus) => {
      if (statusErr) return cb && cb(statusErr);
      db.run(`UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?`, [nextStatus, new Date().toISOString(), orderId], runErr => {
        if (cb) cb(runErr, nextStatus);
      });
    });
  });
}

function escapeHtml(value){
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderOrderSheet(order){
  const noteRows = [];
  const rows = (order.lines || []).map(line => {
    const receipts = (line.receipts || []).slice(0, 3);
    const extra = (line.receipts || []).slice(3);
    if (line.notes) noteRows.push(`<p><strong>${escapeHtml(line.description)}:</strong> ${escapeHtml(line.notes)}</p>`);
    if (extra.length) {
      noteRows.push(`<p><strong>${escapeHtml(line.description)} additional receipts:</strong> ${extra.map(r => `${escapeHtml(r.quantityReceived)} on ${escapeHtml(r.receivedDate)}`).join(', ')}</p>`);
    }
    const cells = [0,1,2].map(i => {
      const receipt = receipts[i];
      return `<td>${receipt ? escapeHtml(receipt.quantityReceived) : ''}</td><td>${receipt ? escapeHtml(receipt.receivedDate) : ''}</td>`;
    }).join('');
    return `
      <tr>
        <td>${escapeHtml(line.quantityOrdered)}</td>
        <td>${escapeHtml(line.description)}</td>
        ${cells}
        <td>${escapeHtml(line.remainder)}</td>
        <td>${escapeHtml(String(line.status || '').replace('_', ' '))}</td>
      </tr>
    `;
  }).join('');
  if (order.notes) noteRows.unshift(`<p><strong>Order notes:</strong> ${escapeHtml(order.notes)}</p>`);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Order Sheet ${escapeHtml(order.poNumber)}</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;margin:28px;color:#111}
    .top{display:grid;grid-template-columns:120px 1fr;gap:18px;align-items:start}
    .logo{height:84px;border:1px solid #ddd;display:flex;align-items:center;justify-content:center}
    .logo img{max-width:72px;max-height:72px}
    h1{text-align:center;margin:0 0 18px 0;letter-spacing:1px}
    .header{display:grid;grid-template-columns:170px 1fr 150px 1fr;gap:8px 10px;margin-bottom:18px}
    .label{font-weight:bold}
    table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #111;padding:7px;vertical-align:top}
    th{font-size:12px;background:#f1f1f1}
    .notes{margin-top:18px}
    @media print{body{margin:12mm}.noPrint{display:none}}
  </style>
</head>
<body>
  <button class="noPrint" onclick="window.print()">Print</button>
  <div class="top">
    <div class="logo"><img src="/favicon-32x32.png" onerror="this.style.display='none'" alt=""></div>
    <div>
      <h1>ORDER STATUS</h1>
      <div class="header">
        <div class="label">CONTRACTOR / CLIENT:</div><div>${escapeHtml(order.clientName)}</div>
        <div class="label">STATUS:</div><div>${escapeHtml(order.status)}</div>
        <div class="label">PO / JOB:</div><div>${escapeHtml(order.poNumber)}${order.jobName ? ' / ' + escapeHtml(order.jobName) : ''}</div>
        <div class="label">ORDER DATE:</div><div>${escapeHtml(order.orderDate)}</div>
        <div class="label">ORDERED FROM:</div><div>${escapeHtml(order.vendorName)}</div>
        <div class="label">ORDERED BY:</div><div>${escapeHtml(order.orderedBy)}</div>
        <div class="label">ENTERED BY:</div><div>${escapeHtml(order.enteredBy)}</div>
      </div>
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>NO. ORDERED</th><th>DESCRIPTION</th>
        <th>NO. ARRIVED</th><th>DATE</th>
        <th>NO. ARRIVED</th><th>DATE</th>
        <th>NO. ARRIVED</th><th>DATE</th>
        <th>REMAINDER</th><th>STATUS</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="10">No line items</td></tr>'}</tbody>
  </table>
  ${noteRows.length ? `<div class="notes"><h2>Notes</h2>${noteRows.join('')}</div>` : ''}
</body>
</html>`;
}

// List databases and current selection
app.get('/api/databases', (_req, res) => {
  try{
    res.json({
      current: getCurrentDatabaseName(),
      databases: listDatabases()
    });
  }catch(err){
    res.status(500).json({ error: err.message });
  }
});

// Create and switch to a new database
app.post('/api/databases', (req, res) => {
  try{
    const name = (req.body && req.body.name) ? String(req.body.name) : '';
    const current = createDatabase(name);
    res.status(201).json({
      current,
      databases: listDatabases()
    });
  }catch(err){
    res.status(400).json({ error: err.message });
  }
});

// Switch active database
app.put('/api/databases/current', (req, res) => {
  try{
    const name = (req.body && req.body.name) ? String(req.body.name) : '';
    const current = switchDatabase(name);
    res.json({
      current,
      databases: listDatabases()
    });
  }catch(err){
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/orders', (_req, res) => {
  db.all(`SELECT * FROM orders ORDER BY orderDate DESC, updatedAt DESC`, (err, orders) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all(`SELECT * FROM order_lines`, (lineErr, lines) => {
      if (lineErr) return res.status(500).json({ error: lineErr.message });
      db.all(`SELECT * FROM order_receipts`, (receiptErr, receipts) => {
        if (receiptErr) return res.status(500).json({ error: receiptErr.message });
        const byOrderLine = {};
        (lines || []).forEach(line => {
          byOrderLine[line.orderId] = byOrderLine[line.orderId] || [];
          byOrderLine[line.orderId].push(line);
        });
        const byOrderReceipt = {};
        (receipts || []).forEach(receipt => {
          byOrderReceipt[receipt.orderId] = byOrderReceipt[receipt.orderId] || [];
          byOrderReceipt[receipt.orderId].push(receipt);
        });
        res.json((orders || []).map(order => decorateOrder(order, byOrderLine[order.id] || [], byOrderReceipt[order.id] || [])));
      });
    });
  });
});

app.get('/api/orders/:id', (req, res) => {
  readOrder(req.params.id, (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'not found' });
    res.json(order);
  });
});

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const id = String(body.id || generateId());
  const input = Object.assign({}, body, { id });
  const finish = (poNumber, generatedPoNumber) => {
    const order = normalizeOrderPayload(Object.assign({}, input, { poNumber, generatedPoNumber }), null);
    if (!order.orderDate) return res.status(400).json({ error: 'orderDate is required' });
    if (!order.vendorName) return res.status(400).json({ error: 'vendorName is required' });
    db.run(`
      INSERT INTO orders (
        id, poNumber, generatedPoNumber, clientName, jobName, orderDate, vendorName,
        vendorContactName, vendorEmail, vendorPhone, orderedBy, enteredBy, status, notes, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        poNumber = excluded.poNumber,
        generatedPoNumber = excluded.generatedPoNumber,
        clientName = excluded.clientName,
        jobName = excluded.jobName,
        orderDate = excluded.orderDate,
        vendorName = excluded.vendorName,
        vendorContactName = excluded.vendorContactName,
        vendorEmail = excluded.vendorEmail,
        vendorPhone = excluded.vendorPhone,
        orderedBy = excluded.orderedBy,
        enteredBy = excluded.enteredBy,
        status = excluded.status,
        notes = excluded.notes,
        updatedAt = excluded.updatedAt
    `, [
      order.id, order.poNumber, order.generatedPoNumber, order.clientName, order.jobName, order.orderDate, order.vendorName,
      order.vendorContactName, order.vendorEmail, order.vendorPhone, order.orderedBy, order.enteredBy, order.status, order.notes, order.createdAt, order.updatedAt
    ], err => {
      if (err) return res.status(400).json({ error: err.message });
      readOrder(order.id, (readErr, saved) => {
        if (readErr) return res.status(500).json({ error: readErr.message });
        res.status(201).json(saved);
      });
    });
  };
  if (String(body.poNumber || '').trim()) return finish(String(body.poNumber).trim(), !!body.generatedPoNumber);
  generatedPoForDate(body.orderDate || new Date().toISOString().slice(0,10), (err, poNumber) => {
    if (err) return res.status(500).json({ error: err.message });
    finish(poNumber, true);
  });
});

app.put('/api/orders/:id', (req, res) => {
  db.get(`SELECT * FROM orders WHERE id = ?`, [req.params.id], (findErr, existing) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!existing) return res.status(404).json({ error: 'not found' });
    const order = normalizeOrderPayload(Object.assign({}, req.body || {}, { id: req.params.id }), existing);
    if (!order.poNumber) return res.status(400).json({ error: 'poNumber is required' });
    if (!order.orderDate) return res.status(400).json({ error: 'orderDate is required' });
    if (!order.vendorName) return res.status(400).json({ error: 'vendorName is required' });
    db.run(`
      UPDATE orders SET
        poNumber = ?, generatedPoNumber = ?, clientName = ?, jobName = ?, orderDate = ?,
        vendorName = ?, vendorContactName = ?, vendorEmail = ?, vendorPhone = ?,
        orderedBy = ?, enteredBy = ?, status = ?, notes = ?, updatedAt = ?
      WHERE id = ?
    `, [
      order.poNumber, order.generatedPoNumber, order.clientName, order.jobName, order.orderDate,
      order.vendorName, order.vendorContactName, order.vendorEmail, order.vendorPhone,
      order.orderedBy, order.enteredBy, order.status, order.notes, order.updatedAt, order.id
    ], err => {
      if (err) return res.status(400).json({ error: err.message });
      updateOrderStatus(order.id, () => {
        readOrder(order.id, (readErr, saved) => {
          if (readErr) return res.status(500).json({ error: readErr.message });
          res.json(saved);
        });
      });
    });
  });
});

app.delete('/api/orders/:id', (req, res) => {
  const orderId = req.params.id;
  db.get(`SELECT id FROM orders WHERE id = ?`, [orderId], (findErr, existing) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!existing) return res.status(404).json({ error: 'not found' });
    db.serialize(() => {
      db.run(`DELETE FROM events WHERE orderId = ? AND source = 'order_receipt'`, [orderId], eventErr => {
        if (eventErr) return res.status(500).json({ error: eventErr.message });
        db.run(`DELETE FROM order_receipts WHERE orderId = ?`, [orderId], receiptErr => {
          if (receiptErr) return res.status(500).json({ error: receiptErr.message });
          db.run(`DELETE FROM order_lines WHERE orderId = ?`, [orderId], lineErr => {
            if (lineErr) return res.status(500).json({ error: lineErr.message });
            db.run(`DELETE FROM orders WHERE id = ?`, [orderId], function(orderErr){
              if (orderErr) return res.status(500).json({ error: orderErr.message });
              res.json({ deleted: this.changes || 0 });
            });
          });
        });
      });
    });
  });
});

function upsertOrderLine(body, orderId, res, statusCode){
  const quantityOrdered = normalizeNumber(body.quantityOrdered);
  if (!quantityOrdered || quantityOrdered <= 0) return res.status(400).json({ error: 'quantityOrdered must be positive' });
  if (!Number.isInteger(quantityOrdered)) return res.status(400).json({ error: 'quantityOrdered must be a whole number' });
  const description = String(body.description || '').trim();
  if (!description) return res.status(400).json({ error: 'description is required' });
  const lineTotal = typeof body.lineTotal !== 'undefined' ? normalizeNumber(body.lineTotal) : (() => {
    const cost = normalizeNumber(body.unitCost);
    return cost == null ? null : cost * quantityOrdered;
  })();
  const status = ORDER_LINE_STATUSES.has(body.status) ? body.status : 'pending';
  db.run(`
    INSERT INTO order_lines (
      id, orderId, itemId, description, quantityOrdered, unit, vendorItemNumber,
      manufacturerPartNumber, unitCost, lineTotal, status, notes, sortOrder
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      itemId = excluded.itemId,
      description = excluded.description,
      quantityOrdered = excluded.quantityOrdered,
      unit = excluded.unit,
      vendorItemNumber = excluded.vendorItemNumber,
      manufacturerPartNumber = excluded.manufacturerPartNumber,
      unitCost = excluded.unitCost,
      lineTotal = excluded.lineTotal,
      status = excluded.status,
      notes = excluded.notes,
      sortOrder = excluded.sortOrder
  `, [
    body.id || generateId(),
    orderId,
    body.itemId || null,
    description,
    quantityOrdered,
    body.unit || null,
    body.vendorItemNumber || null,
    body.manufacturerPartNumber || null,
    normalizeNumber(body.unitCost),
    lineTotal,
    status,
    body.notes || null,
    Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0
  ], err => {
    if (err) return res.status(400).json({ error: err.message });
    updateOrderStatus(orderId, () => {
      readOrder(orderId, (readErr, order) => {
        if (readErr) return res.status(500).json({ error: readErr.message });
        res.status(statusCode).json(order);
      });
    });
  });
}

function createInventoryEventForReceipt(line, receipt, cb){
  if (!line.itemId) return cb && cb(null);
  db.get(`SELECT category, packSize FROM items WHERE id = ?`, [line.itemId], (itemErr, item) => {
    if (itemErr) return cb && cb(itemErr);
    const category = item && item.category ? String(item.category).toLowerCase() : '';
    const multiplier = category === 'wire' ? 500 : (Number(item && item.packSize) > 0 ? Number(item.packSize) : 1);
    const eventId = `order-receipt-${receipt.id}`;
    db.run(
      `INSERT OR IGNORE INTO events(id,itemId,type,qty,timestamp,sessionId,note,source,orderId,orderLineId,receiptId)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        eventId,
        line.itemId,
        'DELTA',
        receipt.quantityReceived * multiplier,
        receipt.createdAt,
        null,
        `Received ${receipt.quantityReceived} ${line.unit || 'units'} on order ${receipt.orderId}`,
        'order_receipt',
        receipt.orderId,
        receipt.orderLineId,
        receipt.id
      ],
      err => cb && cb(err)
    );
  });
}

app.post('/api/orders/:id/lines', (req, res) => {
  db.get(`SELECT id FROM orders WHERE id = ?`, [req.params.id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'order not found' });
    upsertOrderLine(req.body || {}, req.params.id, res, 201);
  });
});

app.put('/api/order-lines/:id', (req, res) => {
  db.get(`SELECT * FROM order_lines WHERE id = ?`, [req.params.id], (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!existing) return res.status(404).json({ error: 'not found' });
    upsertOrderLine(Object.assign({}, existing, req.body || {}, { id: req.params.id }), existing.orderId, res, 200);
  });
});

app.delete('/api/order-lines/:id', (req, res) => {
  db.get(`SELECT * FROM order_lines WHERE id = ?`, [req.params.id], (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!existing) return res.json({ deleted: 0 });
    db.get(`SELECT COUNT(*) AS receiptCount FROM order_receipts WHERE orderLineId = ?`, [req.params.id], (countErr, row) => {
      if (countErr) return res.status(500).json({ error: countErr.message });
      if ((row && row.receiptCount) > 0) return res.status(400).json({ error: 'cannot delete a line with receipt history' });
      db.run(`DELETE FROM order_lines WHERE id = ?`, [req.params.id], deleteErr => {
        if (deleteErr) return res.status(500).json({ error: deleteErr.message });
        updateOrderStatus(existing.orderId, () => res.json({ deleted: 1, orderId: existing.orderId }));
      });
    });
  });
});

app.post('/api/order-lines/:id/receipts', (req, res) => {
  db.get(`SELECT * FROM order_lines WHERE id = ?`, [req.params.id], (lineErr, line) => {
    if (lineErr) return res.status(500).json({ error: lineErr.message });
    if (!line) return res.status(404).json({ error: 'line not found' });
    const qty = normalizeNumber(req.body && req.body.quantityReceived);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'quantityReceived must be positive' });
    if (!Number.isInteger(qty)) return res.status(400).json({ error: 'quantityReceived must be a whole number' });
    const id = (req.body && req.body.id) || generateId();
    const receivedDate = (req.body && req.body.receivedDate) || new Date().toISOString().slice(0,10);
    const createdAt = (req.body && req.body.createdAt) || new Date().toISOString();
    const receipt = {
      id,
      orderId: line.orderId,
      orderLineId: line.id,
      quantityReceived: qty,
      receivedDate,
      receivedBy: (req.body && req.body.receivedBy) || null,
      note: (req.body && req.body.note) || null,
      createdAt
    };
    db.run(`
      INSERT OR IGNORE INTO order_receipts (
        id, orderId, orderLineId, quantityReceived, receivedDate, receivedBy, note, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      receipt.id, receipt.orderId, receipt.orderLineId, receipt.quantityReceived, receipt.receivedDate,
      receipt.receivedBy, receipt.note, receipt.createdAt
    ], err => {
      if (err) return res.status(400).json({ error: err.message });
      const addToInventory = !!(req.body && req.body.addToInventory);
      const finishReceipt = () => {
        updateOrderStatus(line.orderId, () => {
          readOrder(line.orderId, (readErr, order) => {
            if (readErr) return res.status(500).json({ error: readErr.message });
            res.status(201).json(order);
          });
        });
      };
      if (!addToInventory) return finishReceipt();
      createInventoryEventForReceipt(line, receipt, eventErr => {
        if (eventErr) return res.status(500).json({ error: eventErr.message });
        finishReceipt();
      });
    });
  });
});

app.get('/api/orders/:id/sheet', (req, res) => {
  readOrder(req.params.id, (err, order) => {
    if (err) return res.status(500).send(err.message);
    if (!order) return res.status(404).send('not found');
    res.type('html').send(renderOrderSheet(order));
  });
});

// GET items
app.get('/api/items', (req, res) => {
  db.all(`SELECT id,label,category,reorderLevel,reorderQty,unit,packSize,salePrice,primaryVendorId,altVendorId,muted FROM items ORDER BY label`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // compute summary and merge
    db.all(`SELECT * FROM events ORDER BY timestamp ASC`, (err2, events) => {
      if (err2) return res.status(500).json({ error: err2.message });
      reorder.getOnOrderItemIds(db).then(onOrderIds => {
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
          return Object.assign({}, r, { muted: !!r.muted, onOrder: onOrderIds.has(r.id), qty, lastUpdate });
        });
        res.json(out);
      }).catch(onOrderErr => res.status(500).json({ error: onOrderErr.message }));
    });
  });
});

// POST items — create a new catalog item
app.post('/api/items', (req, res) => {
  const { label, category, unit, packSize } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required' });
  const cleanLabel = String(label).trim();
  const cat = (category || 'other').toLowerCase();
  const slug = cleanLabel.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '').toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Label must contain at least one letter, number, underscore, or hyphen.' });
  const id = `${cat}_${slug}`;
  db.run(
    `INSERT INTO items (id, label, category, unit, packSize) VALUES (?, ?, ?, ?, ?)`,
    [id, cleanLabel, cat, unit || null, packSize ? Number(packSize) : null],
    function(err) {
      if (err) {
        const msg = err.message || String(err);
        console.error('POST /api/items insert error:', msg);
        if (msg.toLowerCase().includes('unique')) return res.status(409).json({ error: 'An item with that label already exists in this category.' });
        return res.status(500).json({ error: msg || 'Database error' });
      }
      db.get(`SELECT id,label,category,reorderLevel,reorderQty,unit,packSize,salePrice,primaryVendorId,altVendorId,muted FROM items WHERE id = ?`, [id], (err2, row) => {
        if (err2) { console.error('POST /api/items select error:', err2.message); return res.status(500).json({ error: err2.message }); }
        if (!row) return res.status(500).json({ error: 'Item created but could not be retrieved (id: ' + id + ')' });
        res.status(201).json(Object.assign({}, row, { muted: !!row.muted }));
      });
    }
  );
});

// POST events (accept array)
app.post('/api/events', (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  let inserted = 0;
  let ignored = 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO events(id,itemId,type,qty,timestamp,sessionId,note,source,orderId,orderLineId,receiptId) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  db.serialize(() => {
    events.forEach(ev => {
      try {
        // enforce allowed types
        const t = (ev.type||'').toUpperCase();
        if (t !== 'DELTA' && t !== 'COUNT') { ignored++; return; }
        const qty = normalizeNumber(ev.qty);
        if (qty == null || !Number.isInteger(qty)) { ignored++; return; }
        stmt.run(ev.id, ev.itemId, t, qty, ev.timestamp, ev.sessionId || null, ev.note || null, ev.source || 'mobile', ev.orderId || null, ev.orderLineId || null, ev.receiptId || null, function(err) {
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
  db.get(`SELECT id,label,category,reorderLevel,reorderQty,unit,packSize,salePrice,primaryVendorId,altVendorId,muted FROM items WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'not found' });
    row.muted = !!row.muted;
    db.all(
      `SELECT id,company,contactName,contactEmail,contactPhone,onTimeScore,updatedAt
       FROM vendors
       ORDER BY company ASC`,
      [],
      (vendorListErr, vendorList) => {
        if (vendorListErr) return res.status(500).json({ error: vendorListErr.message });
        db.all(
      `SELECT
         ivo.id,
         ivo.itemId,
         ivo.vendorId,
         v.company AS vendorCompany,
         v.contactName,
         v.contactEmail,
         v.contactPhone,
         ivo.partNumber,
         ivo.price,
         ivo.shippingCost,
         ivo.moq,
         ivo.leadTimeDays,
         ivo.onTimeScore,
         ivo.updatedAt
       FROM item_vendor_options ivo
       JOIN vendors v ON v.id = ivo.vendorId
       WHERE ivo.itemId = ?
       ORDER BY v.company ASC`,
      [id],
      (vendorOptionsErr, vendorOptions) => {
        if (vendorOptionsErr) return res.status(500).json({ error: vendorOptionsErr.message });
        reorder.getOnOrderItemIds(db).then(onOrderIds => {
          res.json(Object.assign({}, row, { onOrder: onOrderIds.has(row.id), vendors: vendorOptions || [], vendorList: vendorList || [] }));
        }).catch(onOrderErr => res.status(500).json({ error: onOrderErr.message }));
      }
    );
      }
    );
  });
});

// Get all vendors
app.get('/api/vendors', (req, res) => {
  db.all(
    `SELECT id,company,contactName,contactEmail,contactPhone,onTimeScore,updatedAt FROM vendors ORDER BY company ASC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// Create vendor
app.post('/api/vendors', (req, res) => {
  const body = req.body || {};
  const company = (body.company || '').trim();
  if (!company) return res.status(400).json({ error: 'company is required' });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO vendors (company, contactName, contactEmail, contactPhone, onTimeScore, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
    [company, body.contactName || null, body.contactEmail || null, body.contactPhone || null, (body.onTimeScore === null || body.onTimeScore === '' || typeof body.onTimeScore === 'undefined') ? null : Number(body.onTimeScore), now],
    function(err){
      if (err) return res.status(500).json({ error: err.message });
      db.get(
        `SELECT id,company,contactName,contactEmail,contactPhone,onTimeScore,updatedAt FROM vendors WHERE id = ?`,
        [this.lastID],
        (readErr, row) => {
          if (readErr) return res.status(500).json({ error: readErr.message });
          res.status(201).json(row);
        }
      );
    }
  );
});

// Update vendor fields (partial)
app.put('/api/vendors/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid vendor id' });
  const { company, contactName, contactEmail, contactPhone, onTimeScore } = req.body || {};

  const sets = [];
  const params = [];

  if (typeof company !== 'undefined') { sets.push('company = ?'); params.push(company); }
  if (typeof contactName !== 'undefined') { sets.push('contactName = ?'); params.push(contactName); }
  if (typeof contactEmail !== 'undefined') { sets.push('contactEmail = ?'); params.push(contactEmail); }
  if (typeof contactPhone !== 'undefined') { sets.push('contactPhone = ?'); params.push(contactPhone); }
  if (typeof onTimeScore !== 'undefined') { sets.push('onTimeScore = ?'); params.push(onTimeScore === null || onTimeScore === '' ? null : Number(onTimeScore)); }

  if (sets.length === 0) return res.status(400).json({ error: 'no fields' });
  sets.push('updatedAt = ?');
  params.push(new Date().toISOString());
  params.push(id);

  const sql = `UPDATE vendors SET ${sets.join(', ')} WHERE id = ?`;
  db.run(sql, params, function(err){
    if (err) return res.status(500).json({ error: err.message });
    if (!this.changes) return res.status(404).json({ error: 'not found' });
    db.get(
      `SELECT id,company,contactName,contactEmail,contactPhone,onTimeScore,updatedAt FROM vendors WHERE id = ?`,
      [id],
      (readErr, row) => {
        if (readErr) return res.status(500).json({ error: readErr.message });
        res.json(row);
      }
    );
  });
});

// Delete vendor
app.delete('/api/vendors/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid vendor id' });
  db.serialize(() => {
    db.run(`DELETE FROM item_vendor_options WHERE vendorId = ?`, [id], (linkErr) => {
      if (linkErr) return res.status(500).json({ error: linkErr.message });
      db.run(`DELETE FROM vendors WHERE id = ?`, [id], function(err){
        if (err) return res.status(500).json({ error: err.message });
        if (!this.changes) return res.status(404).json({ error: 'not found' });
        res.json({ deleted: 1 });
      });
    });
  });
});

// Upsert item/vendor specific values
app.put('/api/items/:itemId/vendor-options/:vendorId', (req, res) => {
  const itemId = req.params.itemId;
  const vendorId = Number(req.params.vendorId);
  if (!itemId) return res.status(400).json({ error: 'invalid item id' });
  if (!Number.isInteger(vendorId) || vendorId <= 0) return res.status(400).json({ error: 'invalid vendor id' });
  const body = req.body || {};
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO item_vendor_options (itemId, vendorId, partNumber, price, shippingCost, moq, leadTimeDays, onTimeScore, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(itemId, vendorId) DO UPDATE SET
       partNumber = excluded.partNumber,
       price = excluded.price,
       shippingCost = excluded.shippingCost,
       moq = excluded.moq,
       leadTimeDays = excluded.leadTimeDays,
       onTimeScore = excluded.onTimeScore,
       updatedAt = excluded.updatedAt`,
    [
      itemId,
      vendorId,
      body.partNumber || null,
      body.price === null || body.price === '' || typeof body.price === 'undefined' ? null : Number(body.price),
      body.shippingCost === null || body.shippingCost === '' || typeof body.shippingCost === 'undefined' ? null : Number(body.shippingCost),
      body.moq === null || body.moq === '' || typeof body.moq === 'undefined' ? null : Number(body.moq),
      body.leadTimeDays === null || body.leadTimeDays === '' || typeof body.leadTimeDays === 'undefined' ? null : Number(body.leadTimeDays),
      body.onTimeScore === null || body.onTimeScore === '' || typeof body.onTimeScore === 'undefined' ? null : Number(body.onTimeScore),
      now
    ],
    function(err){
      if (err) return res.status(500).json({ error: err.message });
      db.get(
        `SELECT
           ivo.id,
           ivo.itemId,
           ivo.vendorId,
           v.company AS vendorCompany,
           v.contactName,
           v.contactEmail,
           ivo.partNumber,
           ivo.price,
           ivo.shippingCost,
           ivo.moq,
           ivo.leadTimeDays,
           ivo.onTimeScore,
           ivo.updatedAt
         FROM item_vendor_options ivo
         JOIN vendors v ON v.id = ivo.vendorId
         WHERE ivo.itemId = ? AND ivo.vendorId = ?`,
        [itemId, vendorId],
        (readErr, row) => {
          if (readErr) return res.status(500).json({ error: readErr.message });
          res.json(row);
        }
      );
    }
  );
});

// Update item fields (partial)
app.put('/api/items/:id', (req, res) => {
  const id = req.params.id;
  const { reorderLevel, reorderQty, label, salePrice, primaryVendorId, altVendorId, muted } = req.body || {};
  // build dynamic set
  const sets = [];
  const params = [];
  if (typeof reorderLevel !== 'undefined') { sets.push('reorderLevel = ?'); params.push(reorderLevel); }
  if (typeof reorderQty !== 'undefined') { sets.push('reorderQty = ?'); params.push(reorderQty); }
  if (typeof label !== 'undefined') { sets.push('label = ?'); params.push(label); }
  if (typeof salePrice !== 'undefined') { sets.push('salePrice = ?'); params.push(salePrice === null || salePrice === '' ? null : Number(salePrice)); }
  if (typeof primaryVendorId !== 'undefined') { sets.push('primaryVendorId = ?'); params.push(primaryVendorId === null || primaryVendorId === '' ? null : Number(primaryVendorId)); }
  if (typeof altVendorId !== 'undefined') { sets.push('altVendorId = ?'); params.push(altVendorId === null || altVendorId === '' ? null : Number(altVendorId)); }
  if (typeof muted !== 'undefined') { sets.push('muted = ?'); params.push(muted ? 1 : 0); }
  if (sets.length === 0) return res.status(400).json({ error: 'no fields' });
  params.push(id);
  const sql = `UPDATE items SET ${sets.join(', ')} WHERE id = ?`;
  db.run(sql, params, function(err){
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT id,label,category,reorderLevel,reorderQty,unit,packSize,salePrice,primaryVendorId,altVendorId,muted FROM items WHERE id = ?`, [id], (err2, row) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json(Object.assign({}, row, { muted: !!row.muted }));
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

// GET reorder status — last sent time and config presence
app.get('/api/reorder/status', (req, res) => {
  const config = reorder.loadConfig();
  const state = reorder.loadState();
  res.json({
    configured: !!(config && config.smtp_user && config.to),
    to: config ? config.to : null,
    lastSent: state.lastSent || null,
    lastItemCount: state.lastItemCount || 0,
    lastItems: state.lastItems || []
  });
});

// POST reorder/send — manually trigger report regardless of daily gate
app.post('/api/reorder/send', async (req, res) => {
  const config = reorder.loadConfig();
  if (!config || !config.smtp_user || !config.to) {
    return res.status(400).json({ error: 'Email not configured. Create server/email-config.json.' });
  }
  try {
    const result = await reorder.sendReorderEmail(db, config);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Catch-all: any unmatched /api/* route returns JSON (not HTML) so the client always gets parseable errors
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No API route: ${req.method} ${req.path}` });
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

  // Run reorder check at startup then every hour.
  // Email is sent at most once per calendar day and only when items are low.
  reorder.runDailyCheck(db);
  setInterval(() => reorder.runDailyCheck(db), 60 * 60 * 1000);
});
