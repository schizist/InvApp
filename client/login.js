(function(){
  function el(id){ return document.getElementById(id); }
  function qs(){ return Object.fromEntries(new URLSearchParams(location.search)); }

  async function redirectIfAlreadySignedIn(){
    try{
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        location.href = qs().redirect || '/';
      }
    }catch(e){}
  }

  async function doLogin(){
    const email = (el('email').value || '').trim();
    const errorEl = el('error');
    errorEl.textContent = '';
    if (!email){
      errorEl.textContent = 'Email is required.';
      return;
    }
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    if (!res.ok){
      const body = await res.json().catch(() => ({}));
      errorEl.textContent = body.error || 'Sign-in failed.';
      return;
    }
    const redirect = qs().redirect || '/';
    location.href = redirect;
  }

  window.addEventListener('DOMContentLoaded', () => {
    redirectIfAlreadySignedIn();
    el('loginBtn').addEventListener('click', () => {
      doLogin().catch(err => { el('error').textContent = err.message || String(err); });
    });
    el('email').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin().catch(err => { el('error').textContent = err.message || String(err); });
    });
    el('email').focus();
  });
})();
