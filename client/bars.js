(function(){
  const chartsEl = document.getElementById('charts');
  const themeToggle = document.getElementById('themeToggle');
  const DPR = window.devicePixelRatio || 1;
  let lastGroups = [];

  function applyTheme(t){
    const next = t === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', next);
    localStorage.setItem('invapp.theme', next);
    if (themeToggle) themeToggle.textContent = next === 'dark' ? 'Light' : 'Dark';
    if (lastGroups.length) renderCharts(lastGroups);
  }

  function groupByCategory(data){
    const out = {};
    data.forEach(it => {
      const key = (it.category || 'other').toLowerCase();
      out[key] = out[key] || [];
      out[key].push(it);
    });
    return Object.keys(out).sort((a,b)=>a.localeCompare(b)).map(key => ({ category: key, items: out[key] }));
  }

  async function load(){
    const bundledItems = Array.isArray(window.INVAPP_DEFAULT_ITEMS) ? window.INVAPP_DEFAULT_ITEMS : [];
    let items = [];
    let summary = [];
    try{
      const [itemsRes, summaryRes] = await Promise.all([fetch('/api/items'), fetch('/api/summary')]);
      if (!itemsRes.ok || !summaryRes.ok) throw new Error('fetch failed');
      items = await itemsRes.json();
      summary = await summaryRes.json();
      await IDB.setLastItems(items);
    }catch(e){
      items = await IDB.getLastItems() || bundledItems;
      const remote = await IDB.getAllRemote();
      const queued = await IDB.getQueued();
      const byItem = {};
      [...(remote || []), ...(queued || [])].forEach(ev => {
        byItem[ev.itemId] = byItem[ev.itemId] || [];
        byItem[ev.itemId].push(ev);
      });
      summary = Object.keys(byItem).map(itemId => {
        const evs = byItem[itemId].sort((a,b)=> (a.timestamp||'').localeCompare(b.timestamp||''));
        let qty = 0;
        let lastCountIndex = -1;
        for (let i=0;i<evs.length;i++) if (evs[i].type === 'COUNT') lastCountIndex = i;
        if (lastCountIndex >= 0){
          qty = evs[lastCountIndex].qty || 0;
          for (let j=lastCountIndex+1;j<evs.length;j++) if (evs[j].type==='DELTA') qty += (evs[j].qty || 0);
        } else {
          evs.forEach(e=>{ if (e.type==='DELTA') qty += (e.qty || 0); });
        }
        return { itemId, qty };
      });
    }
    const map = {};
    (summary || []).forEach(s=>map[s.itemId]=s.qty);
    const data = items.map(it=>({
      id: it.id,
      label: it.label,
      category: it.category,
      qty: map[it.id]||0,
      reorder: (typeof it.reorderLevel!=='undefined' && it.reorderLevel!==null)?it.reorderLevel: null
    }));
    const grouped = groupByCategory(data);
    lastGroups = grouped;
    renderCharts(grouped);
  }

  function renderCharts(groups){
    chartsEl.innerHTML = '';
    groups.forEach(group => {
      const details = document.createElement('details');
      details.className = 'categoryChart';
      details.open = true;
      details.innerHTML = `<summary>${group.category.toUpperCase()} (${group.items.length})</summary><div class="chartWrap"><canvas></canvas><div class="tooltip"></div></div>`;
      chartsEl.appendChild(details);
      drawBars(details.querySelector('canvas'), details.querySelector('.tooltip'), group.items);
    });
  }

  function drawBars(canvas, tooltip, data){
    const dark = document.body.getAttribute('data-theme') === 'dark';
    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * DPR);
    canvas.height = Math.floor(rect.height * DPR);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!data || data.length===0) return;
    const padTop = 20*DPR;
    const padBottom = 64*DPR;
    const areaW = canvas.width - padTop*2;
    const areaH = canvas.height - padTop - padBottom;
    const areaX = padTop;
    const areaY = padTop;
    const maxV = Math.max(...data.map(d=>Math.max(d.qty, d.reorder || 0)), 1);
    const barW = Math.max(12*DPR, Math.floor(areaW / data.length * 0.7));
    const bars = [];
    data.forEach((d,i)=>{
      const x = areaX + i*(areaW/data.length) + (areaW/data.length - barW)/2;
      const barH = Math.floor((d.qty / maxV) * areaH);
      const y = areaY + (areaH - barH);
      ctx.fillStyle = '#1976d2';
      ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(barW), Math.floor(barH));
      ctx.fillStyle = dark ? '#eee' : '#222';
      ctx.font = `${11*DPR}px sans-serif`;

      // Label current stock quantity above each bar.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(d.qty), x + barW / 2, Math.max(areaY + 12 * DPR, y - 4 * DPR));

      const labelX = x + barW/2;
      const labelY = canvas.height - padBottom/2;
      ctx.save(); ctx.translate(labelX, labelY); ctx.rotate(-Math.PI*2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(d.label, 0, 0); ctx.restore();
      if (d.reorder !== null && !Number.isNaN(d.reorder)){
        const ry = areaY + (1 - (d.reorder / maxV)) * areaH;
        ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2*DPR; ctx.beginPath(); ctx.moveTo(x, ry); ctx.lineTo(x+barW, ry); ctx.stroke();
        // Label reorder threshold near the reorder marker line.
        ctx.fillStyle = '#c62828';
        ctx.font = `${10*DPR}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(`Reorder ${d.reorder}`, x + barW / 2, Math.min(areaY + areaH - 12 * DPR, ry + 2 * DPR));
        ctx.fillStyle = dark ? '#eee' : '#222';
        ctx.font = `${11*DPR}px sans-serif`;
      }
      bars.push({x, y, w: barW, h: barH, item: d});
    });

    canvas.onmousemove = (ev)=>{
      const r = canvas.getBoundingClientRect();
      const px = (ev.clientX - r.left) * DPR;
      const py = (ev.clientY - r.top) * DPR;
      const hit = bars.find(b => px >= b.x && px <= (b.x + b.w) && py >= b.y && py <= (b.y + b.h));
      if (!hit){ tooltip.style.display='none'; return; }
      tooltip.style.display = 'block';
      tooltip.textContent = `${hit.item.label}: ${hit.item.qty}`;
      tooltip.style.left = `${(hit.x / DPR)}px`;
      tooltip.style.top = `8px`;
    };
    canvas.onmouseleave = ()=>{ tooltip.style.display='none'; };
  }

  window.addEventListener('resize', ()=>{ if (lastGroups.length) renderCharts(lastGroups); });
  window.addEventListener('DOMContentLoaded', ()=>{
    const saved = localStorage.getItem('invapp.theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    if (themeToggle) themeToggle.addEventListener('click', ()=>{ const cur = document.body.getAttribute('data-theme'); applyTheme(cur === 'dark' ? 'light' : 'dark'); });
    load();
  });
})();
