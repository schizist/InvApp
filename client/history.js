(function(){
  function qs(){ return Object.fromEntries(new URLSearchParams(location.search)); }
  function el(id){ return document.getElementById(id); }
  const themeToggle = () => el('themeToggle');

  function applyTheme(t){
    const next = t === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', next);
    localStorage.setItem('invapp.theme', next);
    const btn = themeToggle();
    if (btn) btn.textContent = next === 'dark' ? 'Light' : 'Dark';
    if (lastSeries && lastSeries.length > 0) drawSeries(lastSeries);
  }

  async function loadItems(){
    const items = await fetch('/api/items').then(r=>r.json()).catch(()=>[]);
    const sel = el('item'); sel.innerHTML='';
    items.forEach(it=>{ const o=document.createElement('option'); o.value=it.id; o.textContent=it.label; if (typeof it.reorderLevel !== 'undefined' && it.reorderLevel !== null) o.dataset.reorder = String(it.reorderLevel); sel.appendChild(o); });
  }

  function formatDate(d){ return d.toISOString().slice(0,10); }

  // fetch events/history and draw COUNT session points across 12 months
  async function show(){
    const id = el('item').value; if (!id) return;
    const qs = [];
    if (el('from').value) qs.push('from='+encodeURIComponent(el('from').value));
    if (el('to').value) qs.push('to='+encodeURIComponent(el('to').value));
    let res;
    try{
      res = await fetch('/api/items/'+encodeURIComponent(id)+'/history'+(qs.length?('?'+qs.join('&')):''));
    }catch(err){
      console.error('Network error fetching history', err);
      el('events').innerHTML = '<div style="color:#c62828">Network error</div>';
      return;
    }
    if (!res.ok){
      let body = '';
      try{ body = await res.text(); }catch(e){}
      console.error('History fetch failed', res.status, body);
      el('events').innerHTML = `<div style="color:#c62828">Failed to fetch history — HTTP ${res.status}</div>`;
      return;
    }
    const json = await res.json();
    // extract COUNT session events and map
    const countEvents = (json.events||[]).filter(e=>e.type==='COUNT').map(e=>({ ts: new Date(e.timestamp), qty: e.qty }));
    const to = el('to').value ? new Date(el('to').value) : new Date();
    const end = new Date(to.getFullYear(), to.getMonth(), 1, 23,59,59,999);
    const start = new Date(end.getFullYear(), end.getMonth(), 1); start.setMonth(start.getMonth()-11);
    const ptsFiltered = countEvents.filter(e => e.ts >= start && e.ts <= end).sort((a,b)=>a.ts - b.ts);
    if (ptsFiltered.length === 0){ drawEmpty(); renderEvents(json.events||[]); return; }
    const pts = ptsFiltered.map(p=>({ date: p.ts.toISOString().slice(0,10), qty: p.qty, ts: p.ts }));
    drawCountSeries(pts, start, end);
    renderEvents(json.events||[]);
  }

  function renderEvents(events){
    const out = el('events'); out.innerHTML='';
    events.forEach(e=>{
      const d=document.createElement('div'); d.textContent = `${new Date(e.timestamp).toLocaleString()} • ${e.type} ${e.qty} ${e.note?('• '+e.note):''} ${e.sessionId?(' session:'+e.sessionId.slice(0,8)):''}`;
      out.appendChild(d);
    });
  }

  // interactive canvas chart
  let canvas, tooltip;
  const DPR = window.devicePixelRatio || 1;
  function resizeCanvas(){
    const wrap = document.getElementById('chartWrap');
    if (!canvas) return;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * DPR);
    canvas.height = Math.floor(rect.height * DPR);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  }

  window.addEventListener('resize', ()=>{ resizeCanvas(); if (lastSeries) drawSeries(lastSeries); });

  let lastSeries = [];
  function drawSeries(series){
    lastSeries = series;
    resizeCanvas();
    const dark = document.body.getAttribute('data-theme') === 'dark';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!series || series.length===0) return;
    // draw bar chart per day, with reorder line if provided
    const pad = 40 * DPR;
    const w = canvas.width; const h = canvas.height;
    const areaW = w - pad*2; const areaH = h - pad*2;
    const vals = series.map(s=>s.qty);
    const minV = Math.min(...vals, 0); const maxV = Math.max(...vals, 1);
    const vRange = (maxV - minV) || 1;
    const barW = areaW / series.length * 0.8;
    // grid lines
    ctx.strokeStyle = dark ? '#3a3a3a' : '#e6e6e6'; ctx.lineWidth = 1 * DPR;
    ctx.beginPath();
    for (let i=0;i<=4;i++){ const yy = pad + (i/4)*areaH; ctx.moveTo(pad, yy); ctx.lineTo(pad+areaW, yy); }
    ctx.stroke();
    // draw bars
    series.forEach((s,i)=>{
      const x = pad + i * (areaW / series.length) + (areaW/series.length - barW)/2;
      const y = pad + (1 - (s.qty - minV)/vRange) * areaH;
      const bh = pad + areaH - y;
      ctx.fillStyle = '#1976d2';
      ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(barW), Math.floor(bh));
    });
    // draw x labels
    ctx.fillStyle = dark ? '#e0e0e0' : '#333'; ctx.font = `${12*DPR}px sans-serif`; ctx.textAlign='center';
    series.forEach((s,i)=>{ const x = pad + i * (areaW / series.length) + (areaW/series.length)/2; ctx.fillText(s.date, x, h - pad/2); });
    // if current item has reorderLevel stored in dataset, draw horizontal reorder line
    try{
      const sel = document.getElementById('item'); const opt = sel && sel.options[sel.selectedIndex];
      const rl = opt && opt.dataset && opt.dataset.reorder ? parseFloat(opt.dataset.reorder) : null;
      if (rl !== null && !Number.isNaN(rl)){
        const y = pad + (1 - (rl - minV)/vRange) * areaH;
        ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2*DPR; ctx.setLineDash([6*DPR,4*DPR]);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(pad+areaW, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#c62828'; ctx.font = `${11*DPR}px sans-serif`; ctx.textAlign='right'; ctx.fillText('Reorder: '+rl, pad+areaW-6*DPR, y - 6*DPR);
      }
    }catch(e){ /* ignore */ }
  }

  // draw COUNT session points connected with line on a 12-month axis
  function drawCountSeries(points, start, end){
    lastSeries = points.map(p=>({ date: p.date, qty: p.qty, ts: p.ts }));
    resizeCanvas();
    const dark = document.body.getAttribute('data-theme') === 'dark';
    const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!points || points.length===0) return;
    const pad = 40 * DPR; const w = canvas.width; const h = canvas.height; const areaW = w - pad*2; const areaH = h - pad*2;
    const vals = points.map(p=>p.qty); const minV = Math.min(...vals, 0); const maxV = Math.max(...vals, 1); const vRange = (maxV - minV) || 1;
    // draw grid
    ctx.strokeStyle = dark ? '#3a3a3a' : '#e6e6e6'; ctx.lineWidth = 1*DPR; ctx.beginPath(); for (let i=0;i<=4;i++){ const yy = pad + (i/4)*areaH; ctx.moveTo(pad, yy); ctx.lineTo(pad+areaW, yy); } ctx.stroke();
    // map functions
    const mapX = (ts) => pad + ((ts.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * areaW;
    const mapY = (v) => pad + (1 - (v - minV)/vRange) * areaH;
    // draw line connecting points
    ctx.beginPath(); ctx.strokeStyle = '#1976d2'; ctx.lineWidth = 2*DPR; points.forEach((p,i)=>{ const x=mapX(p.ts); const y=mapY(p.qty); if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }); ctx.stroke();
    // draw points
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1976d2'; points.forEach(p=>{ const x=mapX(p.ts); const y=mapY(p.qty); ctx.beginPath(); ctx.arc(x,y,4*DPR,0,Math.PI*2); ctx.fill(); ctx.stroke(); });
    // x axis months labels (12 months)
    ctx.fillStyle = dark ? '#e0e0e0' : '#333'; ctx.font = `${12*DPR}px sans-serif`; ctx.textAlign = 'center';
    for (let m=0;m<12;m++){ const dt = new Date(start.getFullYear(), start.getMonth()+m, 1); const x = pad + ((dt.getTime() - start.getTime())/(end.getTime()-start.getTime()))*areaW; const label = dt.toLocaleString(undefined,{month:'short'}); ctx.fillText(label, x, h - pad/2); }
    // draw reorder line if present
    try{
      const sel = document.getElementById('item'); const opt = sel && sel.options[sel.selectedIndex]; const rl = opt && opt.dataset && opt.dataset.reorder ? parseFloat(opt.dataset.reorder) : null;
      if (rl !== null && !Number.isNaN(rl)){
        const y = mapY(rl);
        ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2*DPR; ctx.setLineDash([6*DPR,4*DPR]); ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(pad+areaW, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#c62828'; ctx.font = `${11*DPR}px sans-serif`; ctx.textAlign='right'; ctx.fillText('Reorder: '+rl, pad+areaW-6*DPR, y - 6*DPR);
      }
    }catch(e){}
  }

  function posToNearest(evt){
    if (!lastSeries || lastSeries.length===0) return null;
    const rect = canvas.getBoundingClientRect(); const x = (evt.clientX - rect.left) * DPR;
    // compute nearest by x
    const points = lastSeries.map((s,i)=>{ const d=new Date(s.date); return {i, x: (d.getTime()-new Date(lastSeries[0].date).getTime())/(new Date(lastSeries[lastSeries.length-1].date).getTime()-new Date(lastSeries[0].date).getTime()||1)} });
    // map to canvas coords
    const pad = 40 * DPR; const areaW = canvas.width - pad*2;
    let nearest = null; let nd = Infinity;
    for (let i=0;i<lastSeries.length;i++){ const t = new Date(lastSeries[i].date).getTime(); const minT = new Date(lastSeries[0].date).getTime(); const maxT = new Date(lastSeries[lastSeries.length-1].date).getTime()||minT+1; const px = pad + ((t-minT)/(maxT-minT||1))*areaW; const d = Math.abs(px - x); if (d < nd){ nd = d; nearest = {i, px}; } }
    return nearest;
  }

  // attach events after DOM is ready
  function attachCanvasEvents(){
    if (!canvas) return;
    canvas.addEventListener('mousemove', (ev)=>{
    const n = posToNearest(ev); if (!n) { tooltip.style.display='none'; return; }
    const s = lastSeries[n.i]; if (!s) { tooltip.style.display='none'; return; }
    tooltip.style.display='block'; tooltip.textContent = `${s.date}: ${s.qty}`;
    const rect = canvas.getBoundingClientRect(); tooltip.style.left = (n.px / DPR) + 'px'; tooltip.style.top = '8px';
    });
    canvas.addEventListener('mouseleave', ()=>{ tooltip.style.display='none'; });
  }

  // wire up page
  window.load = async function(){
    await loadItems();
    const params = qs();
    if (params.itemId){ el('item').value = params.itemId; }
    // default date range: last 12 months
    const today = new Date(); const start = new Date(today.getFullYear(), today.getMonth(), 1); start.setMonth(start.getMonth()-11);
    el('to').value = formatDate(today); el('from').value = formatDate(start);
    // populate reorder input for selected item
    const sel = el('item'); const opt = sel && sel.options[sel.selectedIndex]; el('reorderInput').value = opt && opt.dataset && opt.dataset.reorder ? opt.dataset.reorder : '';
    // auto-load history for selected item
    await show();
  };
  // expose show to inline button
  window.show = show;

  // initial init after DOM ready
  window.addEventListener('DOMContentLoaded', ()=>{ canvas = el('chartCanvas'); tooltip = el('tooltip'); attachCanvasEvents(); window.load(); resizeCanvas();
    const saved = localStorage.getItem('invapp.theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    const themeBtn = themeToggle();
    if (themeBtn){ themeBtn.addEventListener('click', ()=>{ const cur = document.body.getAttribute('data-theme'); applyTheme(cur === 'dark' ? 'light' : 'dark'); }); }
    // wire save reorder
    const saveBtn = el('saveReorder'); if (saveBtn){ saveBtn.addEventListener('click', async ()=>{
      const sel = el('item'); const id = sel.value; const val = el('reorderInput').value; if (!id) return alert('Select an item'); const n = parseInt(val,10); if (Number.isNaN(n)) return alert('Invalid number');
      try{
        const res = await fetch('/api/items/'+encodeURIComponent(id), { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ reorderLevel: n }) });
        if (!res.ok) throw new Error('update failed '+res.status);
        // update option dataset and redraw
        sel.options[sel.selectedIndex].dataset.reorder = String(n);
        alert('Reorder level saved');
        await show();
      }catch(e){ console.error(e); alert('Failed to save reorder: '+(e.message||e)); }
    }); }
    // populate reorder input when selection changes
    const sel = el('item'); sel && sel.addEventListener('change', async ()=>{ const opt = sel.options[sel.selectedIndex]; el('reorderInput').value = opt && opt.dataset && opt.dataset.reorder ? opt.dataset.reorder : ''; await show(); });
  });
})();
