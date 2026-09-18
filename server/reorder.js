'use strict';
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const STATE_PATH = path.join(__dirname, 'reorder-state.json');
// An item is "nearing" its threshold when on-hand is within this multiple of the reorder level.
const NEARING_FACTOR = 1.5;
const CONFIG_PATH = path.join(__dirname, '..', 'email-config.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch(e) { return {}; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch(e) {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch(e) { return null; }
}

function sentToday(state) {
  if (!state.lastSent) return false;
  return new Date(state.lastSent).toDateString() === new Date().toDateString();
}

function computeQty(events) {
  let qty = 0;
  let lastCountIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'COUNT') lastCountIdx = i;
  }
  if (lastCountIdx >= 0) {
    qty = events[lastCountIdx].qty;
    for (let j = lastCountIdx + 1; j < events.length; j++) {
      if (events[j].type === 'DELTA') qty += events[j].qty;
    }
  } else {
    events.forEach(e => { if (e.type === 'DELTA') qty += e.qty; });
  }
  return qty;
}

function dailyQty(events, dayEndIso) {
  const evs = events.filter(e => e.timestamp <= dayEndIso);
  return Math.max(0, computeQty(evs));
}

// Items with outstanding quantity on a non-draft, non-cancelled order line —
// these are automatically muted since a reorder is already in motion.
function getOnOrderItemIds(db) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT DISTINCT l.itemId
      FROM order_lines l
      JOIN orders o ON o.id = l.orderId
      LEFT JOIN (
        SELECT orderLineId, SUM(quantityReceived) AS received
        FROM order_receipts
        GROUP BY orderLineId
      ) r ON r.orderLineId = l.id
      WHERE l.itemId IS NOT NULL
        AND l.status <> 'cancelled'
        AND o.status NOT IN ('draft', 'cancelled')
        AND COALESCE(r.received, 0) < l.quantityOrdered
    `, (err, rows) => {
      if (err) return reject(err);
      resolve(new Set((rows || []).map(r => r.itemId)));
    });
  });
}

async function getReorderItems(db) {
  const onOrderIds = await getOnOrderItemIds(db);

  return new Promise((resolve, reject) => {
    db.all(`
      SELECT i.id, i.label, i.category, i.reorderLevel, i.reorderQty, i.muted, i.favorite,
             v.company AS vendorName, v.contactName, v.contactEmail, v.contactPhone
      FROM items i
      LEFT JOIN vendors v ON v.id = i.primaryVendorId
      WHERE (i.reorderLevel IS NOT NULL AND i.reorderLevel > 0) OR i.favorite = 1
      ORDER BY i.label
    `, (err, items) => {
      if (err) return reject(err);
      if (!items.length) return resolve({ below: [], nearing: [], favorites: [] });

      db.all(`SELECT itemId, type, qty, timestamp FROM events ORDER BY timestamp ASC`, (err2, allEvents) => {
        if (err2) return reject(err2);

        const byItem = {};
        allEvents.forEach(ev => {
          if (!byItem[ev.itemId]) byItem[ev.itemId] = [];
          byItem[ev.itemId].push(ev);
        });

        const now = new Date();
        const below = [];
        const nearing = [];
        const favorites = [];

        for (const item of items) {
          const evs = byItem[item.id] || [];
          const qty = computeQty(evs);
          const level = item.reorderLevel || 0;
          const hasLevel = level > 0;
          const isBelow = hasLevel && qty <= level;
          const isNearing = hasLevel && !isBelow && qty <= level * NEARING_FACTOR;
          const isFavorite = !!item.favorite;
          if (!isBelow && !isNearing && !isFavorite) continue;

          const history = [];
          for (let i = 29; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).toISOString();
            history.push(dailyQty(evs, dayEnd));
          }

          const manuallyMuted = !!item.muted;
          const onOrder = onOrderIds.has(item.id);

          const entry = { ...item, qty, history, manuallyMuted, onOrder, favorite: isFavorite, muted: manuallyMuted || onOrder };
          if (isBelow) below.push(entry);
          else if (isNearing) nearing.push(entry);
          else favorites.push(entry);
        }

        resolve({ below, nearing, favorites });
      });
    });
  });
}

// Unicode block sparkline for 30-day trend
function sparkline(values) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...values, 1);
  return values.map(v => blocks[Math.min(7, Math.floor((v / max) * 7.99))]).join('');
}

// Inline HTML bar with a threshold marker line
function barHtml(current, threshold) {
  const max = Math.max(threshold * 3, current, 1);
  const currPct = Math.min(100, Math.round((current / max) * 100));
  const threshPct = Math.min(100, Math.round((threshold / max) * 100));
  const fill = current <= 0 ? '#b71c1c' : '#c62828';
  return (
    `<div style="position:relative;display:inline-block;vertical-align:middle;` +
    `width:180px;height:16px;background:#e5e7eb;border-radius:4px;overflow:visible">` +
    `<div style="height:16px;width:${currPct}%;background:${fill};border-radius:4px"></div>` +
    `<div style="position:absolute;top:-2px;left:${threshPct}%;width:2px;height:20px;` +
    `background:#374151;border-radius:1px" title="Threshold: ${threshold}"></div>` +
    `</div>`
  );
}

const STAR = '<span style="color:#d4a017" title="Favorite">&#9733;</span> ';

function vendorHtml(item) {
  const vendorParts = [item.vendorName, item.contactName, item.contactEmail, item.contactPhone].filter(Boolean);
  return vendorParts.length
    ? vendorParts.map(p => `<span>${esc(p)}</span>`).join(' &nbsp;&middot;&nbsp; ')
    : '<span style="color:#9ca3af;font-style:italic">No vendor assigned</span>';
}

function nameCellHtml(item) {
  const muteLabel = item.onOrder ? 'On order' : (item.manuallyMuted ? 'Muted' : '');
  const badge = muteLabel
    ? ` <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#9ca3af;border:1px solid #d1d5db;border-radius:3px;padding:1px 5px;margin-left:6px">${esc(muteLabel)}</span>`
    : '';
  return `${item.favorite ? STAR : ''}${esc(item.label)}${badge}`;
}

const THEAD = `
      <thead>
        <tr style="border-bottom:2px solid #e5e7eb;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280">
          <th style="padding:6px 8px;text-align:left">Item</th>
          <th style="padding:6px 8px;text-align:center">On Hand</th>
          <th style="padding:6px 8px;text-align:center">Threshold</th>
          <th style="padding:6px 8px;text-align:left">Level &nbsp;<span style="font-size:9px;font-style:italic;text-transform:none">(bar = current, line = threshold)</span></th>
          <th style="padding:6px 8px;text-align:left">30-Day Trend</th>
          <th style="padding:6px 8px;text-align:left">Vendor</th>
        </tr>
      </thead>`;

function sectionRows(items, qtyColor) {
  return items.map(item => {
    const rowStyle = item.muted
      ? 'border-bottom:1px solid #f3f4f6;opacity:.55'
      : 'border-bottom:1px solid #f3f4f6';
    return `
      <tr style="${rowStyle}">
        <td style="padding:10px 8px;font-weight:700">${nameCellHtml(item)}</td>
        <td style="padding:10px 8px;text-align:center;font-weight:800;font-size:1.05em;color:${item.qty <= 0 ? '#b71c1c' : qtyColor}">${item.qty}</td>
        <td style="padding:10px 8px;text-align:center;color:#6b7280">${item.reorderLevel}</td>
        <td style="padding:10px 8px">${barHtml(item.qty, item.reorderLevel)}</td>
        <td style="padding:10px 8px;font-family:'Courier New',Courier,monospace;font-size:14px;letter-spacing:1px;color:#374151" title="30-day quantity trend (oldest → newest)">${sparkline(item.history)}</td>
        <td style="padding:10px 8px;font-size:12px;color:#374151;line-height:1.5">${vendorHtml(item)}</td>
      </tr>`;
  }).join('');
}

function buildHtml({ below = [], nearing = [], favorites = [] }) {
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const activeCount = below.filter(item => !item.muted).length;
  const mutedCount = below.length - activeCount;

  const belowSection = below.length ? `
    <p style="margin:0 0 16px;color:#6b7280;font-size:.92rem">
      <strong style="color:#991b1b">${activeCount} item${activeCount === 1 ? '' : 's'}</strong> at or below reorder threshold${mutedCount ? ` (plus ${mutedCount} muted, shown for reference)` : ''}.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">${THEAD}
      <tbody>${sectionRows(below, '#c62828')}</tbody>
    </table>` : `
    <p style="margin:0;color:#6b7280;font-size:.92rem">No items are at or below their reorder threshold.</p>`;

  const nearingSection = nearing.length ? `
    <h3 style="margin:28px 0 8px;font-size:.95rem;color:#b45309">Nearing reorder threshold (${nearing.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">${THEAD}
      <tbody>${sectionRows(nearing, '#b45309')}</tbody>
    </table>` : '';

  const favRows = favorites.map(item => `
        <tr style="border-bottom:1px solid #f3f4f6">
          <td style="padding:4px 8px">${STAR}${esc(item.label)}</td>
          <td style="padding:4px 8px;text-align:right;font-weight:700">${item.qty}</td>
          <td style="padding:4px 8px;text-align:right;color:#6b7280">${item.reorderLevel > 0 ? item.reorderLevel : '&mdash;'}</td>
        </tr>`).join('');
  const favSection = favorites.length ? `
    <h3 style="margin:28px 0 6px;font-size:.8rem;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Favorites</h3>
    <table style="width:100%;border-collapse:collapse;font-size:11px;color:#374151">
      <thead>
        <tr style="border-bottom:1px solid #e5e7eb;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af">
          <th style="padding:3px 8px;text-align:left">Item</th>
          <th style="padding:3px 8px;text-align:right">On Hand</th>
          <th style="padding:3px 8px;text-align:right">Threshold</th>
        </tr>
      </thead>
      <tbody>${favRows}</tbody>
    </table>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Reorder Alert</title></head>
<body style="margin:0;padding:20px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:860px;margin:0 auto;background:#ffffff;border-radius:10px;border:1px solid #d1d5db;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
  <div style="background:#991b1b;padding:20px 24px">
    <div style="font-size:1.25rem;font-weight:700;color:#fff">&#9888;&#xfe0f; Reorder Alert</div>
    <div style="margin-top:4px;color:rgba(255,255,255,.8);font-size:.9rem">${date}</div>
  </div>
  <div style="padding:20px 24px">${belowSection}${nearingSection}${favSection}
  </div>
  <div style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">
    Sent by InvApp reorder monitor &mdash; ${new Date().toISOString()}
  </div>
</div>
</body>
</html>`;
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sendReorderEmail(db, config) {
  const report = await getReorderItems(db);
  if (!report.below.length) return { sent: false, reason: 'no items at or below threshold' };

  const activeItems = report.below.filter(i => !i.muted);
  if (!activeItems.length) return { sent: false, reason: 'all items at or below threshold are muted' };

  const transporter = nodemailer.createTransport({
    host: config.smtp_host,
    port: Number(config.smtp_port) || 587,
    secure: Number(config.smtp_port) === 465,
    auth: { user: config.smtp_user, pass: process.env.SMTP_PASS || config.smtp_pass }
  });

  const html = buildHtml(report);
  const dateStr = new Date().toLocaleDateString();

  await transporter.sendMail({
    from: config.from || config.smtp_user,
    to: config.to,
    subject: `[InvApp] Reorder Alert — ${activeItems.length} item${activeItems.length === 1 ? '' : 's'} low (${dateStr})`,
    html
  });

  return { sent: true, itemCount: activeItems.length, items: activeItems.map(i => i.label) };
}

async function runDailyCheck(db) {
  const config = loadConfig();
  if (!config || !config.smtp_user || !config.to) {
    console.log('[reorder] Email not configured (email-config.json missing or incomplete) — skipping.');
    return;
  }

  const state = loadState();
  if (sentToday(state)) {
    console.log('[reorder] Already sent today — skipping.');
    return;
  }

  try {
    const result = await sendReorderEmail(db, config);
    if (result.sent) {
      saveState({ lastSent: new Date().toISOString(), lastItemCount: result.itemCount, lastItems: result.items });
      console.log(`[reorder] Sent alert — ${result.itemCount} items: ${result.items.join(', ')}`);
    } else {
      console.log('[reorder] All items above threshold — no email sent.');
    }
  } catch(e) {
    console.error('[reorder] Failed to send email:', e.message);
  }
}

module.exports = { runDailyCheck, sendReorderEmail, getReorderItems, getOnOrderItemIds, buildHtml, loadConfig, loadState };
