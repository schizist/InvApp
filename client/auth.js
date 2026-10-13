(function(){
  function escapeHtml(text){
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isLoginPage(){
    return location.pathname.replace(/^\//, '') === 'login.html';
  }

  async function fetchMe(){
    const res = await fetch('/api/auth/me');
    if (res.status === 401) return null;
    if (!res.ok) throw new Error('auth check failed ' + res.status);
    return res.json();
  }

  function renderUserWidget(user){
    const actions = document.querySelector('.app-nav__actions');
    if (!actions) return;
    const wrap = document.createElement('div');
    wrap.className = 'authWidget';
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-right:8px';
    wrap.innerHTML = `
      <span style="font-size:.78rem;color:var(--nav-link)">${escapeHtml(user.fullName)} (${escapeHtml(user.alias)})${user.isAdmin ? ' &middot; Admin' : ''}</span>
      <button id="authLogoutBtn" class="btn-nav" type="button">Sign out</button>
    `;
    actions.insertBefore(wrap, actions.firstChild);
    const logoutBtn = wrap.querySelector('#authLogoutBtn');
    logoutBtn.addEventListener('click', async () => {
      try{ await fetch('/api/auth/logout', { method: 'POST' }); }catch(e){}
      location.href = '/login.html';
    });
  }

  function applyAdminVisibility(isAdmin){
    // The [data-admin-only] CSS rule hides by attribute presence, so admins
    // need the attribute removed outright — clearing inline style isn't
    // enough since the stylesheet rule would still match.
    document.querySelectorAll('[data-admin-only]').forEach(el => {
      if (isAdmin) el.removeAttribute('data-admin-only');
      else el.style.display = 'none';
    });
  }

  window.InvAppAuth = window.InvAppAuth || {};
  window.InvAppAuth.user = null;
  window.InvAppAuth.ready = (async function(){
    if (isLoginPage()) return null;
    let user = null;
    try{
      user = await fetchMe();
    }catch(err){
      console.warn('Auth check failed', err);
    }
    if (!user){
      const redirect = encodeURIComponent(location.pathname + location.search);
      location.href = '/login.html?redirect=' + redirect;
      return null;
    }
    window.InvAppAuth.user = user;
    renderUserWidget(user);
    applyAdminVisibility(user.isAdmin);
    document.dispatchEvent(new CustomEvent('invapp:auth-ready', { detail: user }));
    return user;
  })();
})();
