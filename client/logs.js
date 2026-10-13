(function(){
  function el(id){ return document.getElementById(id); }
  const themeToggle = el('themeToggle');

  function applyTheme(t){
    const next = t === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('invapp.theme', next);
    if (themeToggle) themeToggle.textContent = next === 'dark' ? 'Light' : 'Dark';
  }

  function escapeHtml(text){
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatWhen(iso){
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return escapeHtml(iso);
    return d.toLocaleString();
  }

  async function loadLogs(){
    const statusEl = el('logStatus');
    const tableEl = el('logTable');
    const bodyEl = el('logBody');
    statusEl.style.display = '';
    statusEl.textContent = 'Loading...';
    tableEl.style.display = 'none';
    try{
      const res = await fetch('/api/logs');
      if (res.status === 403){
        statusEl.textContent = 'Admins only.';
        return;
      }
      if (!res.ok) throw new Error('logs fetch failed ' + res.status);
      const rows = await res.json();
      if (!rows.length){
        statusEl.textContent = 'No activity recorded yet.';
        return;
      }
      bodyEl.innerHTML = rows.map(r => `
        <tr>
          <td>${formatWhen(r.timestamp)}</td>
          <td>${escapeHtml(r.userAlias || r.userEmail || 'Unknown')}</td>
          <td><span class="actionTag">${escapeHtml(r.action)}</span> ${escapeHtml(r.entityType)}</td>
          <td>${escapeHtml(r.summary)}</td>
        </tr>
      `).join('');
      statusEl.style.display = 'none';
      tableEl.style.display = '';
    }catch(err){
      statusEl.textContent = 'Failed to load logs: ' + (err.message || err);
    }
  }

  window.addEventListener('DOMContentLoaded', async () => {
    const saved = localStorage.getItem('invapp.theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    if (themeToggle) themeToggle.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
    const user = await (window.InvAppAuth && window.InvAppAuth.ready);
    if (!user) return;
    if (!user.isAdmin){
      el('logStatus').style.display = '';
      el('logStatus').textContent = 'Admins only.';
      return;
    }
    loadLogs();
  });
})();
