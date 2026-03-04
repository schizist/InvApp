(function(){
  const canvas = document.getElementById('barsCanvas');
  const tooltip = document.getElementById('tooltip');
  const themeToggle = document.getElementById('themeToggle');
  const DPR = window.devicePixelRatio || 1;
  let lastData = [];
  function resize(){ const wrap = document.getElementById('chartWrap'); const rect = wrap.getBoundingClientRect(); canvas.width = Math.floor(rect.width*DPR); canvas.height = Math.floor(rect.height*DPR); canvas.style.width = rect.width+'px'; canvas.style.height = rect.height+'px'; }
  window.addEventListener('resize', resize);

  function applyTheme(t){
    const next = t === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', next);
    localStorage.setItem('invapp.theme', next);
    if (themeToggle) themeToggle.textContent = next === 'dark' ? 'Light' : 'Dark';
    if (lastData.length) drawBars(lastData);
  }

  async function load(){
    resize();
    const [items, summary] = await Promise.all([fetch('/api/items').then(r=>r.json()), fetch('/api/summary').then(r=>r.json())]);
    const map = {};
    summary.forEach(s=>map[s.itemId]=s.qty);
    // prepare data: label, qty, reorder
    const data = items.map(it=>({ id: it.id, label: it.label, qty: map[it.id]||0, reorder: (typeof it.reorderLevel!=='undefined' && it.reorderLevel!==null)?it.reorderLevel: null }));
    lastData = data;
    drawBars(data);
  }

  function drawBars(data){
    const dark = document.body.getAttribute('data-theme') === 'dark';
    const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!data || data.length===0) return;
    const padTop = 20*DPR; const padBottom = 60*DPR; const w = canvas.width; const h = canvas.height; const areaW = w - padTop*2; const areaH = h - padTop - padBottom; const areaX = padTop; const areaY = padTop;
    const maxV = Math.max(...data.map(d=>d.qty), 1);
    const barW = Math.max(12*DPR, Math.floor(areaW / data.length * 0.7));
    data.forEach((d,i)=>{
      const x = areaX + i*(areaW/data.length) + (areaW/data.length - barW)/2;
      const barH = Math.floor((d.qty / maxV) * areaH);
      const y = areaY + (areaH - barH);
      ctx.fillStyle = '#1976d2'; ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(barW), Math.floor(barH));
      // label (rotated 90deg CCW)
      ctx.fillStyle = dark ? '#eee' : '#222'; ctx.font = `${11*DPR}px sans-serif`;
      const labelX = x + barW/2; const labelY = h - padBottom/2;
      ctx.save(); ctx.translate(labelX, labelY); ctx.rotate(-Math.PI/2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(d.label, 0, 0); ctx.restore();
      // reorder marker (small red horizontal line across bar area)
      if (d.reorder !== null && !Number.isNaN(d.reorder)){
        const ry = areaY + (1 - (d.reorder / maxV)) * areaH;
        ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2*DPR; ctx.beginPath(); ctx.moveTo(x, ry); ctx.lineTo(x+barW, ry); ctx.stroke();
      }
    });
  }

  window.addEventListener('DOMContentLoaded', ()=>{
    const saved = localStorage.getItem('invapp.theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    if (themeToggle) themeToggle.addEventListener('click', ()=>{ const cur = document.body.getAttribute('data-theme'); applyTheme(cur === 'dark' ? 'light' : 'dark'); });
    load();
  });
})();
