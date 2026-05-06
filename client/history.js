(function(){
  function qs(){ return Object.fromEntries(new URLSearchParams(location.search)); }
  function el(id){ return document.getElementById(id); }
  const themeToggle = () => el('themeToggle');
  const selectedVendorByItem = {};
  let canvas, tooltip;
  let lastSeries = [];
  const DPR = window.devicePixelRatio || 1;

  function applyTheme(t){
    const next = t === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('invapp.theme', next);
    const btn = themeToggle();
    if (btn) btn.textContent = next === 'dark' ? 'Light' : 'Dark';
    if (lastSeries && lastSeries.length > 0) drawSeries(lastSeries);
  }

  function parseDateInput(v, endOfDay){
    if (!v) return null;
    return new Date(v + (endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'));
  }

  function formatDate(d){ return d.toISOString().slice(0,10); }

  function escapeHtml(text){
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeNumberInput(value){
    if (value == null) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  function currency(v){
    const n = Number(v);
    if (Number.isNaN(n)) return '-';
    return `$${n.toFixed(2)}`;
  }

  async function getLocalHistory(itemId, fromDate, toDate){
    const [remote, queued] = await Promise.all([IDB.getAllRemote(), IDB.getQueued()]);
    const all = [...(remote || []), ...(queued || [])];
    const uniqueById = {};
    all.forEach(ev => { if (ev && ev.id) uniqueById[ev.id] = ev; });
    const fromTs = fromDate ? fromDate.getTime() : null;
    const toTs = toDate ? toDate.getTime() : null;
    return Object.values(uniqueById)
      .filter(ev => ev.itemId === itemId)
      .filter(ev => {
        const ts = new Date(ev.timestamp).getTime();
        if (Number.isNaN(ts)) return false;
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
        return true;
      })
      .sort((a,b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  }

  async function loadItems(){
    const bundledItems = Array.isArray(window.INVAPP_DEFAULT_ITEMS) ? window.INVAPP_DEFAULT_ITEMS : [];
    let items = [];
    try{
      const res = await fetch('/api/items');
      if (!res.ok) throw new Error('items fetch failed');
      items = await res.json();
      await IDB.setLastItems(items);
    }catch(e){
      items = await IDB.getLastItems() || bundledItems;
    }
    const sel = el('item');
    sel.innerHTML = '';
    items.forEach(it => {
      const o = document.createElement('option');
      o.value = it.id;
      o.textContent = it.label;
      if (typeof it.reorderLevel !== 'undefined' && it.reorderLevel !== null) o.dataset.reorder = String(it.reorderLevel);
      if (typeof it.salePrice !== 'undefined' && it.salePrice !== null) o.dataset.salePrice = String(it.salePrice);
      sel.appendChild(o);
    });
  }

  function moveItemSelection(direction){
    const sel = el('item');
    if (!sel || sel.options.length === 0) return;
    const current = sel.selectedIndex >= 0 ? sel.selectedIndex : 0;
    const next = current + direction;
    if (next < 0 || next >= sel.options.length) return;
    sel.selectedIndex = next;
    syncSelectedItemInputs();
    show();
  }

  function syncSelectedItemInputs(){
    const sel = el('item');
    const opt = sel && sel.options[sel.selectedIndex];
    el('reorderInput').value = opt && opt.dataset && opt.dataset.reorder ? opt.dataset.reorder : '';
    el('salePriceInput').value = opt && opt.dataset && opt.dataset.salePrice ? opt.dataset.salePrice : '';
  }

  function setSelectedItemSalePrice(value){
    const input = el('salePriceInput');
    if (input) input.value = value ?? '';
    const sel = el('item');
    if (!sel || sel.selectedIndex < 0) return;
    if (value === null || typeof value === 'undefined') delete sel.options[sel.selectedIndex].dataset.salePrice;
    else sel.options[sel.selectedIndex].dataset.salePrice = String(value);
  }

  function buildDailyLevelSeries(events, startDate, endDate){
    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0, 0);
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59, 999);
    const sorted = (events || []).slice().sort((a,b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    let qty = 0;
    let idx = 0;
    const out = [];
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)){
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
      while (idx < sorted.length){
        const ev = sorted[idx];
        const ts = new Date(ev.timestamp).getTime();
        if (Number.isNaN(ts) || ts > dayEnd) break;
        if (ev.type === 'COUNT') qty = Number(ev.qty) || 0;
        else if (ev.type === 'DELTA') qty += (Number(ev.qty) || 0);
        idx++;
      }
      out.push({ date: new Date(d).toISOString().slice(0,10), qty, ts: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0) });
    }
    return out;
  }

  function fillVendorFields(v){
    const contact = el('vendorContact');
    const emails = el('vendorEmails');
    const phone = el('vendorPhone');
    if (contact) contact.value = v && v.contactName ? v.contactName : '';
    if (emails) emails.value = v && v.contactEmail ? v.contactEmail : '';
    if (phone) phone.value = v && v.contactPhone ? v.contactPhone : '';
  }

  function renderOrderVendors(item){
    const select = el('orderedFrom');
    if (!select) return;
    const vendors = item && item.vendorList && item.vendorList.length ? item.vendorList : [];
    select.innerHTML = '';
    if (!vendors.length){
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No vendors available';
      select.appendChild(o);
      fillVendorFields(null);
      return;
    }
    vendors.forEach(v => {
      const o = document.createElement('option');
      o.value = String(v.id);
      o.textContent = v.company || 'Vendor';
      select.appendChild(o);
    });
    const selectedId = item.primaryVendorId || vendors[0].id;
    select.value = String(selectedId);
    const fillSelected = () => {
      const vendor = vendors.find(v => String(v.id) === String(select.value));
      fillVendorFields(vendor || null);
    };
    select.onchange = fillSelected;
    fillSelected();
  }

  function renderVendors(item){
    const wrap = el('vendors');
    if (!wrap) return;
    wrap.innerHTML = '';
    const vendorList = (item && item.vendorList) ? item.vendorList : [];
    const vendorOptions = (item && item.vendors) ? item.vendors : [];
    if (!vendorList.length){
      const empty = document.createElement('div');
      empty.className = 'vendorEmpty';
      empty.innerHTML = 'No vendors found. <a href="/vendors.html">Manage vendors</a>.';
      wrap.appendChild(empty);
      return;
    }

    const itemId = item.id;
    const prior = selectedVendorByItem[itemId] || {};
    const primaryFromItem = item.primaryVendorId || vendorList[0].id;
    const altDefault = vendorList.length > 1 ? vendorList[1].id : vendorList[0].id;
    const altFromItem = item.altVendorId || altDefault;
    const primaryId = prior.primary && vendorList.some(v => String(v.id) === String(prior.primary)) ? prior.primary : primaryFromItem;
    const altId = prior.alt && vendorList.some(v => String(v.id) === String(prior.alt)) ? prior.alt : altFromItem;
    selectedVendorByItem[itemId] = { primary: String(primaryId), alt: String(altId) };

    const renderSlot = (slotKey, label, vendorId, optionPrefix) => {
      const vendor = vendorList.find(v => String(v.id) === String(vendorId));
      const option = vendorOptions.find(v => String(v.vendorId) === String(vendorId)) || {};
      return `
        <div class="vendorCard" style="margin-top:10px">
          <div class="field" style="margin-bottom:8px">
            <label for="${optionPrefix}Picker">${label}</label>
            <select id="${optionPrefix}Picker">
              ${vendorList.map(v => `<option value="${v.id}" ${String(v.id) === String(vendorId) ? 'selected' : ''}>${escapeHtml(v.company)}</option>`).join('')}
            </select>
          </div>
          <dl class="vendorGrid" style="margin-bottom:10px">
            <dt>Contact</dt><dd>${escapeHtml((vendor && vendor.contactName) || '-')}</dd>
            <dt>Email</dt><dd>${vendor && vendor.contactEmail ? `<a href="mailto:${escapeHtml(vendor.contactEmail)}">${escapeHtml(vendor.contactEmail)}</a>` : '-'}</dd>
            <dt>Phone</dt><dd>${escapeHtml((vendor && vendor.contactPhone) || '-')}</dd>
            <dt>On-Time</dt><dd>${vendor && vendor.onTimeScore != null ? `${escapeHtml(vendor.onTimeScore)}%` : '-'}</dd>
            <dt>Part Number</dt><dd>${escapeHtml(option.partNumber || '-')}</dd>
            <dt>Price</dt><dd>${currency(option.price)}</dd>
            <dt>Shipping</dt><dd>${currency(option.shippingCost)}</dd>
            <dt>MOQ</dt><dd>${option.moq ?? '-'}</dd>
            <dt>Lead Time</dt><dd>${option.leadTimeDays != null ? `${escapeHtml(option.leadTimeDays)} days` : '-'}</dd>
          </dl>
          <div class="vendorGrid">
            <label for="${optionPrefix}Part">Part Number</label><input id="${optionPrefix}Part" value="${escapeHtml(option.partNumber || '')}" />
            <label for="${optionPrefix}Price">Order Price</label><input id="${optionPrefix}Price" type="number" step="0.01" value="${escapeHtml(option.price ?? '')}" />
            <label for="${optionPrefix}Ship">Shipping</label><input id="${optionPrefix}Ship" type="number" step="0.01" value="${escapeHtml(option.shippingCost ?? '')}" />
            <label for="${optionPrefix}Moq">MOQ</label><input id="${optionPrefix}Moq" type="number" step="1" value="${escapeHtml(option.moq ?? '')}" />
            <label for="${optionPrefix}Lead">Lead Time</label><input id="${optionPrefix}Lead" type="number" step="1" value="${escapeHtml(option.leadTimeDays ?? '')}" />
          </div>
          <div style="margin-top:10px"><button type="button" id="${optionPrefix}Save" class="btn" style="background:#0b5ed7;color:#fff">Save ${label}</button></div>
        </div>
      `;
    };

    wrap.innerHTML = `
      ${renderSlot('primary', 'Primary Vendor', primaryId, 'primary')}
      ${renderSlot('alt', 'Alt Vendor', altId, 'alt')}
    `;

    const saveSlot = async (slotName, prefix) => {
      const picker = wrap.querySelector(`#${prefix}Picker`);
      const vendorId = picker.value;
      const payload = {
        partNumber: (wrap.querySelector(`#${prefix}Part`).value || '').trim() || null,
        price: normalizeNumberInput(wrap.querySelector(`#${prefix}Price`).value),
        shippingCost: normalizeNumberInput(wrap.querySelector(`#${prefix}Ship`).value),
        moq: normalizeNumberInput(wrap.querySelector(`#${prefix}Moq`).value),
        leadTimeDays: normalizeNumberInput(wrap.querySelector(`#${prefix}Lead`).value)
      };
      const itemPayload = slotName === 'primary' ? { primaryVendorId: Number(vendorId) } : { altVendorId: Number(vendorId) };
      const itemRes = await fetch('/api/items/' + encodeURIComponent(itemId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemPayload)
      });
      if (!itemRes.ok) throw new Error('failed to save item vendor selection');
      const optionRes = await fetch(`/api/items/${encodeURIComponent(itemId)}/vendor-options/${encodeURIComponent(vendorId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!optionRes.ok) throw new Error('failed to save item vendor values');
    };

    wrap.querySelector('#primaryPicker').addEventListener('change', ev => {
      selectedVendorByItem[itemId].primary = ev.target.value;
      renderVendors(item);
    });
    wrap.querySelector('#altPicker').addEventListener('change', ev => {
      selectedVendorByItem[itemId].alt = ev.target.value;
      renderVendors(item);
    });
    wrap.querySelector('#primarySave').addEventListener('click', async () => {
      try { await saveSlot('primary', 'primary'); await show(); }
      catch (err){ alert('Failed to save primary vendor: ' + (err.message || err)); }
    });
    wrap.querySelector('#altSave').addEventListener('click', async () => {
      try { await saveSlot('alt', 'alt'); await show(); }
      catch (err){ alert('Failed to save alt vendor: ' + (err.message || err)); }
    });
  }

  async function show(){
    const id = el('item').value;
    if (!id) return;
    try {
      const itemRes = await fetch('/api/items/' + encodeURIComponent(id));
      if (itemRes.ok) {
        const item = await itemRes.json();
        if (Object.prototype.hasOwnProperty.call(item, 'salePrice')) setSelectedItemSalePrice(item.salePrice);
        renderOrderVendors(item);
        renderVendors(item);
      } else {
        renderOrderVendors({ id, vendorList: [] });
        renderVendors({ id, vendors: [], vendorList: [] });
      }
    } catch (e) {
      renderOrderVendors({ id, vendorList: [] });
      renderVendors({ id, vendors: [], vendorList: [] });
    }

    const fromDate = parseDateInput(el('from').value, false);
    const toDate = parseDateInput(el('to').value, true);
    let events = [];
    let serverSeries = [];
    try{
      const parts = [];
      if (el('from').value) parts.push('from=' + encodeURIComponent(el('from').value));
      if (el('to').value) parts.push('to=' + encodeURIComponent(el('to').value));
      const res = await fetch('/api/items/' + encodeURIComponent(id) + '/history' + (parts.length ? ('?' + parts.join('&')) : ''));
      if (!res.ok) throw new Error('history fetch failed ' + res.status);
      const json = await res.json();
      events = json.events || [];
      serverSeries = json.series || [];
      if (events.length) await IDB.storeRemoteEvents(events);
    }catch(err){
      events = await getLocalHistory(id, fromDate, toDate);
    }

    const to = toDate || new Date();
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999);
    const from = fromDate || (() => {
      const s = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      s.setMonth(s.getMonth() - 11);
      return s;
    })();
    const start = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0);
    const points = (serverSeries && serverSeries.length > 0)
      ? serverSeries.map(s => ({ date: s.date, qty: Number(s.qty) || 0, ts: new Date(`${s.date}T12:00:00`) }))
      : buildDailyLevelSeries(events, start, end);

    if (!points || points.length === 0){
      drawEmpty();
      renderEvents(events || []);
      return;
    }
    drawCountSeries(points, start, end);
    renderEvents(events || []);
  }

  function renderEvents(events){
    const out = el('events');
    out.innerHTML = '';
    events.forEach(e => {
      const d = document.createElement('div');
      d.textContent = `${new Date(e.timestamp).toLocaleString()} | ${e.type} ${e.qty}${e.note ? (' | ' + e.note) : ''}${e.sessionId ? (' session:' + e.sessionId.slice(0,8)) : ''}`;
      out.appendChild(d);
    });
  }

  function resizeCanvas(){
    const wrap = el('chartWrap');
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * DPR);
    canvas.height = Math.floor(rect.height * DPR);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  }

  window.addEventListener('resize', () => { resizeCanvas(); if (lastSeries && lastSeries.length) drawSeries(lastSeries); });

  function drawSeries(series){
    if (!series || !series.length) return;
    lastSeries = series;
    drawCountSeries(series.map(s => ({ date: s.date, qty: s.qty, ts: s.ts || new Date(`${s.date}T12:00:00`) })), new Date(series[0].date), new Date(series[series.length - 1].date));
  }

  function drawCountSeries(points, start, end){
    lastSeries = points.map(p => ({ date: p.date, qty: p.qty, ts: p.ts }));
    resizeCanvas();
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!points || points.length === 0) return;
    const pad = 40 * DPR;
    const w = canvas.width;
    const h = canvas.height;
    const areaW = w - pad * 2;
    const areaH = h - pad * 2;
    const vals = points.map(p => p.qty);
    const minV = Math.min(...vals, 0);
    const maxV = Math.max(...vals, 1);
    const vRange = (maxV - minV) || 1;
    const endTime = end.getTime() === start.getTime() ? start.getTime() + 1 : end.getTime();
    const mapX = ts => pad + ((ts.getTime() - start.getTime()) / (endTime - start.getTime())) * areaW;
    const mapY = v => pad + (1 - (v - minV) / vRange) * areaH;
    ctx.strokeStyle = dark ? '#3a3a3a' : '#e6e6e6';
    ctx.lineWidth = 1 * DPR;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++){
      const yy = pad + (i / 4) * areaH;
      ctx.moveTo(pad, yy);
      ctx.lineTo(pad + areaW, yy);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = '#1976d2';
    ctx.lineWidth = 2 * DPR;
    points.forEach((p,i) => {
      const x = mapX(p.ts);
      const y = mapY(p.qty);
      if (i === 0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    });
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1976d2';
    points.forEach(p => {
      const x = mapX(p.ts);
      const y = mapY(p.qty);
      ctx.beginPath();
      ctx.arc(x,y,4 * DPR,0,Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.fillStyle = dark ? '#e0e0e0' : '#333';
    ctx.font = `${12 * DPR}px sans-serif`;
    ctx.textAlign = 'center';
    for (let m = 0; m < 12; m++){
      const dt = new Date(start.getFullYear(), start.getMonth() + m, 1);
      const x = pad + ((dt.getTime() - start.getTime()) / (endTime - start.getTime())) * areaW;
      const label = dt.toLocaleString(undefined,{ month:'short' });
      ctx.fillText(label, x, h - pad / 2);
    }
    try{
      const sel = el('item');
      const opt = sel && sel.options[sel.selectedIndex];
      const rl = opt && opt.dataset && opt.dataset.reorder ? parseFloat(opt.dataset.reorder) : null;
      if (rl !== null && !Number.isNaN(rl)){
        const y = mapY(rl);
        ctx.strokeStyle = '#c62828';
        ctx.lineWidth = 2 * DPR;
        ctx.setLineDash([6 * DPR,4 * DPR]);
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(pad + areaW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#c62828';
        ctx.font = `${11 * DPR}px sans-serif`;
        ctx.textAlign = 'right';
        ctx.fillText('Reorder: ' + rl, pad + areaW - 6 * DPR, y - 6 * DPR);
      }
    }catch(e){}
  }

  function drawEmpty(){
    resizeCanvas();
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'dark' ? '#bbb' : '#666';
    ctx.font = `${14 * DPR}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('No count events in selected range', canvas.width / 2, canvas.height / 2);
  }

  function posToNearest(evt){
    if (!lastSeries || lastSeries.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * DPR;
    const pad = 40 * DPR;
    const areaW = canvas.width - pad * 2;
    let nearest = null;
    let nd = Infinity;
    const minT = new Date(lastSeries[0].date).getTime();
    const maxT = new Date(lastSeries[lastSeries.length - 1].date).getTime() || minT + 1;
    for (let i = 0; i < lastSeries.length; i++){
      const t = new Date(lastSeries[i].date).getTime();
      const px = pad + ((t - minT) / (maxT - minT || 1)) * areaW;
      const d = Math.abs(px - x);
      if (d < nd){ nd = d; nearest = { i, px }; }
    }
    return nearest;
  }

  function attachCanvasEvents(){
    if (!canvas) return;
    canvas.addEventListener('mousemove', ev => {
      const n = posToNearest(ev);
      if (!n){ tooltip.style.display = 'none'; return; }
      const s = lastSeries[n.i];
      if (!s){ tooltip.style.display = 'none'; return; }
      tooltip.style.display = 'block';
      tooltip.textContent = `${s.date}: ${s.qty}`;
      tooltip.style.left = (n.px / DPR) + 'px';
      tooltip.style.top = '8px';
    });
    canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  }

  window.load = async function(){
    await loadItems();
    const params = qs();
    if (params.itemId) el('item').value = params.itemId;
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    start.setMonth(start.getMonth() - 11);
    el('to').value = formatDate(today);
    el('from').value = formatDate(start);
    syncSelectedItemInputs();
    await show();
  };
  window.show = show;

  window.addEventListener('DOMContentLoaded', () => {
    canvas = el('chartCanvas');
    tooltip = el('tooltip');
    attachCanvasEvents();
    window.load();
    resizeCanvas();
    const saved = localStorage.getItem('invapp.theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    const themeBtn = themeToggle();
    if (themeBtn) themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
    const saveBtn = el('saveReorder');
    if (saveBtn){
      saveBtn.addEventListener('click', async () => {
        const sel = el('item');
        const id = sel.value;
        const trimmedReorder = String(el('reorderInput').value || '').trim();
        const salePrice = normalizeNumberInput(el('salePriceInput').value);
        if (!id) return alert('Select an item');
        const reorderLevel = trimmedReorder ? parseInt(trimmedReorder,10) : null;
        if (trimmedReorder && Number.isNaN(reorderLevel)) return alert('Invalid reorder level');
        try{
          const res = await fetch('/api/items/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify({ reorderLevel, salePrice })
          });
          if (!res.ok) throw new Error('update failed ' + res.status);
          const savedItem = await res.json();
          if (reorderLevel === null) delete sel.options[sel.selectedIndex].dataset.reorder;
          else sel.options[sel.selectedIndex].dataset.reorder = String(reorderLevel);
          setSelectedItemSalePrice(Object.prototype.hasOwnProperty.call(savedItem, 'salePrice') ? savedItem.salePrice : salePrice);
          alert('Item saved');
          await show();
        }catch(e){
          alert('Failed to save item: ' + (e.message || e));
        }
      });
    }
    const sel = el('item');
    if (sel) sel.addEventListener('change', async () => {
      syncSelectedItemInputs();
      await show();
    });
    const from = el('from');
    const to = el('to');
    if (from) from.addEventListener('change', show);
    if (to) to.addEventListener('change', show);
    const prevBtn = el('prevItemBtn');
    const nextBtn = el('nextItemBtn');
    if (prevBtn) prevBtn.addEventListener('click', () => moveItemSelection(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => moveItemSelection(1));
  });
})();
