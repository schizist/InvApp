// Simple client app: register sw, list items, queue events, sync
(async function(){
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); console.log('SW registered'); } catch(e){console.warn('SW failed',e);} 
  }

  const statusEl = document.getElementById('status');
  const statusPillEl = document.getElementById('statusPill');
  const queuedCountEl = document.getElementById('queuedCount');
  const itemsEl = document.getElementById('items');
  const queuedEl = document.getElementById('queued');
  const syncBtn = document.getElementById('syncBtn');
  const OCCASIONAL_SYNC_MS = 5 * 60 * 1000;
  let syncInFlight = null;

  function setStatus(s){
    const online = s === 'online' || s === 'syncing' || s === 'up to date';
    if (statusEl) statusEl.textContent = 'Status: ' + s;
    if (statusPillEl) {
      statusPillEl.textContent = online ? 'Online' : 'Offline';
      statusPillEl.classList.toggle('online', online);
      statusPillEl.classList.toggle('offline', !online);
    }
  }
  function uuidv4(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{const r=Math.random()*16|0;const v=c=='x'?r:(r&0x3|0x8);return v.toString(16);}); }

  function getUnitInfo(category){
    // returns {multiplier, label}
    switch((category||'').toLowerCase()){
      case 'wire': return {multiplier:500, label:"500ft"};
      case 'cap': return {multiplier:100, label:"100pcs"};
      case 'shot': return {multiplier:20, label:"20pcs"};
      case 'mold': return {multiplier:1, label:"pcs"};
      case 'enclosure': return {multiplier:1, label:"pcs"};
      case 'anode': return {multiplier:1, label:"pcs"};
      default: return {multiplier:1, label:"pcs"};
    }
  }

  function getBundledItems(){
    return Array.isArray(window.INVAPP_DEFAULT_ITEMS) ? window.INVAPP_DEFAULT_ITEMS : [];
  }

  async function fetchItems(){
    try{
      const res = await fetch('/api/items');
      if (!res.ok) throw new Error('items fetch failed');
      const items = await res.json();
      await IDB.setLastItems(items);
      return items;
    }catch(e){
      setStatus('offline');
      const localItems = await IDB.getLastItems();
      if (localItems && localItems.length) return localItems;
      return getBundledItems();
    }
  }

  // session helpers
  let currentSession = null;
  async function loadSession(){
    const sid = await IDB.getSession();
    currentSession = sid;
    updateSessionUI();
  }
  async function startSession(){
    const sid = uuidv4();
    await IDB.setSession(sid);
    currentSession = sid;
    updateSessionUI();
  }
  async function endSession(){
    await IDB.setSession(null);
    currentSession = null;
    updateSessionUI();
  }
  function updateSessionUI(){
    const startBtn = document.getElementById('startSessionBtn');
    const endBtn = document.getElementById('endSessionBtn');
    const info = document.getElementById('sessionInfo');
    if (currentSession){
      if (startBtn) startBtn.style.display='none';
      if (endBtn) endBtn.style.display='inline-block';
      if (info) info.textContent = `Session: ${currentSession.slice(0,8)}`;
    }
    else {
      if (startBtn) startBtn.style.display='inline-block';
      if (endBtn) endBtn.style.display='none';
      if (info) info.textContent = '';
    }
  }

  async function fetchSummary(){
    try{
      const res = await fetch('/api/summary');
      if (!res.ok) throw new Error('summary fetch failed');
      return await res.json();
    }catch(e){
      setStatus('offline');
      const remote = await IDB.getAllRemote();
      const map = {};
      remote.forEach(ev => {
        map[ev.itemId] = map[ev.itemId] || { itemId: ev.itemId, qty: 0, lastUpdate: null };
        if (ev.type === 'COUNT') map[ev.itemId].qty = ev.qty;
        else map[ev.itemId].qty = (map[ev.itemId].qty || 0) + ev.qty;
        map[ev.itemId].lastUpdate = ev.timestamp;
      });
      return Object.values(map);
    }
  }

  function buildSummaryFromEvents(events){
    const byItem = {};
    (events || []).forEach(ev => {
      if (!ev || !ev.itemId) return;
      if (!byItem[ev.itemId]) byItem[ev.itemId] = [];
      byItem[ev.itemId].push(ev);
    });
    const out = {};
    Object.keys(byItem).forEach(itemId => {
      const evs = byItem[itemId].slice().sort((a,b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      let qty = 0;
      let lastUpdate = null;
      let lastCountIndex = -1;
      for (let i = 0; i < evs.length; i++) {
        if (evs[i].type === 'COUNT') lastCountIndex = i;
      }
      if (lastCountIndex >= 0) {
        qty = evs[lastCountIndex].qty || 0;
        for (let j = lastCountIndex + 1; j < evs.length; j++) {
          if (evs[j].type === 'DELTA') qty += (evs[j].qty || 0);
        }
      } else {
        evs.forEach(e => { if (e.type === 'DELTA') qty += (e.qty || 0); });
      }
      if (evs.length > 0) lastUpdate = evs[evs.length - 1].timestamp || null;
      out[itemId] = { itemId, qty, lastUpdate };
    });
    return out;
  }

  function computeLocalQty(itemId, summaryMap, queuedMap){
    const base = (summaryMap && summaryMap[itemId] && summaryMap[itemId].qty) ? summaryMap[itemId].qty : 0;
    const queued = (queuedMap && queuedMap[itemId]) ? queuedMap[itemId] : 0;
    return { baseQty: base, queuedDelta: queued, currentQty: base + queued };
  }

  async function getLocalViewState(){
    const [items, remoteEvents, queued] = await Promise.all([
      IDB.getLastItems(),
      IDB.getAllRemote(),
      IDB.getQueued()
    ]);
    const summaryMap = buildSummaryFromEvents(remoteEvents || []);
    const queuedMap = {};
    (queued || []).forEach(ev => { queuedMap[ev.itemId] = (queuedMap[ev.itemId] || 0) + (ev.qty || 0); });
    return { items: items || [], summaryMap, queued: queued || [], queuedMap };
  }

  async function renderLocalView(){
    const state = await getLocalViewState();
    renderItems(state.items, state.summaryMap, state.queuedMap);
    await refreshQueued(state.queued);
  }

  // sync helpers (retry/backoff)
  function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

  async function uploadQueuedWithRetry(maxAttempts = 3){
    let attempt = 0;
    let delay = 1000;
    let totalProcessed = 0;
    while (attempt < maxAttempts){
      attempt++;
      try{
        const q = await IDB.getQueued();
        if (!q || q.length === 0) return { processed: totalProcessed };
        const processedIds = [];
        for (const ev of q){
          const res = await fetch('/api/events', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(ev) });
          if (!res.ok) throw new Error('upload failed: ' + res.status);
          const json = await res.json();
          const uploaded = (json.inserted || 0) + (json.ignored || 0);
          if (uploaded > 0) processedIds.push(ev.id);
        }
        if (processedIds.length){
          totalProcessed += processedIds.length;
          await IDB.clearEvents(processedIds);
        }
        return { processed: totalProcessed };
      }catch(e){
        console.warn('upload attempt', attempt, 'failed', e.message || e);
        if (attempt >= maxAttempts) throw e;
        await wait(delay);
        delay = Math.min(30000, delay * 2);
      }
    }
  }

  async function fetchUpdatesSince(last){
    const since = last || new Date(0).toISOString();
    const res = await fetch('/api/events?since='+encodeURIComponent(since));
    if (!res.ok) throw new Error('fetch updates failed');
    const events = await res.json();
    if (events && events.length>0){
      await IDB.storeRemoteEvents(events);
      // compute newest timestamp
      const maxTs = events.reduce((m,e)=> e.timestamp > m ? e.timestamp : m, last || events[0].timestamp);
      await IDB.setLastSynced(maxTs);
      await IDB.setLastSyncTime(maxTs);
      return { eventsCount: events.length, last: maxTs };
    } else {
      // still update lastSynced to now to mark we've checked
      const now = new Date().toISOString();
      await IDB.setLastSynced(now);
      await IDB.setLastSyncTime(now);
      return { eventsCount: 0, last: now };
    }
  }

  function renderItems(items, summaryMap, queuedMap){
    itemsEl.innerHTML = '';
    const byCategory = {};
    (items || []).forEach(it => {
      const key = (it.category || 'other').toLowerCase();
      byCategory[key] = byCategory[key] || [];
      byCategory[key].push(it);
    });
    Object.keys(byCategory).sort((a,b)=>a.localeCompare(b)).forEach(category => {
      const section = document.createElement('details');
      section.className = 'categoryGroup';
      section.open = true;
      const summary = document.createElement('summary');
      summary.className = 'categoryTitle';
      summary.textContent = `${category.toUpperCase()} (${byCategory[category].length})`;
      section.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'categoryItems';

      byCategory[category].forEach(it => {
        const tpl = document.getElementById('itemTpl');
        const node = tpl.content.cloneNode(true);
        const labelEl = node.querySelector('.labelText');
        labelEl.textContent = it.label;
        if (labelEl.classList.contains('labelLink')) labelEl.href = '/history.html?itemId='+encodeURIComponent(it.id);
        const sm = summaryMap[it.id] || {qty:0,lastUpdate:null};
        const qtyState = computeLocalQty(it.id, summaryMap, queuedMap);
        const queuedDelta = qtyState.queuedDelta;
        const unit = getUnitInfo(it.category);
        const baseQty = qtyState.baseQty;
        const projectedBase = qtyState.currentQty;
        const displayQty = (unit.multiplier>1) ? (projectedBase / unit.multiplier) : projectedBase;
        const metaEl = node.querySelector('.meta');
        metaEl.innerHTML = '';
        const pre = document.createElement('span'); pre.className = 'pre'; pre.textContent = `Existing: ${baseQty}`;
        const delta = document.createElement('span'); delta.className = 'delta';
        delta.textContent = `Delta: ${(queuedDelta>0?'+':'') + queuedDelta}`;
        const qtySpan = document.createElement('span'); qtySpan.className = 'qty'; qtySpan.textContent = `Current: ${projectedBase}`;
        const dispSpan = document.createElement('span'); dispSpan.className = 'display'; dispSpan.textContent = `(${displayQty} × ${unit.label})`;
        metaEl.appendChild(pre);
        metaEl.appendChild(delta);
        metaEl.appendChild(qtySpan);
        metaEl.appendChild(dispSpan);
        if (sm.lastUpdate) {
          const last = document.createElement('span'); last.className = 'last'; last.style.marginLeft = '8px'; last.style.fontSize = '0.85rem'; last.style.color = '#666'; last.textContent = '• '+new Date(sm.lastUpdate).toLocaleString();
          metaEl.appendChild(last);
        }
        const btnPlus = node.querySelector('.btnPlus');
        const btnMinus = node.querySelector('.btnMinus');
        const btnSet = node.querySelector('.btnSet');
        const badge = node.querySelector('.reorderBadge');
        if (typeof it.reorderLevel !== 'undefined' && it.reorderLevel !== null){ if (sm && (sm.qty || 0) <= (it.reorderLevel || 0)) { badge.style.display = 'inline-block'; } else { badge.style.display = 'none'; } }
        btnPlus.setAttribute('aria-label', `Add one ${unit.label} to ${it.label}`);
        btnMinus.setAttribute('aria-label', `Subtract one ${unit.label} from ${it.label}`);
        btnSet.setAttribute('aria-label', `Set absolute count for ${it.label}`);
        btnPlus.addEventListener('click', async ()=>{
          const unitInfo = getUnitInfo(it.category);
          const ev = { id: uuidv4(), itemId: it.id, type: 'DELTA', qty: unitInfo.multiplier, timestamp: new Date().toISOString(), source: 'mobile' };
          await queueEvent(ev);
        });
        btnMinus.addEventListener('click', async ()=>{
          const unitInfo = getUnitInfo(it.category);
          const ev = { id: uuidv4(), itemId: it.id, type: 'DELTA', qty: -unitInfo.multiplier, timestamp: new Date().toISOString(), source: 'mobile' };
          await queueEvent(ev);
        });
        btnSet.addEventListener('click', async ()=>{
          const val = prompt('Enter absolute count for '+it.label);
          if (val===null) return;
          const n = parseInt(val,10);
          if (Number.isNaN(n)) { alert('Invalid number'); return; }
          const ev = { id: uuidv4(), itemId: it.id, type: 'COUNT', qty: n, timestamp: new Date().toISOString(), source: 'mobile', sessionId: currentSession };
          await queueEvent(ev);
        });
        body.appendChild(node);
      });

      section.appendChild(body);
      itemsEl.appendChild(section);
    });
  }

  async function refreshQueued(preloaded){
    const q = preloaded || await IDB.getQueued();
    if (queuedCountEl) queuedCountEl.textContent = String((q || []).length);
    if (!q || q.length===0) {
      queuedEl.textContent = 'No queued events';
    } else {
      queuedEl.innerHTML = '';
      q.forEach(ev => {
        const d = document.createElement('div'); d.textContent = `${ev.type} ${ev.qty} → ${ev.itemId} @ ${new Date(ev.timestamp).toLocaleString()}`;
        queuedEl.appendChild(d);
      });
    }
  }

  async function getQueuedMap(){
    const q = await IDB.getQueued();
    const map = {};
    q.forEach(ev => { map[ev.itemId] = (map[ev.itemId]||0) + (ev.qty||0); });
    return map;
  }

  async function syncOnce(){
    if (syncInFlight) return syncInFlight;
    syncInFlight = (async () => {
    if (!navigator.onLine){
      setStatus('offline');
      await refreshQueued();
      return;
    }
    try{
      setStatus('syncing');
      try { syncBtn.disabled = true; syncBtn.classList.add('loading'); syncBtn.textContent = 'Syncing'; } catch(e){}

      // 1) upload queued with retry
      try{
        await uploadQueuedWithRetry(5);
      }catch(e){
        console.error('Upload failed after retries', e);
        setStatus('sync failed (upload)');
        try { syncBtn.disabled = false; syncBtn.classList.remove('loading'); syncBtn.textContent = 'Sync Now'; } catch(e){}
        return;
      }

      // 2) fetch updates since lastSynced
      const last = await IDB.getLastSyncTime() || await IDB.getLastSynced() || new Date(0).toISOString();
      try{
        await fetchUpdatesSince(last);
      }catch(e){
        console.warn('fetch updates failed', e);
        // still continue to refresh UI from local state
      }

      setStatus('up to date');
      await refreshAll();
      try { syncBtn.disabled = false; syncBtn.classList.remove('loading'); syncBtn.textContent = 'Sync Now'; } catch(e){}
    }catch(e){
      console.error(e); setStatus('sync failed');
      try { syncBtn.disabled = false; syncBtn.classList.remove('loading'); syncBtn.textContent = 'Sync Now'; } catch(e){}
    }
    })();
    try{
      await syncInFlight;
    }finally{
      syncInFlight = null;
    }
  }

  async function queueEvent(ev){
    await IDB.addEvent(ev);
    await renderLocalView();
    if (navigator.onLine){
      syncOnce().catch(err => console.warn('post-save sync failed', err));
    }
  }

  async function refreshAll(){
    if (!navigator.onLine){
      setStatus('offline');
      await renderLocalView();
      return;
    }
    try{
      const [items, summary] = await Promise.all([fetchItems(), fetchSummary()]);
      const summaryMap = {};
      summary.forEach(s=>summaryMap[s.itemId]=s);
      const queuedMap = await getQueuedMap();
      renderItems(items, summaryMap, queuedMap);
      await refreshQueued();
    }catch(e){
      console.warn('offline or fetch failed', e);
      setStatus('offline');
      await renderLocalView();
    }
  }

  // manual sync button
  syncBtn.addEventListener('click', async ()=>{
    await syncOnce();
  });

  // ensure navigation is never gated by online state
  const barsLink = document.getElementById('barsLink');
  const historyLink = document.getElementById('historyLink');
  if (barsLink) barsLink.addEventListener('click', () => { window.location.href = '/bars.html'; });
  if (historyLink) historyLink.addEventListener('click', () => { window.location.href = '/history.html'; });

  window.addEventListener('online', ()=>{ setStatus('online'); syncOnce(); });
  window.addEventListener('offline', ()=>{ setStatus('offline'); refreshQueued(); });

  // occasional background retry while app remains open
  setInterval(() => { if (navigator.onLine) syncOnce(); }, OCCASIONAL_SYNC_MS);

  // initial
  setStatus(navigator.onLine ? 'online' : 'offline');
  await refreshAll();
  await refreshQueued();
  if (navigator.onLine) syncOnce().catch(err => console.warn('initial sync failed', err));
  // theme: apply persisted theme and wire toggle
  (function(){
    const toggle = document.getElementById('themeToggle');
    function applyTheme(t){
      const next = t === 'dark' ? 'dark' : 'light';
      document.body.setAttribute('data-theme', next);
      localStorage.setItem('invapp.theme', next);
      if (toggle) toggle.textContent = (next==='dark') ? 'Light' : 'Dark';
    }
    const saved = localStorage.getItem('invapp.theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    if (toggle) toggle.addEventListener('click', ()=>{ const cur = document.body.getAttribute('data-theme'); applyTheme(cur==='dark' ? 'light' : 'dark'); });
  })();
})();
