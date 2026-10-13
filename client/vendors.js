(function(){
  function el(id){ return document.getElementById(id); }
  const themeToggle = el('themeToggle');
  const listEl = el('vendorList');

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

  function normalizeEmails(raw){
    const seen = new Set();
    const out = [];
    String(raw || '').split(/[,;\n]+/).forEach(part => {
      const email = part.trim();
      if (!email || seen.has(email.toLowerCase())) return;
      seen.add(email.toLowerCase());
      out.push(email);
    });
    return out.join(', ');
  }

  function legacyCopy(text){
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.left = '-1000px';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let ok = false;
    try{ ok = document.execCommand('copy'); }catch(err){ ok = false; }
    document.body.removeChild(textarea);
    return ok;
  }

  async function copyEmails(emails, btn){
    if (!emails) return;
    let ok = false;
    try{
      if (navigator.clipboard && navigator.clipboard.writeText){
        await navigator.clipboard.writeText(emails);
        ok = true;
      } else {
        ok = legacyCopy(emails);
      }
    }catch(err){
      ok = legacyCopy(emails);
    }
    if (!ok){
      alert('Failed to copy emails automatically. Copy manually:\n\n' + emails);
      return;
    }
    if (btn){
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
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
          <div class="muted" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span>Email: ${escapeHtml(v.contactEmail || '-')}</span>
            ${v.contactEmail ? '<button class="btn btnNeutral copyEmailsBtn" style="padding:2px 8px;font-size:.78rem">Copy emails</button>' : ''}
          </div>
          <div class="muted">Phone: ${escapeHtml(v.contactPhone || '-')}</div>
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
              <label>Email(s)</label>
              <input class="emailInput" placeholder="comma-separated if multiple" value="${escapeHtml(v.contactEmail || '')}" />
            </div>
            <div class="field">
              <label>Phone</label>
              <input class="phoneInput" value="${escapeHtml(v.contactPhone || '')}" />
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
      const copyEmailsBtn = card.querySelector('.copyEmailsBtn');
      const viewMode = card.querySelector('.viewMode');
      const editMode = card.querySelector('.editMode');
      const companyInput = card.querySelector('.companyInput');
      const contactInput = card.querySelector('.contactInput');
      const emailInput = card.querySelector('.emailInput');
      const phoneInput = card.querySelector('.phoneInput');
      const scoreInput = card.querySelector('.scoreInput');

      function setEditing(isEditing){
        viewMode.style.display = isEditing ? 'none' : '';
        editMode.style.display = isEditing ? '' : 'none';
        editBtn.style.display = isEditing ? 'none' : '';
        cancelBtn.style.display = isEditing ? '' : 'none';
        saveBtn.style.display = isEditing ? '' : 'none';
        deleteBtn.style.display = isEditing ? 'none' : '';
      }

      if (copyEmailsBtn) copyEmailsBtn.addEventListener('click', () => copyEmails(v.contactEmail, copyEmailsBtn));

      editBtn.addEventListener('click', () => setEditing(true));
      cancelBtn.addEventListener('click', () => {
        companyInput.value = v.company || '';
        contactInput.value = v.contactName || '';
        emailInput.value = v.contactEmail || '';
        phoneInput.value = v.contactPhone || '';
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
        const contactEmail = normalizeEmails(emailInput.value);
        const contactPhone = (phoneInput.value || '').trim();
        const onTimeScoreRaw = (scoreInput.value || '').trim();
        const res = await fetch('/api/vendors/' + encodeURIComponent(v.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company,
            contactName: contactName || null,
            contactEmail: contactEmail || null,
            contactPhone: contactPhone || null,
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
    const contactEmail = normalizeEmails(el('newContactEmail').value);
    const contactPhone = (el('newContactPhone').value || '').trim();
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
        contactPhone: contactPhone || null,
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
    el('newContactPhone').value = '';
    el('newOnTimeScore').value = '';
    await render();
  }

  window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('invapp.theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    if (themeToggle) themeToggle.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
    const addBtn = el('addVendorBtn');
    if (addBtn) addBtn.addEventListener('click', () => { addVendor().catch(err => alert(err.message || err)); });
    render();
  });
})();
