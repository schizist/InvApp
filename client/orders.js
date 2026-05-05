(async function(){
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch(e){}
  }

  const $ = id => document.getElementById(id);
  const today = () => new Date().toISOString().slice(0,10);
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0; const v = c === 'x' ? r : (r&0x3|0x8); return v.toString(16);
  });
  const fields = ['poNumber','clientName','jobName','orderDate','vendorName','vendorContactName','vendorEmail','vendorPhone','orderedBy','enteredBy','status','notes'];
  let orders = [];
  let items = [];
  let vendors = [];
  let current = null;

  function applyTheme(t){
    const next = t === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', next);
    localStorage.setItem('invapp.theme', next);
    $('themeToggle').textContent = next === 'dark' ? 'Light' : 'Dark';
  }

  function numberValue(v){
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function wholeNumberValue(v){
    const n = numberValue(v);
    return n != null && Number.isInteger(n) ? n : null;
  }

  function moneyValue(qty, cost){
    const q = numberValue(qty);
    const c = numberValue(cost);
    return q == null || c == null ? null : q * c;
  }

  function itemUnitInfo(item){
    if (!item) return { unit: 'pcs', multiplier: 1 };
    if ((item.category || '').toLowerCase() === 'wire') return { unit: '500 ft', multiplier: 500 };
    return { unit: item.unit || 'pcs', multiplier: Number(item.packSize) > 0 ? Number(item.packSize) : 1 };
  }

  function generatedPo(){
    const day = (current && current.orderDate ? current.orderDate : today()).replace(/-/g, '');
    const prefix = `PO-${day}-`;
    const max = orders.reduce((m, order) => {
      const po = String(order.poNumber || '');
      if (!po.startsWith(prefix)) return m;
      const n = Number(po.slice(prefix.length));
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  }

  function baseOrder(){
    const now = new Date().toISOString();
    return {
      id: uuid(), poNumber: '', generatedPoNumber: false, clientName: '', jobName: '',
      orderDate: today(), vendorName: '', vendorContactName: '', vendorEmail: '', vendorPhone: '',
      orderedBy: '', enteredBy: '', status: 'draft', notes: '', createdAt: now, updatedAt: now,
      lines: [], progress: { ordered: 0, received: 0 }
    };
  }

  async function loadItems(){
    try{
      const res = await fetch('/api/items');
      if (!res.ok) throw new Error('items fetch failed');
      items = await res.json();
      await IDB.setLastItems(items);
    }catch(e){
      items = await IDB.getLastItems() || window.INVAPP_DEFAULT_ITEMS || [];
    }
    $('itemOptions').innerHTML = items.map(it => `<option value="${escapeHtml(it.label)}" data-id="${escapeHtml(it.id)}"></option>`).join('');
  }

  async function loadVendors(){
    try{
      const res = await fetch('/api/vendors');
      if (!res.ok) throw new Error('vendors fetch failed');
      vendors = await res.json();
    }catch(e){
      vendors = [];
    }
    renderVendorOptions();
  }

  function selectedVendor(){
    const vendorName = $('vendorName') ? $('vendorName').value : (current && current.vendorName);
    return vendors.find(v => v.company === vendorName) || null;
  }

  function fillVendorFields(vendor){
    if (!$('vendorContactName')) return;
    $('vendorContactName').value = vendor ? (vendor.contactName || '') : '';
    $('vendorEmail').value = vendor ? (vendor.contactEmail || '') : '';
    $('vendorPhone').value = vendor ? (vendor.contactPhone || '') : '';
    if (current) {
      current.vendorContactName = $('vendorContactName').value;
      current.vendorEmail = $('vendorEmail').value;
      current.vendorPhone = $('vendorPhone').value;
    }
  }

  function renderVendorOptions(){
    const select = $('vendorName');
    if (!select) return;
    const value = current && current.vendorName ? current.vendorName : select.value;
    const hasValue = value && vendors.some(v => v.company === value);
    const options = ['<option value="">Select vendor</option>']
      .concat(vendors.map(v => `<option value="${escapeHtml(v.company)}">${escapeHtml(v.company)}</option>`));
    if (value && !hasValue) options.push(`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`);
    select.innerHTML = options.join('');
    select.value = value || '';
  }

  async function loadOrders(){
    if (navigator.onLine) {
      try{
        const res = await fetch('/api/orders');
        if (res.ok) {
          const remote = await res.json();
          for (const order of remote) await IDB.storeOrderGraph(order);
        }
      }catch(e){}
    }
    const localOrders = await IDB.getOrders();
    const localLines = await Promise.all(localOrders.map(o => IDB.getOrderLines(o.id)));
    const localReceipts = await Promise.all(localOrders.map(o => IDB.getOrderReceipts(o.id)));
    orders = localOrders.map((order, i) => decorateOrder(order, localLines[i] || [], localReceipts[i] || []))
      .sort((a,b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    renderList();
    if (current) {
      current = orders.find(o => o.id === current.id) || current;
      renderEditor();
    }
  }

  function decorateOrder(order, lines, receipts){
    const byLine = {};
    receipts.forEach(r => { byLine[r.orderLineId] = byLine[r.orderLineId] || []; byLine[r.orderLineId].push(r); });
    const decoratedLines = (lines || []).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(line => {
      const lineReceipts = (byLine[line.id] || []).sort((a,b)=>String(a.receivedDate).localeCompare(String(b.receivedDate)));
      const received = lineReceipts.reduce((s,r)=>s+(Number(r.quantityReceived)||0),0);
      const ordered = Number(line.quantityOrdered)||0;
      return Object.assign({}, line, { receipts: lineReceipts, quantityReceived: received, remainder: ordered - received, status: computeLineStatus(line, received, ordered) });
    });
    const orderedTotal = decoratedLines.reduce((s,l)=>s+(Number(l.quantityOrdered)||0),0);
    const receivedTotal = decoratedLines.reduce((s,l)=>s+Math.min(Number(l.quantityOrdered)||0, Number(l.quantityReceived)||0),0);
    const status = computeStatus(Object.assign({}, order, { lines: decoratedLines }));
    return Object.assign({}, order, { status, lines: decoratedLines, progress: { ordered: orderedTotal, received: receivedTotal } });
  }

  function computeLineStatus(line, received, ordered){
    if (line.status === 'cancelled') return 'cancelled';
    if (ordered > 0 && received >= ordered) return 'complete';
    if (received > 0) return 'partially_received';
    return 'pending';
  }

  function computeStatus(order){
    if (order.status === 'draft' || order.status === 'cancelled') return order.status;
    const lines = (order.lines || []).filter(line => line.status !== 'cancelled');
    if (!lines.length) return 'ordered';
    const any = lines.some(l => (Number(l.quantityReceived)||0) > 0 || l.status === 'complete');
    const all = lines.every(l => l.status === 'complete' || (Number(l.quantityReceived)||0) >= (Number(l.quantityOrdered)||0));
    if (all) return 'received';
    if (any) return 'partially_received';
    return 'ordered';
  }

  function renderList(){
    const q = $('searchInput').value.trim().toLowerCase();
    const statusFilter = $('statusFilter').value;
    const COMPLETE_STATUSES = ['received', 'cancelled'];
    const filtered = orders.filter(o => {
      const text = [o.poNumber,o.vendorName,o.clientName,o.jobName].join(' ').toLowerCase();
      if (q && !text.includes(q)) return false;
      if (statusFilter === 'open') return !COMPLETE_STATUSES.includes(o.status);
      if (statusFilter === 'needs') return ['ordered','partially_received'].includes(o.status);
      return !statusFilter || o.status === statusFilter;
    });
    const byDate = (a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || ''));
    const pending = filtered.filter(o => !COMPLETE_STATUSES.includes(o.status)).sort(byDate);
    const complete = filtered.filter(o => COMPLETE_STATUSES.includes(o.status)).sort(byDate);
    function rowHtml(o){
      return `<div class="orderRow ${current && current.id === o.id ? 'active' : ''}" data-id="${escapeHtml(o.id)}">
        <div class="rowTop"><strong>${escapeHtml(o.poNumber || 'No PO')}</strong><span class="badge ${escapeHtml(o.status)}">${escapeHtml(o.status.replace('_',' '))}</span></div>
        <div>${escapeHtml(o.clientName || '')}${o.jobName ? ' / ' + escapeHtml(o.jobName) : ''}</div>
        <div class="small">${escapeHtml(o.vendorName || '')} | ${escapeHtml(o.orderDate || '')}</div>
        <div class="small">${formatQty((o.progress || {}).received)} / ${formatQty((o.progress || {}).ordered)} received</div>
      </div>`;
    }
    let html = '';
    if (!filtered.length) {
      html = '<div class="empty">No orders found.</div>';
    } else {
      if (pending.length) {
        if (complete.length) html += '<div class="listSection">Active</div>';
        html += pending.map(rowHtml).join('');
      }
      if (complete.length) {
        html += '<div class="listSection">Completed</div>';
        html += complete.map(rowHtml).join('');
      }
    }
    $('ordersList').innerHTML = html;
    $('ordersList').querySelectorAll('.orderRow').forEach(row => {
      row.addEventListener('click', () => { current = orders.find(o => o.id === row.dataset.id); renderList(); renderEditor(); });
    });
  }

  function renderEditor(){
    $('editorEmpty').style.display = current ? 'none' : '';
    $('editor').style.display = current ? '' : 'none';
    if (!current) return;
    fields.forEach(f => { if ($(f)) $(f).value = current[f] || ''; });
    renderVendorOptions();
    const vendor = selectedVendor();
    if (vendor) fillVendorFields(vendor);
    $('poLabel').textContent = current.poNumber || 'Unsaved order';
    $('statusBadge').className = `badge ${current.status}`;
    $('statusBadge').textContent = current.status.replace('_',' ');
    current.progress = current.progress || { ordered: 0, received: 0 };
    $('progressLabel').textContent = `${formatQty(current.progress.received)} of ${formatQty(current.progress.ordered)} received`;
    const lineFilter = $('lineStatusFilter').value;
    $('lines').innerHTML = (current.lines || []).map((line, idx) => ({ line, idx })).filter(row => !lineFilter || row.line.status === lineFilter).map(row => renderLine(row.line, row.idx)).join('');
    bindLineEvents();
  }

  function renderLine(line, idx){
    const receiptText = (line.receipts || []).length
      ? line.receipts.map(r => `${formatQty(r.quantityReceived)} on ${escapeHtml(r.receivedDate)}${r.receivedBy ? ' by ' + escapeHtml(r.receivedBy) : ''}${r.addToInventory ? ' | added to inventory' : ''}`).join('<br>')
      : 'No receipts';
    return `
      <div class="lineCard" data-line-id="${escapeHtml(line.id)}" data-line-index="${idx}">
        <div class="lineGrid">
          ${itemSelectBlock('Inventory Item', `lineItem-${idx}`, line.itemId || '')}
          ${inputBlock('Description', `lineDesc-${idx}`, line.description || '')}
          ${inputBlock('Qty Ordered', `lineQty-${idx}`, line.quantityOrdered || '', 'type="number" step="1" min="1" inputmode="numeric"')}
          ${inputBlock('Unit', `lineUnit-${idx}`, line.unit || '')}
          ${inputBlock('Vendor Item #', `lineVendor-${idx}`, line.vendorItemNumber || '')}
          ${inputBlock('Mfr Part #', `lineMfr-${idx}`, line.manufacturerPartNumber || '')}
          ${inputBlock('Unit Cost', `lineCost-${idx}`, line.unitCost ?? '', 'type="number" step="0.01"')}
          <div><label>Received / Remain</label><div>${formatQty(line.quantityReceived)} / ${formatQty(line.remainder)}</div><span class="badge ${escapeHtml(line.status)}">${escapeHtml(line.status.replace('_',' '))}</span></div>
        </div>
        <div class="lineGrid" style="margin-top:8px;grid-template-columns:1fr auto">
          ${inputBlock('Line Notes', `lineNotes-${idx}`, line.notes || '')}
          <button type="button" class="btn btnNeutral removeLineBtn">Remove</button>
        </div>
        <div class="receiveBox">
          ${inputBlock('Quantity Received', `receiveQty-${idx}`, '', 'type="number" step="1" min="1" inputmode="numeric"')}
          ${inputBlock('Received Date', `receiveDate-${idx}`, today(), 'type="date"')}
          ${inputBlock('Received By', `receiveBy-${idx}`, '')}
          ${inputBlock('Receipt Note', `receiveNote-${idx}`, '')}
          <button type="button" class="btn btnPrimary receiveFullBtn">Receive Full</button>
          <button type="button" class="btn btnPrimary receivePartialBtn">Receive Partial</button>
          <button type="button" class="btn btnNeutral saveLineBtn">Save Item</button>
        </div>
        <div class="receipts">${receiptText}</div>
      </div>`;
  }

  function inputBlock(label, id, value, attrs){
    return `<div><label for="${id}">${label}</label><input id="${id}" ${attrs || ''} value="${escapeHtml(value)}" /></div>`;
  }

  function itemSelectBlock(label, id, value){
    const options = ['<option value="">Select item</option>'].concat(items.map(item => (
      `<option value="${escapeHtml(item.id)}" ${String(item.id) === String(value) ? 'selected' : ''}>${escapeHtml(item.label)}</option>`
    )));
    return `<div><label for="${id}">${label}</label><select id="${id}">${options.join('')}</select></div>`;
  }

  function bindLineEvents(){
    $('lines').querySelectorAll('.lineCard').forEach(card => {
      const idx = Number(card.dataset.lineIndex);
      card.querySelectorAll('input').forEach(input => input.addEventListener('change', () => updateLineFromForm(idx)));
      card.querySelectorAll('select').forEach(select => select.addEventListener('change', () => updateLineFromForm(idx)));
      card.querySelector('.removeLineBtn').addEventListener('click', async () => {
        const line = current.lines[idx];
        if ((line.receipts || []).length) return alert('Lines with receipt history cannot be removed.');
        current.lines.splice(idx, 1);
        await IDB.deleteOrderLine(line.id);
        await IDB.queueOrderChange({ id: uuid(), type: 'lineDelete', lineId: line.id, createdAt: new Date().toISOString() });
        renderEditor();
      });
      card.querySelector('.receiveFullBtn').addEventListener('click', () => receiveLine(idx, true));
      card.querySelector('.receivePartialBtn').addEventListener('click', () => receiveLine(idx, false));
      card.querySelector('.saveLineBtn').addEventListener('click', () => saveLineItem(idx));
    });
  }

  function updateLineFromForm(idx){
    const line = current.lines[idx];
    if (!line || !$(`lineItem-${idx}`)) return;
    const priorLabel = line.itemLabel || '';
    const itemId = $(`lineItem-${idx}`).value.trim();
    const found = items.find(it => it.id === itemId);
    const quantityOrdered = wholeNumberValue($(`lineQty-${idx}`).value);
    const descInput = $(`lineDesc-${idx}`);
    const unitInput = $(`lineUnit-${idx}`);
    if (found && (!descInput.value.trim() || descInput.value.trim() === priorLabel)) descInput.value = found.label;
    if (found) {
      const unitInfo = itemUnitInfo(found);
      if (!unitInput.value.trim() || unitInput.value === 'pcs') unitInput.value = unitInfo.unit;
    }
    line.itemLabel = found ? found.label : '';
    line.itemId = found ? found.id : null;
    line.description = descInput.value.trim() || (found ? found.label : '');
    line.quantityOrdered = quantityOrdered || 0;
    line.unit = unitInput.value.trim();
    line.vendorItemNumber = $(`lineVendor-${idx}`).value.trim();
    line.manufacturerPartNumber = $(`lineMfr-${idx}`).value.trim();
    line.unitCost = numberValue($(`lineCost-${idx}`).value);
    line.lineTotal = moneyValue(line.quantityOrdered, line.unitCost);
    line.notes = $(`lineNotes-${idx}`).value.trim();
    line.quantityReceived = (line.receipts || []).reduce((sum, receipt) => sum + (Number(receipt.quantityReceived) || 0), 0);
    line.remainder = Math.max(0, (Number(line.quantityOrdered) || 0) - line.quantityReceived);
    line.status = computeLineStatus(line, line.quantityReceived, Number(line.quantityOrdered) || 0);
  }

  function inventoryEventForReceipt(line, receipt){
    if (!line.itemId) return null;
    const item = items.find(it => it.id === line.itemId);
    const unitInfo = itemUnitInfo(item);
    return {
      id: `order-receipt-${receipt.id}`,
      itemId: line.itemId,
      type: 'DELTA',
      qty: receipt.quantityReceived * unitInfo.multiplier,
      timestamp: receipt.createdAt,
      sessionId: null,
      note: `Received ${receipt.quantityReceived} ${line.unit || unitInfo.unit} on order ${current.poNumber || current.id}`,
      source: 'order_receipt',
      orderId: current.id,
      orderLineId: line.id,
      receiptId: receipt.id
    };
  }

  async function receiveLine(idx, receiveFull){
    updateLineFromForm(idx);
    const line = current.lines[idx];
    const qty = receiveFull ? Math.max(0, Number(line.remainder) || 0) : wholeNumberValue($(`receiveQty-${idx}`).value);
    if (!qty || qty <= 0) return alert('Received quantity must be positive.');
    if (!Number.isInteger(qty)) return alert('Quantity received must be a whole number.');
    if (qty > line.remainder && !confirm('Received quantity is greater than the remainder. Continue?')) return;
    const addToInventory = line.itemId
      ? confirm(`Add ${formatQty(qty)} received ${line.unit || 'units'} of ${line.itemLabel || line.description} to inventory?`)
      : false;
    const receipt = {
      id: uuid(), orderId: current.id, orderLineId: line.id, quantityReceived: qty,
      receivedDate: $(`receiveDate-${idx}`).value || today(),
      receivedBy: $(`receiveBy-${idx}`).value.trim(),
      note: $(`receiveNote-${idx}`).value.trim(),
      addToInventory,
      createdAt: new Date().toISOString()
    };
    await IDB.putOrderReceipt(receipt);
    const invEvent = inventoryEventForReceipt(line, receipt);
    if (addToInventory && invEvent) await IDB.addEvent(invEvent);
    line.receipts = (line.receipts || []).concat(receipt);
    line.quantityReceived = (Number(line.quantityReceived) || 0) + qty;
    line.remainder = (Number(line.quantityOrdered) || 0) - line.quantityReceived;
    line.status = computeLineStatus(line, line.quantityReceived, Number(line.quantityOrdered) || 0);
    await saveCurrent(current.status, false);
    await IDB.queueOrderChange({ id: uuid(), type: 'receipt', receipt, createdAt: new Date().toISOString() });
    if (navigator.onLine) syncOrders().catch(()=>{});
  }

  async function saveLineItem(idx){
    updateLineFromForm(idx);
    await saveCurrent(current.status, true);
  }

  function readHeader(statusOverride){
    fields.forEach(f => { if ($(f)) current[f] = $(f).value.trim(); });
    const vendor = selectedVendor();
    if (vendor) {
      current.vendorContactName = vendor.contactName || '';
      current.vendorEmail = vendor.contactEmail || '';
      current.vendorPhone = vendor.contactPhone || '';
    }
    current.status = statusOverride || current.status || 'draft';
    current.orderDate = current.orderDate || today();
    current.updatedAt = new Date().toISOString();
    if (!current.createdAt) current.createdAt = current.updatedAt;
    if (!current.poNumber) {
      current.poNumber = generatedPo();
      current.generatedPoNumber = true;
    }
  }

  async function saveCurrent(statusOverride, alertOnSave){
    readHeader(statusOverride);
    if (!current.orderDate) return alert('Order date is required.');
    if (!current.vendorName) return alert('Ordered From is required.');
    current.lines.forEach((_line, idx) => updateLineFromForm(idx));
    const badLine = current.lines.find(line => !line.description || !(Number(line.quantityOrdered) > 0) || !Number.isInteger(Number(line.quantityOrdered)));
    if (badLine) return alert('Each line item needs a description and a positive whole-number ordered quantity.');
    current.status = computeStatus(current);
    await IDB.putOrder(Object.assign({}, current, { lines: undefined, receipts: undefined }));
    for (const line of current.lines) {
      line.orderId = current.id;
      line.status = computeLineStatus(line, Number(line.quantityReceived) || 0, Number(line.quantityOrdered) || 0);
      await IDB.putOrderLine(Object.assign({}, line, { receipts: undefined }));
    }
    await IDB.queueOrderChange({ id: uuid(), type: 'order', order: Object.assign({}, current, { lines: undefined }), createdAt: new Date().toISOString() });
    for (const line of current.lines) await IDB.queueOrderChange({ id: uuid(), type: 'line', line: Object.assign({}, line, { receipts: undefined }), createdAt: new Date().toISOString() });
    await loadOrders();
    if (alertOnSave) alert('Order saved.');
    if (navigator.onLine) syncOrders().catch(()=>{});
  }

  async function syncOrders(){
    const changes = (await IDB.getQueuedOrderChanges()).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
    const done = [];
    for (const change of changes) {
      try{
        if (change.type === 'order') {
          const exists = await fetch('/api/orders/' + encodeURIComponent(change.order.id));
          const method = exists.ok ? 'PUT' : 'POST';
          const url = method === 'PUT' ? '/api/orders/' + encodeURIComponent(change.order.id) : '/api/orders';
          const res = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(change.order) });
          if (!res.ok) throw new Error(await res.text());
          await IDB.storeOrderGraph(await res.json());
        } else if (change.type === 'line') {
          const res = await fetch('/api/orders/' + encodeURIComponent(change.line.orderId) + '/lines', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(change.line) });
          if (!res.ok) throw new Error(await res.text());
          await IDB.storeOrderGraph(await res.json());
        } else if (change.type === 'receipt') {
          const res = await fetch('/api/order-lines/' + encodeURIComponent(change.receipt.orderLineId) + '/receipts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(change.receipt) });
          if (!res.ok) throw new Error(await res.text());
          await IDB.storeOrderGraph(await res.json());
        } else if (change.type === 'lineDelete') {
          const res = await fetch('/api/order-lines/' + encodeURIComponent(change.lineId), { method:'DELETE' });
          if (!res.ok) throw new Error(await res.text());
        } else if (change.type === 'orderDelete') {
          const res = await fetch('/api/orders/' + encodeURIComponent(change.orderId), { method:'DELETE' });
          if (!res.ok && res.status !== 404) throw new Error(await res.text());
        }
        done.push(change.id);
      }catch(err){
        console.warn('Order sync paused:', err);
        break;
      }
    }
    if (done.length) await IDB.clearOrderChanges(done);
    await uploadQueuedInventoryEvents();
    await loadOrders();
  }

  async function uploadQueuedInventoryEvents(){
    const queued = await IDB.getQueued();
    if (!queued || !queued.length) return;
    const processed = [];
    for (const ev of queued) {
      const res = await fetch('/api/events', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(ev) });
      if (!res.ok) break;
      const json = await res.json();
      if ((json.inserted || 0) + (json.ignored || 0) > 0) processed.push(ev.id);
    }
    if (processed.length) await IDB.clearEvents(processed);
  }

  function addLine(){
    if (!current) return;
    current.lines.push({
      id: uuid(), orderId: current.id, itemId: null, itemLabel: '', description: '',
      quantityOrdered: 1, unit: 'pcs', vendorItemNumber: '', manufacturerPartNumber: '',
      unitCost: null, lineTotal: null, quantityReceived: 0, remainder: 1, status: 'pending', notes: '', sortOrder: current.lines.length, receipts: []
    });
    renderEditor();
  }

  async function deleteCurrentOrder(){
    if (!current) return;
    const label = current.poNumber || current.id;
    if (!confirm(`Delete order ${label}? This removes the order, its line items, receipts, and any inventory receipt deltas created from it.`)) return;
    const orderId = current.id;
    await IDB.deleteOrder(orderId);
    await IDB.queueOrderChange({ id: uuid(), type: 'orderDelete', orderId, createdAt: new Date().toISOString() });
    current = null;
    await loadOrders();
    if (navigator.onLine) syncOrders().catch(()=>{});
  }

  function duplicateOrder(){
    if (!current) return;
    const now = new Date().toISOString();
    current = Object.assign({}, current, {
      id: uuid(), poNumber: '', generatedPoNumber: false, status: 'draft', createdAt: now, updatedAt: now,
      lines: current.lines.map((line, idx) => Object.assign({}, line, { id: uuid(), orderId: null, quantityReceived: 0, remainder: line.quantityOrdered, status: 'pending', receipts: [], sortOrder: idx }))
    });
    current.lines.forEach(line => line.orderId = current.id);
    renderEditor();
  }

  function generateSheet(){
    if (!current) return;
    if (navigator.onLine && current.poNumber) {
      window.open('/api/orders/' + encodeURIComponent(current.id) + '/sheet', '_blank');
      return;
    }
    const win = window.open('', '_blank');
    win.document.write(renderLocalSheet(current));
    win.document.close();
  }

  function renderLocalSheet(order){
    const rows = (order.lines || []).map(line => {
      const receipts = (line.receipts || []).slice(0, 3);
      const cells = [0,1,2].map(i => `<td>${receipts[i] ? escapeHtml(receipts[i].quantityReceived) : ''}</td><td>${receipts[i] ? escapeHtml(receipts[i].receivedDate) : ''}</td>`).join('');
      return `<tr><td>${escapeHtml(line.quantityOrdered)}</td><td>${escapeHtml(line.description)}</td>${cells}<td>${escapeHtml(line.remainder)}</td><td>${escapeHtml(String(line.status || '').replace('_',' '))}</td></tr>`;
    }).join('');
    return `<!doctype html><html><head><title>Order ${escapeHtml(order.poNumber)}</title><style>body{font-family:Arial;margin:28px}h1{text-align:center}table{width:100%;border-collapse:collapse}td,th{border:1px solid #111;padding:7px}th{background:#eee}@media print{button{display:none}}</style></head><body><button onclick="print()">Print</button><h1>ORDER STATUS</h1><p><b>CONTRACTOR / CLIENT:</b> ${escapeHtml(order.clientName)}</p><p><b>PO / JOB:</b> ${escapeHtml(order.poNumber)} / ${escapeHtml(order.jobName)}</p><p><b>ORDER DATE:</b> ${escapeHtml(order.orderDate)}</p><p><b>ORDERED FROM:</b> ${escapeHtml(order.vendorName)}</p><p><b>ORDERED BY:</b> ${escapeHtml(order.orderedBy)}</p><p><b>ENTERED BY:</b> ${escapeHtml(order.enteredBy)}</p><p><b>STATUS:</b> ${escapeHtml(order.status)}</p><table><thead><tr><th>NO. ORDERED</th><th>DESCRIPTION</th><th>NO. ARRIVED</th><th>DATE</th><th>NO. ARRIVED</th><th>DATE</th><th>NO. ARRIVED</th><th>DATE</th><th>REMAINDER</th><th>STATUS</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  }

  function escapeHtml(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function formatQty(v){ const n = Number(v) || 0; return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/,''); }

  $('newOrderBtn').addEventListener('click', () => { current = baseOrder(); renderList(); renderEditor(); });
  $('duplicateBtn').addEventListener('click', duplicateOrder);
  $('sheetBtn').addEventListener('click', generateSheet);
  $('addLineBtn').addEventListener('click', addLine);
  $('saveDraftBtn').addEventListener('click', () => saveCurrent('draft', true));
  $('markOrderedBtn').addEventListener('click', () => saveCurrent('ordered', true));
  $('cancelOrderBtn').addEventListener('click', () => saveCurrent('cancelled', true));
  $('deleteOrderBtn').addEventListener('click', () => deleteCurrentOrder());
  $('syncOrdersBtn').addEventListener('click', () => syncOrders());
  $('searchInput').addEventListener('input', renderList);
  $('statusFilter').addEventListener('change', renderList);
  $('lineStatusFilter').addEventListener('change', renderEditor);
  $('vendorName').addEventListener('change', () => {
    if (current) current.vendorName = $('vendorName').value.trim();
    fillVendorFields(selectedVendor());
  });
  $('themeToggle').addEventListener('click', () => applyTheme(document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  window.addEventListener('online', () => syncOrders().catch(()=>{}));

  applyTheme(localStorage.getItem('invapp.theme') === 'dark' ? 'dark' : 'light');
  await loadItems();
  await loadVendors();
  await loadOrders();
  if (navigator.onLine) syncOrders().catch(()=>{});
})();
