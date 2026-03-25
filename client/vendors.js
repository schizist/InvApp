(function(){
  function el(id){ return document.getElementById(id); }
  const themeToggle = el('themeToggle');
  const listEl = el('vendorList');

  function applyTheme(t){
    const next = t === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', next);
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

  async function fetchVendors(){
    const res = await fetch('/api/vendors');
    if (!res.ok) throw new Error('vendors fetch failed ' + res.status);
    return res.json();
  }

  async function render(){
    listEl.innerHTML = '';
    let vendors = [];
    try{
      vendors = await fetchVendors();
    }catch(err){
      listEl.innerHTML = `<div class="empty">Failed to load vendors: ${escapeHtml(err.message || String(err))}</div>`;
      return;
    }
    if (!vendors.length){
      listEl.innerHTML = '<div class="empty">No vendors yet.</div>';
      return;
    }

    vendors.forEach(v => {
      const card = document.createElement('article');
      card.className = 'vendorCard';
      card.innerHTML = `
        <div class="row">
          <h3>${escapeHtml(v.company)}</h3>
          <div class="actions">
            <button class="btn btnNeutral editBtn">Edit</button>
            <button class="btn btnNeutral cancelBtn" style="display:none">Cancel</button>
            <button class="btn btnPrimary saveBtn" style="display:none">Save</button>
            <button class="btn btnDanger deleteBtn">Delete</button>
          </div>
        </div>
        <div class="viewMode">
          <div class="muted">Contact: ${escapeHtml(v.contactName || '-')}</div>
          <div class="muted">Email: ${escapeHtml(v.contactEmail || '-')}</div>
          <div class="muted">On-Time Score: ${v.onTimeScore == null ? '-' : `${escapeHtml(v.onTimeScore)}%`}</div>
        </div>
        <div class="editMode" style="display:none">
          <div class="fields" style="margin-top:8px">
            <div class="field">
              <label>Company</label>
              <input class="companyInput" value="${escapeHtml(v.company || '')}" />
            </div>
            <div class="field">
              <label>Contact</label>
              <input class="contactInput" value="${escapeHtml(v.contactName || '')}" />
            </div>
            <div class="field">
              <label>Email</label>
              <input class="emailInput" value="${escapeHtml(v.contactEmail || '')}" />
            </div>
            <div class="field">
              <label>On-Time Score (%)</label>
              <input class="scoreInput" type="number" step="0.01" value="${escapeHtml(v.onTimeScore ?? '')}" />
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
      const companyInput = card.querySelector('.companyInput');
      const contactInput = card.querySelector('.contactInput');
      const emailInput = card.querySelector('.emailInput');
      const scoreInput = card.querySelector('.scoreInput');

      function setEditing(isEditing){
        viewMode.style.display = isEditing ? 'none' : '';
        editMode.style.display = isEditing ? '' : 'none';
        editBtn.style.display = isEditing ? 'none' : '';
        cancelBtn.style.display = isEditing ? '' : 'none';
        saveBtn.style.display = isEditing ? '' : 'none';
        deleteBtn.style.display = isEditing ? 'none' : '';
      }

      editBtn.addEventListener('click', () => setEditing(true));
      cancelBtn.addEventListener('click', () => {
        companyInput.value = v.company || '';
        contactInput.value = v.contactName || '';
        emailInput.value = v.contactEmail || '';
        scoreInput.value = v.onTimeScore == null ? '' : String(v.onTimeScore);
        setEditing(false);
      });

      saveBtn.addEventListener('click', async () => {
        const company = (companyInput.value || '').trim();
        if (!company){
          alert('Company is required.');
          return;
        }
        const contactName = (contactInput.value || '').trim();
        const contactEmail = (emailInput.value || '').trim();
        const onTimeScoreRaw = (scoreInput.value || '').trim();
        const res = await fetch('/api/vendors/' + encodeURIComponent(v.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company,
            contactName: contactName || null,
            contactEmail: contactEmail || null,
            onTimeScore: onTimeScoreRaw === '' ? null : Number(onTimeScoreRaw)
          })
        });
        if (!res.ok){
          const msg = await res.text();
          alert('Failed to update vendor: ' + msg);
          return;
        }
        await render();
      });

      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete vendor "${v.company}"?`)) return;
        const res = await fetch('/api/vendors/' + encodeURIComponent(v.id), { method: 'DELETE' });
        if (!res.ok){
          const msg = await res.text();
          alert('Failed to delete vendor: ' + msg);
          return;
        }
        await render();
      });

      listEl.appendChild(card);
    });
  }

  async function addVendor(){
    const company = (el('newCompany').value || '').trim();
    const contactName = (el('newContactName').value || '').trim();
    const contactEmail = (el('newContactEmail').value || '').trim();
    const onTimeScore = (el('newOnTimeScore').value || '').trim();
    if (!company){
      alert('Company is required.');
      return;
    }
    const res = await fetch('/api/vendors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company,
        contactName: contactName || null,
        contactEmail: contactEmail || null,
        onTimeScore: onTimeScore === '' ? null : Number(onTimeScore)
      })
    });
    if (!res.ok){
      const msg = await res.text();
      alert('Failed to add vendor: ' + msg);
      return;
    }
    el('newCompany').value = '';
    el('newContactName').value = '';
    el('newContactEmail').value = '';
    el('newOnTimeScore').value = '';
    await render();
  }

  window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('invapp.theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    if (themeToggle) themeToggle.addEventListener('click', () => {
      const cur = document.body.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
    const addBtn = el('addVendorBtn');
    if (addBtn) addBtn.addEventListener('click', () => { addVendor().catch(err => alert(err.message || err)); });
    render();
  });
})();
