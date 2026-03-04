(function(){
  const canvas = document.getElementById('barsCanvas');
  const tooltip = document.getElementById('tooltip');
  const DPR = window.devicePixelRatio || 1;
  function resize(){ const wrap = document.getElementById('chartWrap'); const rect = wrap.getBoundingClientRect(); canvas.width = Math.floor(rect.width*DPR); canvas.height = Math.floor(rect.height*DPR); canvas.style.width = rect.width+'px'; canvas.style.height = rect.height+'px'; }
  window.addEventListener('resize', resize);

  async function load(){
    resize();
    const [items, summary] = await Promise.all([fetch('/api/items').then(r=>r.json()), fetch('/api/summary').then(r=>r.json())]);
    const map = {};
    summary.forEach(s=>map[s.itemId]=s.qty);
    // prepare data: label, qty, reorder
    const data = items.map(it=>({ id: it.id, label: it.label, qty: map[it.id]||0, reorder: (typeof it.reorderLevel!=='undefined' && it.reorderLevel!==null)?it.reorderLevel: null }));
    drawBars(data);
  }

  function drawBars(data){
    const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!data || data.length===0) return;
    const pad = 40*DPR; const w = canvas.width; const h = canvas.height; const areaW = w - pad*2; const areaH = h - pad*2;
    const maxV = Math.max(...data.map(d=>d.qty), 1);
    const barW = Math.max(12*DPR, Math.floor(areaW / data.length * 0.7));
    data.forEach((d,i)=>{
      const x = pad + i*(areaW/data.length) + (areaW/data.length - barW)/2;
      const barH = Math.floor((d.qty / maxV) * areaH);
      const y = pad + (areaH - barH);
      ctx.fillStyle = '#1976d2'; ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(barW), Math.floor(barH));
      // label
      ctx.fillStyle = '#222'; ctx.font = `${11*DPR}px sans-serif`; ctx.textAlign='center'; ctx.fillText(d.label, x + barW/2, h - pad/2);
      // reorder marker (small red horizontal line across bar area)
      if (d.reorder !== null && !Number.isNaN(d.reorder)){
        const ry = pad + (1 - (d.reorder / maxV)) * areaH;
        ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2*DPR; ctx.beginPath(); ctx.moveTo(x, ry); ctx.lineTo(x+barW, ry); ctx.stroke();
      }
    });
  }

  window.addEventListener('DOMContentLoaded', load);
})();
