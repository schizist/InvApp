// Simple client app: register sw, list items, queue events, sync
(async function(){
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); console.log('SW registered'); } catch(e){console.warn('SW failed',e);} 
  }

  const statusEl = document.getElementById('status');
  const itemsEl = document.getElementById('items');
  const queuedEl = document.getElementById('queued');
  const syncBtn = document.getElementById('syncBtn');

  function setStatus(s){ statusEl.textContent = 'Status: '+s; }
  function uuidv4(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{const r=Math.random()*16|0;const v=c=='x'?r:(r&0x3|0x8);return v.toString(16);}); }

  function getUnitInfo(category){
    // returns {multiplier, label}
    switch((category||'').toLowerCase()){
      case 'wire': return {multiplier:100, label:"100ft"};
      case 'cap': return {multiplier:100, label:"100pcs"};
      case 'shot': return {multiplier:20, label:"20pcs"};
      case 'mold': return {multiplier:1, label:"pcs"};
      case 'enclosure': return {multiplier:1, label:"pcs"};
      case 'anode': return {multiplier:1, label:"pcs"};
      default: return {multiplier:1, label:"pcs"};
    }
  }

  async function fetchItems(){
    const res = await fetch('/api/items');
    return res.json();
  }

  async function fetchSummary(){
    const res = await fetch('/api/summary');
    return res.json();
  }

  function renderItems(items, summaryMap, queuedMap){
    itemsEl.innerHTML = '';
    items.forEach(it => {
      const tpl = document.getElementById('itemTpl');
      const node = tpl.content.cloneNode(true);
      node.querySelector('.label').textContent = it.label;
      const sm = summaryMap[it.id] || {qty:0,lastUpdate:null};
      const queuedDelta = (queuedMap && queuedMap[it.id]) ? queuedMap[it.id] : 0;
      const unit = getUnitInfo(it.category);
      const baseQty = sm.qty || 0;
      const projectedBase = baseQty + queuedDelta;
      const displayQty = (unit.multiplier>1) ? (projectedBase / unit.multiplier) : projectedBase;
      const metaEl = node.querySelector('.meta');
      metaEl.innerHTML = '';
      // pre-sync server total
      const pre = document.createElement('span'); pre.className = 'pre'; pre.textContent = baseQty;
      // queued delta (center column)
      const delta = document.createElement('span'); delta.className = 'delta';
      const deltaDisplay = (unit.multiplier>1) ? (queuedDelta / unit.multiplier) : queuedDelta;
      delta.textContent = (queuedDelta>0?'+':'') + deltaDisplay;
      // projected total
      const qtySpan = document.createElement('span'); qtySpan.className = 'qty'; qtySpan.textContent = projectedBase;
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

      // + / - now add or subtract one display unit (multiplied by category multiplier)
      btnPlus.setAttribute('aria-label', `Add one ${unit.label} to ${it.label}`);
      btnMinus.setAttribute('aria-label', `Subtract one ${unit.label} from ${it.label}`);
      btnSet.setAttribute('aria-label', `Set absolute count for ${it.label}`);

      btnPlus.addEventListener('click', async ()=>{
        const unitInfo = getUnitInfo(it.category);
        const qty = unitInfo.multiplier; // one unit in base quantity
        const ev = { id: uuidv4(), itemId: it.id, type: 'DELTA', qty: qty, timestamp: new Date().toISOString(), source: 'mobile' };
        await IDB.addEvent(ev);
        await refreshAll();
      });

      btnMinus.addEventListener('click', async ()=>{
        const unitInfo = getUnitInfo(it.category);
        const qty = -unitInfo.multiplier; // subtract one unit
        const ev = { id: uuidv4(), itemId: it.id, type: 'DELTA', qty: qty, timestamp: new Date().toISOString(), source: 'mobile' };
        await IDB.addEvent(ev);
        await refreshAll();
      });

      btnSet.addEventListener('click', async ()=>{
        const val = prompt('Enter absolute count for '+it.label);
        if (val===null) return;
        const n = parseInt(val,10);
        if (Number.isNaN(n)) { alert('Invalid number'); return; }
        const unitInfo = getUnitInfo(it.category);
        const qty = n * unitInfo.multiplier;
        const ev = { id: uuidv4(), itemId: it.id, type: 'SET', qty: qty, timestamp: new Date().toISOString(), source: 'mobile' };
        await IDB.addEvent(ev);
        await refreshQueued();
      });
      itemsEl.appendChild(node);
    });
  }

  async function refreshQueued(){
    const q = await IDB.getQueued();
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
    try{
      setStatus('syncing');
      const q = await IDB.getQueued();
      if (q.length>0){
        const res = await fetch('/api/events', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(q) });
        const json = await res.json();
        // remove inserted ones (we assume successful insertion)
        const ids = q.map(e=>e.id);
        await IDB.clearEvents(ids);
      }
      // fetch remote events to store locally if needed
      const since = new Date(0).toISOString();
      const remote = await fetch('/api/events?since='+encodeURIComponent(since)).then(r=>r.json());
      await IDB.storeRemoteEvents(remote);
      setStatus('up to date');
      await refreshAll();
    }catch(e){
      console.error(e); setStatus('sync failed');
    }
  }

  async function refreshAll(){
    try{
      const [items, summary] = await Promise.all([fetchItems(), fetchSummary()]);
      const summaryMap = {};
      summary.forEach(s=>summaryMap[s.itemId]=s);
      const queuedMap = await getQueuedMap();
      renderItems(items, summaryMap, queuedMap);
      await refreshQueued();
    }catch(e){
      console.warn('offline or fetch failed',e);
      // fall back to local remoteEvents if available
      const remote = await IDB.getAllRemote();
      const map = {};
      remote.forEach(ev => { map[ev.itemId] = map[ev.itemId] || {qty:0}; if (ev.type==='SET') map[ev.itemId].qty = ev.qty; else map[ev.itemId].qty = (map[ev.itemId].qty||0)+ev.qty; });
      // fetch local items list from embedded fallback
      const items = [{id:'wire_8',label:'#8',category:'wire'}];
      renderItems(items,map, {});
      await refreshQueued();
    }
  }

  syncBtn.addEventListener('click', syncOnce);

  window.addEventListener('online', ()=>{ setStatus('online'); syncOnce(); });
  window.addEventListener('offline', ()=>{ setStatus('offline'); });

  // initial
  setStatus(navigator.onLine ? 'online' : 'offline');
  await refreshAll();
  await refreshQueued();
})();
