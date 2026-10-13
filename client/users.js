(function(){
  function el(id){ return document.getElementById(id); }
  const themeToggle = el('themeToggle');
  const listEl = el('userList');

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

  async function fetchUsers(){
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error('users fetch failed ' + res.status);
    return res.json();
  }

  async function render(){
    listEl.innerHTML = '';
    const authUser = window.InvAppAuth ? await window.InvAppAuth.ready : null;
    const isAdmin = !!(authUser && authUser.isAdmin);
    let users = [];
    try{
      users = await fetchUsers();
    }catch(err){
      listEl.innerHTML = `<div class="empty">Failed to load users: ${escapeHtml(err.message || String(err))}</div>`;
      return;
    }
    if (!users.length){
      listEl.innerHTML = '<div class="empty">No users yet.</div>';
      return;
    }

    users.forEach(u => {
      const card = document.createElement('article');
      card.className = 'vendorCard';
      card.innerHTML = `
        <div class="row">
          <h3>${escapeHtml(u.fullName)}</h3>
          <div class="actions">
            ${isAdmin ? `
            <button class="btn btnNeutral editBtn">Edit</button>
            <button class="btn btnNeutral cancelBtn" style="display:none">Cancel</button>
            <button class="btn btnPrimary saveBtn" style="display:none">Save</button>
            <button class="btn btnDanger deleteBtn">Delete</button>
            ` : ''}
          </div>
        </div>
        <div class="viewMode">
          <div class="muted">Alias: ${escapeHtml(u.alias)}</div>
          <div class="muted">Email: ${escapeHtml(u.email || '-')}</div>
          <div class="muted">${u.isAdmin ? 'Admin' : 'Standard user'}</div>
        </div>
        <div class="editMode" style="display:none">
          <div class="fields" style="margin-top:8px">
            <div class="field">
              <label>Full Name</label>
              <input class="fullNameInput" value="${escapeHtml(u.fullName || '')}" />
            </div>
            <div class="field">
              <label>Alias (2-3 chars)</label>
              <input class="aliasInput" maxlength="3" style="text-transform:uppercase" value="${escapeHtml(u.alias || '')}" />
            </div>
            <div class="field">
              <label>Email</label>
              <input class="emailInput" type="email" value="${escapeHtml(u.email || '')}" />
            </div>
            <div class="field" style="flex-direction:row;align-items:center;gap:6px">
              <input class="isAdminInput" type="checkbox" style="width:auto" ${u.isAdmin ? 'checked' : ''} />
              <label style="margin:0">Admin</label>
            </div>
          </div>
        </div>
      `;

      const editBtn = card.querySelector('.editBtn');
      const cancelBtn = card.querySelector('.cancelBtn');
      const saveBtn = card.querySelector('.saveBtn');
      const deleteBtn = card.querySelector('.deleteBtn');
      const viewMode = card.querySelector('.viewMode');
      const editMode = card.querySelector('.editMode');
      const fullNameInput = card.querySelector('.fullNameInput');
      const aliasInput = card.querySelector('.aliasInput');
      const emailInput = card.querySelector('.emailInput');
      const isAdminInput = card.querySelector('.isAdminInput');

      function setEditing(isEditing){
        viewMode.style.display = isEditing ? 'none' : '';
        editMode.style.display = isEditing ? '' : 'none';
        editBtn.style.display = isEditing ? 'none' : '';
        cancelBtn.style.display = isEditing ? '' : 'none';
        saveBtn.style.display = isEditing ? '' : 'none';
        deleteBtn.style.display = isEditing ? 'none' : '';
      }

      if (!isAdmin) { listEl.appendChild(card); return; }

      editBtn.addEventListener('click', () => setEditing(true));
      cancelBtn.addEventListener('click', () => {
        fullNameInput.value = u.fullName || '';
        aliasInput.value = u.alias || '';
        emailInput.value = u.email || '';
        isAdminInput.checked = !!u.isAdmin;
        setEditing(false);
      });

      saveBtn.addEventListener('click', async () => {
        const fullName = (fullNameInput.value || '').trim();
        if (!fullName){
          alert('Full name is required.');
          return;
        }
        const alias = (aliasInput.value || '').trim().toUpperCase();
        if (alias.length < 2 || alias.length > 3){
          alert('Alias must be 2-3 characters.');
          return;
        }
        const email = (emailInput.value || '').trim();
        if (!email){
          alert('Email is required.');
          return;
        }
        const res = await fetch('/api/users/' + encodeURIComponent(u.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fullName, alias, email, isAdmin: !!isAdminInput.checked })
        });
        if (!res.ok){
          const msg = await res.text();
          alert('Failed to update user: ' + msg);
          return;
        }
        await render();
      });

      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete user "${u.fullName}"?`)) return;
        const res = await fetch('/api/users/' + encodeURIComponent(u.id), { method: 'DELETE' });
        if (!res.ok){
          const msg = await res.text();
          alert('Failed to delete user: ' + msg);
          return;
        }
        await render();
      });

      listEl.appendChild(card);
    });
  }

  async function addUser(){
    const email = (el('newEmail').value || '').trim();
    const fullName = (el('newFullName').value || '').trim();
    const alias = (el('newAlias').value || '').trim().toUpperCase();
    const isAdmin = !!(el('newIsAdmin') && el('newIsAdmin').checked);
    if (!email){
      alert('Email is required.');
      return;
    }
    if (!fullName){
      alert('Full name is required.');
      return;
    }
    if (alias.length < 2 || alias.length > 3){
      alert('Alias must be 2-3 characters.');
      return;
    }
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName, alias, isAdmin })
    });
    if (!res.ok){
      const msg = await res.text();
      alert('Failed to add user: ' + msg);
      return;
    }
    el('newEmail').value = '';
    el('newFullName').value = '';
    el('newAlias').value = '';
    if (el('newIsAdmin')) el('newIsAdmin').checked = false;
    await render();
  }

  window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('invapp.theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    if (themeToggle) themeToggle.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
    const addBtn = el('addUserBtn');
    if (addBtn) addBtn.addEventListener('click', () => { addUser().catch(err => alert(err.message || err)); });
    render();
  });
})();
