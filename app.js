/* Card Payments PWA — consolidated & hardened */
(() => {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  // UI version badge (cache-bust handled by sw.js)
  const APP_VERSION = (window.APP_VERSION = 'v1.3.2');

  const STORAGE_KEYS = { cards: 'cpp_cards', pays: 'cpp_payments' };
  const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const save = (key, val) => localStorage.setItem(key, JSON.stringify(val));

  const state = {
    cards: load(STORAGE_KEYS.cards, []),
    payments: load(STORAGE_KEYS.pays, [])
  };

  /** ICS lock: prevent duplicate ICS until payments are cleared */
  const ICS_LOCK_KEY = 'cpp_ics_lock';
  const isIcsLocked = () => localStorage.getItem(ICS_LOCK_KEY) === '1';
  const setIcsLock = (locked) => localStorage.setItem(ICS_LOCK_KEY, locked ? '1' : '0');
  if ((state.payments ?? []).length === 0) setIcsLock(false);

  /** Utilities */
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const fmtUSD = num => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(num);
  const lastDayOfMonth = (y, m) => (new Date(y, m + 1, 0)).getDate();
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function computeNextDueDate(dueDay) {
    const now = new Date(); const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    let targetMonth = m; if (d >= dueDay) targetMonth = m + 1; const targetYear = y + Math.floor(targetMonth / 12); targetMonth %= 12;
    const day = clamp(dueDay, 1, lastDayOfMonth(targetYear, targetMonth));
    return new Date(targetYear, targetMonth, day);
  }

  function toISODateOnly(dt) {
    const y = dt.getFullYear(); const m = String(dt.getMonth() + 1).padStart(2, '0'); const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function parseDateInput(val) { const [y, m, d] = val.split('-').map(Number); return new Date(y, m - 1, d); }

  /** Duplicate guard helpers */
  function sameMonthYear(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
  function isDuplicatePayment(cardId, dueDateObj) {
    const dueISO = toISODateOnly(dueDateObj);
    const exact = state.payments.some(p => p.cardId === cardId && toISODateOnly(new Date(p.dueDate)) === dueISO);
    const sameCycle = state.payments.some(p => p.cardId === cardId && sameMonthYear(new Date(p.dueDate), dueDateObj));
    return { exact, sameCycle };
  }

  /** Toast support */
  function ensureToastSupport() {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      host.setAttribute('aria-atomic', 'true');
      document.body.appendChild(host);
    }
    return host;
  }
  function showToast(message, { type = 'success', duration = 2600 } = {}) {
    const host = ensureToastSupport();
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = message;
    host.appendChild(t);
    void t.offsetWidth; t.classList.add('show');
    setTimeout(() => {
      t.classList.remove('show');
      t.addEventListener('transitionend', () => t.remove(), { once: true });
    }, Math.max(1200, duration));
  }
  window.showToast = showToast;

  /** Update-ready (Reload) toast */
  function showReloadToast({ title='Update ready', message='New version downloaded. Click Reload to apply it now.', actionLabel='Reload', autoFocusAction=true }={}) {
    ensureToastSupport();
    let t = document.getElementById('updateReadyToast'); if (t) return t;
    t = document.createElement('div'); t.id='updateReadyToast'; t.className='toast update'; t.setAttribute('role','alert');
    const row = document.createElement('div'); row.className='toast-row';
    const text = document.createElement('div'); text.style.flex='1 1 auto'; text.innerHTML = `<strong>${title}</strong><div style="font-weight:500;margin-top:2px">${message}</div>`;
    const action = document.createElement('button'); action.type='button'; action.className='toast-action'; action.textContent=actionLabel;
    const close = document.createElement('button'); close.type='button'; close.className='toast-close'; close.setAttribute('aria-label','Dismiss update'); close.textContent='\u00d7';
    row.append(text, action, close); t.appendChild(row);
    const host = document.getElementById('toastHost');
    host.appendChild(t);
    void t.offsetWidth; t.classList.add('show');
    action.addEventListener('click', (e)=>{ e.preventDefault(); location.reload(); });
    close.addEventListener('click', (e)=>{ e.preventDefault(); t.classList.remove('show'); t.addEventListener('transitionend', ()=> t.remove(), { once:true }); });
    if (autoFocusAction) setTimeout(()=> action.focus({ preventScroll:true }), 50);
    return t;
  }

  /** ——— ICS LOCK BADGE (UI) ——— */
  function ensureIcsLockBadge() {
    let badge = document.getElementById('icsLockBadge');
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.id = 'icsLockBadge';
      badge.className = 'cpro-ics-badge unlocked';
      badge.innerHTML = `<span aria-hidden="true">🔓</span><span>Reminder not created</span><span class="dot" aria-hidden="true"></span>`;
      badge.title = 'No reminder lock. When all cards are covered, an .ics will be created and locked until payments are cleared.';
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        if (isIcsLocked()) {
          showToast('Reminder already created — clear all payments to unlock.', { type: 'info', duration: 3200 });
        } else {
          showToast('No reminder lock. Add payments for all cards to auto-create & lock the reminder.', { type: 'info', duration: 3600 });
        }
      });
    }
    const paymentsSec = document.getElementById('payments') ?? document.body;
    const form = paymentsSec.querySelector('#payment-form');
    if (form) {
      // Place the badge immediately **below** the payment form
      form.insertAdjacentElement('afterend', badge);
    } else {
      // Fallbacks
      const table = paymentsSec.querySelector('#paymentsTable');
      if (table) {
        paymentsSec.insertBefore(badge, table);
      } else {
        paymentsSec.insertAdjacentElement('afterbegin', badge);
      }
    }
    return badge;
  }
  function updateIcsLockBadge() {
    const badge = ensureIcsLockBadge();
    const locked = isIcsLocked();
    if (locked) {
      badge.classList.remove('unlocked'); badge.classList.add('locked');
      badge.title = 'A reminder was already created. Clear all payments to unlock and create a new reminder.';
      badge.firstElementChild.textContent = '🔒';
      badge.querySelector('span:nth-child(2)').textContent = 'Reminder created (locked)';
    } else {
      badge.classList.remove('locked'); badge.classList.add('unlocked');
      badge.title = 'No reminder lock. When all cards are covered, an .ics will be created and locked until payments are cleared.';
      badge.firstElementChild.textContent = '🔓';
      badge.querySelector('span:nth-child(2)').textContent = 'Reminder not created';
    }
  }

  /** Layout no-ops preserved for compatibility */
  function applyLayoutTweaks() {/* styles live in index.html */}

  /** Rendering cards (with Edit) */
  function renderCards() {
    const ul = document.querySelector('#cardsUl');
    if (!ul) return;
    ul.innerHTML = '';
    if (state.cards.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No cards yet.';
      ul.appendChild(li);
      return;
    }
    state.cards.forEach(card => {
      const li = document.createElement('li');
      const left = document.createElement('div');
      const right = document.createElement('div');
      const nameEl = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = card.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `Due day: ${card.dueDay}`;
      nameEl.append(strong, meta);
      left.appendChild(nameEl);
      const editBtn = document.createElement('button');
      editBtn.type='button';
      editBtn.className='icon';
      editBtn.textContent='Edit';
      const delBtn = document.createElement('button');
      delBtn.type='button';
      delBtn.className='icon danger';
      delBtn.textContent='Delete';
      editBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const row = document.createElement('div');
        row.className='edit-row';
        const nameIn = document.createElement('input');
        nameIn.type='text'; nameIn.value=card.name; nameIn.maxLength=50;
        const dayIn = document.createElement('input');
        dayIn.type='number'; dayIn.min='1'; dayIn.max='31'; dayIn.value=String(card.dueDay);
        const saveBtn = document.createElement('button');
        saveBtn.type='button'; saveBtn.className='primary'; saveBtn.textContent='Save';
        const cancelBtn = document.createElement('button');
        cancelBtn.type='button'; cancelBtn.className='secondary'; cancelBtn.textContent='Cancel';
        row.append(nameIn, dayIn, saveBtn, cancelBtn);
        left.replaceChildren(row);
        cancelBtn.addEventListener('click', (e2)=>{ e2.preventDefault(); left.replaceChildren(nameEl); });
        saveBtn.addEventListener('click', (e2) => {
          e2.preventDefault();
          const newName = (nameIn.value ?? '').trim();
          const newDay = Number(dayIn.value);
          if (!newName || !(newDay>=1 && newDay<=31)) return alert('Enter a name and a due day 1–31.');
          if (state.cards.some(c => c.id!==card.id && c.name.toLowerCase()===newName.toLowerCase())) return alert('A card with that name already exists.');
          card.name = newName; card.dueDay = newDay; save(STORAGE_KEYS.cards, state.cards);
          reorderTabsAndSetDefault(); renderCards(); renderPaymentCardOptions(); renderPaymentsTable();
        });
      });
      delBtn.addEventListener('click', (e) => {
        e.preventDefault(); if (!confirm(`Delete card "${card.name}"?`)) return;
        state.cards = state.cards.filter(c => c.id !== card.id);
        const before = state.payments.length;
        state.payments = state.payments.filter(p => p.cardId !== card.id);
        save(STORAGE_KEYS.cards, state.cards); save(STORAGE_KEYS.pays, state.payments);
        if (before>0 && state.payments.length===0) { setIcsLock(false); updateIcsLockBadge(); }
        reorderTabsAndSetDefault(); renderCards(); renderPaymentCardOptions(); renderPaymentsTable();
      });
      right.append(editBtn, delBtn);
      li.append(left, right);
      ul.appendChild(li);
    });
  }

  function renderPaymentCardOptions() {
    const sel = document.querySelector('#paymentCard'); if (!sel) return;
    sel.innerHTML = '<option value="" disabled selected>Select a card</option>';
    const cardsSorted = [...state.cards].sort((a,b)=> a.name.localeCompare(b.name, undefined, { sensitivity:'base' }));
    for (const card of cardsSorted) {
      const opt = document.createElement('option'); opt.value = card.id; opt.textContent = card.name; sel.appendChild(opt);
    }
    sel.disabled = !state.cards.length;
  }

  /** Payments table */
  function renderPaymentsTable() {
    const tb = document.querySelector('#paymentsTable tbody'); if (!tb) return; tb.innerHTML='';
    const fromEl = document.querySelector('#filterFrom');
    const toEl = document.querySelector('#filterTo');
    const from = fromEl && fromEl.value ? parseDateInput(fromEl.value) : null;
    const to = toEl && toEl.value ? parseDateInput(toEl.value) : null;
    const cardById = new Map(state.cards.map(c => [c.id, c]));
    const filtered = state.payments
      .filter(p => { const dt=new Date(p.dueDate); if (from && dt<from) return false; if (to){const t2=new Date(to); t2.setHours(23,59,59,999); if (dt>t2) return false;} return true; })
      .sort((a,b)=>{ const da=new Date(a.dueDate), db=new Date(b.dueDate); if(da<db) return -1; if(da>db) return 1; const ca=(cardById.get(a.cardId)?.name??'').toLowerCase(); const cb=(cardById.get(b.cardId)?.name??'').toLowerCase(); if(ca<cb) return -1; if(ca>cb) return 1; return 0; });
    let sum=0;
    for (const p of filtered) {
      const tr = document.createElement('tr');
      const card = cardById.get(p.cardId); const name = card ? card.name : '—';
      const amt = (p.amountCents??0)/100; sum += amt;
      const due = new Date(p.dueDate); const dueStr = due.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
      const td1 = document.createElement('td'); td1.textContent = name;
      const td2 = document.createElement('td'); td2.textContent = fmtUSD(amt); td2.className = 'num';
      const td3 = document.createElement('td'); td3.textContent = dueStr;
      const td4 = document.createElement('td');
      const rm = document.createElement('button'); rm.type='button'; rm.className='icon danger'; rm.textContent='Remove';
      rm.addEventListener('click', (e)=>{ e.preventDefault(); const was=state.payments.length; if(!confirm('Remove this payment entry?')) return; state.payments=state.payments.filter(x=>x.id!==p.id); save(STORAGE_KEYS.pays, state.payments); if(was>0 && state.payments.length===0){ setIcsLock(false); updateIcsLockBadge(); } renderPaymentsTable(); });
      td4.appendChild(rm); tr.append(td1, td2, td3, td4); tb.appendChild(tr);
    }
    const sumCell = document.querySelector('#sumCell'); if (sumCell) sumCell.textContent = fmtUSD(sum);
  }

  /** Tabs wiring */
  function wireTabClicks() {
    $$('.tab-btn').forEach(btn => {
      btn.setAttribute('role', 'tab');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        $$('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tgt = btn.getAttribute('data-target');
        $$('.tab').forEach(sec => sec.classList.remove('active'));
        document.querySelector(tgt)?.classList.add('active');
      });
    });
    $$('.tab').forEach(tab => { tab.setAttribute('role', 'tabpanel'); });
  }

  /** Reorder tabs: Payments (default) → Cards */
  function reorderTabsAndSetDefault() {
    const paymentsBtn = document.querySelector('[data-target="#payments"]');
    const cardsBtn = document.querySelector('[data-target="#cards"]');
    const btnParent = (paymentsBtn && paymentsBtn.parentElement) || (cardsBtn && cardsBtn.parentElement) || null;
    if (btnParent) [paymentsBtn, cardsBtn].filter(Boolean).forEach(btn => btnParent.appendChild(btn));
    const paySec = document.getElementById('payments');
    const cardsSec = document.getElementById('cards');
    const secParent = (paySec && paySec.parentElement) || (cardsSec && cardsSec.parentElement) || null;
    if (secParent) [paySec, cardsSec].filter(Boolean).forEach(sec => secParent.appendChild(sec));
    const allBtns = Array.from(document.querySelectorAll('.tab-btn'));
    const allTabs = Array.from(document.querySelectorAll('.tab'));
    allBtns.forEach(b => b.classList.remove('active'));
    allTabs.forEach(t => t.classList.remove('active'));
    if (paymentsBtn) paymentsBtn.classList.add('active');
    if (paySec) paySec.classList.add('active');
  }

  // Add card
  document.querySelector('#card-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.querySelector('#cardName').value.trim();
    const dueDay = Number(document.querySelector('#dueDay').value);
    if (!name || !(dueDay>=1 && dueDay<=31)) return alert('Please enter a card name and due day (1–31).');
    if (state.cards.some(c => c.name.toLowerCase() === name.toLowerCase())) return alert('A card with that name already exists.');
    state.cards.push({ id: uid(), name, dueDay });
    save(STORAGE_KEYS.cards, state.cards);
    document.querySelector('#card-form').reset();
    reorderTabsAndSetDefault();
    renderCards(); renderPaymentCardOptions();
  });

  // Payment form helpers
  document.querySelector('#paymentCard')?.addEventListener('change', () => {
    const id = document.querySelector('#paymentCard').value;
    const card = state.cards.find(c => c.id === id);
    if (card) document.querySelector('#dueDate').value = toISODateOnly(computeNextDueDate(card.dueDay));
  });

  /** Coverage & batch ICS */
  function getCoverageAndTotals() {
    const cards = state.cards ?? [];
    const payments = state.payments ?? [];
    const covered = new Set(payments.map(p => p.cardId));
    const missing = cards.filter(c => !covered.has(c.id));
    const totalCents = payments.reduce((acc, p) => acc + (p.amountCents ?? 0), 0);
    const earliestDue = payments.length ? payments.reduce((min,p)=>{ const d=new Date(p.dueDate); return (!min || d<min)?d:min; }, null) : null;
    return { allCovered: cards.length>0 && missing.length===0, missing, totalCents, earliestDue };
  }
  function maybeCreateBatchICS() {
    if (isIcsLocked()) {
      showToast('Reminder already created — clear payments to generate a new one.', { type:'info', duration:3600 }); updateIcsLockBadge(); return;
    }
    const { allCovered, missing, totalCents, earliestDue } = getCoverageAndTotals();
    if (!allCovered) {
      if (state.cards.length === 0) { showToast('No cards saved. Add cards first.', { type:'info', duration:2600 }); updateIcsLockBadge(); return; }
      const coveredCount = new Set(state.payments.map(p => p.cardId)).size;
      const names = missing.map(c => c.name).join(', ');
      showToast(`${coveredCount}/${state.cards.length} cards covered. Add payments for: ${names}`, { type:'info', duration:5200 }); updateIcsLockBadge(); return;
    }
    const total = (totalCents/100); const totalStr = fmtUSD(total); const earliest = earliestDue ?? new Date(); const countCards = state.cards.length;
    const title = 'All Card Payments Due'; const description = `Total across ${countCards} cards: ${totalStr}`; const alarmDescription = `Total due: ${totalStr} across ${countCards} cards`;
    showToast('All cards covered—reminder created', { type:'success', duration:2800 });
    downloadICS({ title, description, startLocal: earliest, durationMinutes: 60, alarmDescription });
    setIcsLock(true); updateIcsLockBadge();
    setTimeout(()=>{
      if (!confirm('All cards are covered and the reminder was downloaded.\nDo you want to CLEAR ALL saved payments now?')) return;
      const token = prompt('Type CLEAR to confirm deletion of ALL payments:');
      if (token !== 'CLEAR') { showToast('Clear canceled — payments left intact.', { type:'info', duration:2600 }); return; }
      state.payments = []; save(STORAGE_KEYS.pays, state.payments); setIcsLock(false); updateIcsLockBadge(); renderPaymentsTable(); showToast('All payments cleared.', { type:'success', duration:2400 });
    }, 350);
  }

  // Payment form submit
  document.querySelector('#payment-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const cardId = document.querySelector('#paymentCard').value;
    const amountStr = document.querySelector('#amountDue').value;
    const dueStr = document.querySelector('#dueDate').value;
    if (!cardId) return alert('Please select a card.');
    const amount = Number.parseFloat(amountStr); if (!Number.isFinite(amount) || amount < 0) return alert('Please enter a valid amount.');
    if (!dueStr) return alert('Please choose a due date.');
    const amountCents = Math.round(amount * 100); const dueObj = parseDateInput(dueStr);
    const dup = isDuplicatePayment(cardId, dueObj); if (dup.exact) return alert('A payment for this card on this due date already exists.'); if (dup.sameCycle) return alert('A payment for this card is already recorded for this month. Remove it first to replace.');
    state.payments.push({ id: uid(), cardId, amountCents, dueDate: dueObj }); save(STORAGE_KEYS.pays, state.payments);
    const form = document.querySelector('#payment-form'); if (form) form.reset(); const sel = document.querySelector('#paymentCard'); if (sel){ sel.selectedIndex=0; sel.dispatchEvent(new Event('change')); sel.focus(); }
    const dueIn = document.querySelector('#dueDate'); if (dueIn) dueIn.value=''; const amtIn = document.querySelector('#amountDue'); if (amtIn) amtIn.value='';
    showToast('Payment saved', { type:'success', duration:2000 }); renderPaymentsTable(); document.querySelector('[data-target="#payments"]')?.click(); maybeCreateBatchICS();
  });

  // Filters
  function validateListDateRange() {
    const fromIn = document.querySelector('#filterFrom'); const toIn = document.querySelector('#filterTo'); if (!fromIn || !toIn) return;
    const fromVal = fromIn.value; const toVal = toIn.value; if (fromVal && toVal) { const from = parseDateInput(fromVal); const to = parseDateInput(toVal); if (to < from) { showToast('“Due to” must be the same day or later than “Due from”. Adjusted for you.', { type: 'info', duration: 2600 }); toIn.value = fromVal; toIn.focus(); } }
  }
  document.querySelector('#filterFrom')?.addEventListener('change', ()=>{ validateListDateRange(); renderPaymentsTable(); });
  document.querySelector('#filterTo')?.addEventListener('change', ()=>{ validateListDateRange(); renderPaymentsTable(); });
  document.querySelector('#clearFilters')?.addEventListener('click', (e)=>{ e.preventDefault(); const f=$('#filterFrom'); const t=$('#filterTo'); if (f) f.value=''; if (t) t.value=''; renderPaymentsTable(); });

  // Clear payments
  const clearPaymentsBtn = document.getElementById('clearPayments');
  if (clearPaymentsBtn) {
    clearPaymentsBtn.setAttribute('type','button');
    clearPaymentsBtn.addEventListener('click', (e)=>{
      e.preventDefault(); if (!state.payments.length) return alert('No payments to clear.');
      if (confirm('Clear ALL payments data? This cannot be undone.')) {
        const token = prompt('Type CLEAR to confirm deletion of ALL payments:'); if (token !== 'CLEAR') return alert('Canceled. Type CLEAR exactly to proceed.');
        state.payments = []; save(STORAGE_KEYS.pays, state.payments); setIcsLock(false); updateIcsLockBadge(); renderPaymentsTable();
      }
    });
  }

  // —— PAYMENTS BACKUP ——
  function exportPaymentsBackup() {
    try {
      const pays = state.payments ?? [];
      if (pays.length === 0) { alert('No payments saved to back up.'); return; }
      const cardById = new Map(state.cards.map(c => [c.id, c]));
      const payments = pays.map(p => ({
        id: p.id,
        cardId: p.cardId,
        cardName: cardById.get(p.cardId)?.name ?? null,
        amountCents: p.amountCents ?? 0,
        amount: Number(((p.amountCents ?? 0) / 100).toFixed(2)),
        dueDate: toISODateOnly(new Date(p.dueDate))
      }));
      const payload = {
        type: 'cardpaypro.payments',
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        count: payments.length,
        currency: 'USD',
        payments
      };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const dt = new Date();
      const yyyy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      const a = document.createElement('a');
      a.download = `payments_backup_${yyyy}${mm}${dd}.json`;
      a.href = URL.createObjectURL(blob);
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      showToast('Payments backup downloaded', { type:'success', duration:2400 });
    } catch (e) {
      console.error(e);
      alert('Could not create payments backup. See console for details.');
    }
  }
  function ensureBackupPaymentsButton() {
    let btn = document.getElementById('backupPayments');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'backupPayments';
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = 'Backup payments (.json)';
      btn.title = 'Download a JSON backup of your saved payments';
    }
    const anchor = document.getElementById('clearPayments');
    if (anchor?.parentElement) {
      anchor.parentElement.insertBefore(btn, anchor);
    } else {
      (document.getElementById('list') ?? document.body)
        .insertAdjacentElement('afterbegin', btn);
    }
    return btn;
  }
  const backupPaymentsBtn = ensureBackupPaymentsButton();
  backupPaymentsBtn?.addEventListener('click', (e) => { e.preventDefault(); exportPaymentsBackup(); });

  // —— PAYMENTS IMPORT ——
  function normalizePaymentImport(raw) {
    const hasCents = Number.isFinite(raw?.amountCents);
    const hasAmount = Number.isFinite(raw?.amount);
    let amountCents = null;
    if (hasCents) amountCents = Math.round(Number(raw.amountCents));
    else if (hasAmount) amountCents = Math.round(Number(raw.amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents < 0) return null;
    const dueStr = String(raw?.dueDate ?? '').trim();
    if (!dueStr) return null;
    let dueDate; try { dueDate = parseDateInput(dueStr); } catch { return null; }
    if (!(dueDate instanceof Date) || isNaN(+dueDate)) return null;
    const cardId = typeof raw?.cardId === 'string' && raw.cardId.trim() ? raw.cardId.trim() : null;
    const cardName = typeof raw?.cardName === 'string' && raw.cardName.trim() ? raw.cardName.trim() : null;
    if (!cardId && !cardName) return null;
    return { cardId, cardName, amountCents, dueDate };
  }
  function importPaymentsPayload(payload) {
    if (!payload || payload.type !== 'cardpaypro.payments' || !Array.isArray(payload.payments)) {
      throw new Error('Invalid backup format');
    }
    const mode = (prompt(
      'Type MERGE to merge with existing payments (recommended), or type REPLACE to replace ALL existing payments.',
      'MERGE'
    ) ?? '').toUpperCase().trim();
    if (mode !== 'MERGE' && mode !== 'REPLACE') throw new Error('Import cancelled');
    if (mode === 'REPLACE') {
      if (!confirm('Replace ALL existing payments with the import? This cannot be undone.')) {
        throw new Error('Import cancelled');
      }
      state.payments = [];
      save(STORAGE_KEYS.pays, state.payments);
      setIcsLock(false);
    }
    const byId = new Map(state.cards.map(c => [c.id, c]));
    const byName = new Map(state.cards.map(c => [c.name.toLowerCase(), c]));
    let total = 0, added = 0, skippedNoCard = 0, skippedDuplicate = 0, skippedInvalid = 0;
    for (const raw of payload.payments) {
      total++;
      const p = normalizePaymentImport(raw);
      if (!p) { skippedInvalid++; continue; }
      const card = (p.cardId && byId.get(p.cardId)) || (p.cardName && byName.get(p.cardName.toLowerCase())) || null;
      if (!card) { skippedNoCard++; continue; }
      const dup = isDuplicatePayment(card.id, p.dueDate);
      if (dup.exact || dup.sameCycle) { skippedDuplicate++; continue; }
      state.payments.push({ id: uid(), cardId: card.id, amountCents: p.amountCents, dueDate: p.dueDate });
      added++;
    }
    save(STORAGE_KEYS.pays, state.payments);
    updateIcsLockBadge();
    renderPaymentsTable();
    return { mode, total, added, skippedNoCard, skippedDuplicate, skippedInvalid };
  }
  function handleImportPaymentsClick() {
    let input = document.getElementById('importPaymentsInput');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      input.id = 'importPaymentsInput';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          const res = importPaymentsPayload(data);
          input.value = '';
          showToast(
            `Payments import: ${res.added} added` +
            (res.skippedDuplicate ? `, ${res.skippedDuplicate} duplicates` : '') +
            (res.skippedNoCard ? `, ${res.skippedNoCard} without matching card` : '') +
            (res.skippedInvalid ? `, ${res.skippedInvalid} invalid` : '') +
            (res.mode === 'REPLACE' ? ' (replaced all)' : ''),
            { type: 'success', duration: 5200 }
          );
        } catch (e) {
          console.error(e);
          alert('Import failed. Please ensure this is a valid CardPay Pro payments backup JSON.');
        }
      });
    }
    input.click();
  }
  function ensureImportPaymentsButton() {
    let btn = document.getElementById('importPayments');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'importPayments';
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = 'Restore/Import payments (.json)';
      btn.title = 'Import a JSON backup of your saved payments';
    }
    const anchor = document.getElementById('clearPayments');
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(btn, anchor); // place before Clear
    } else {
      (document.getElementById('list') ?? document.body)
        .insertAdjacentElement('afterbegin', btn);
    }
    return btn;
  }
  const importPaymentsBtn = ensureImportPaymentsButton();
  importPaymentsBtn?.addEventListener('click', (e) => { e.preventDefault(); handleImportPaymentsClick(); });

  // Payments actions row (responsive arrangement)
  function getPaymentsActionsContainer() {
    const sec = document.getElementById('list') ?? document.body; // Actions row lives in #list
    const table = sec.querySelector('#paymentsTable');
    let row = sec.querySelector('#paymentsActions');
    if (!row) {
      row = document.createElement('div');
      row.id = 'paymentsActions';
      row.className = 'actions-row payments-actions';
    }
    if (table) {
      // Always keep the actions row immediately after the table
      if (table.nextElementSibling !== row) {
        table.insertAdjacentElement('afterend', row);
      }
    } else {
      // Fallback: place at the end of the section if table is missing
      if (row.parentElement !== sec) sec.appendChild(row);
    }
    return row;
  }
  function arrangePaymentsActionsRow() {
    const row = getPaymentsActionsContainer();
    const idsInOrder = ['backupPayments', 'importPayments', 'clearPayments'];
    for (const id of idsInOrder) {
      const el = document.getElementById(id);
      if (el && el.parentElement !== row) row.appendChild(el);
    }
  }

  // Cards actions row (backup/import)
  function getCardsActionsContainer() {
    const sec = document.getElementById('cards') ?? document.body; // prefer #cards
    let row = sec.querySelector('#cardsActions');
    if (!row) {
      row = document.createElement('div');
      row.id='cardsActions';
      row.className='actions-row';
      // Prefer placing right after Add-a-card form if present
      const addForm = sec.querySelector('#card-form');
      if (addForm && addForm.parentElement) {
        addForm.insertAdjacentElement('afterend', row);
      } else {
        sec.prepend(row);
      }
    }
    return row;
  }
  function exportCardsBackup() {
    try {
      const payload = { type:'cardpaypro.cards', version: APP_VERSION, exportedAt: new Date().toISOString(), cards: state.cards ?? [] };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      const dt = new Date(); const yyyy = dt.getFullYear(); const mm = String(dt.getMonth()+1).padStart(2,'0'); const dd = String(dt.getDate()).padStart(2,'0');
      a.download = `cards_backup_${yyyy}${mm}${dd}.json`; a.href = URL.createObjectURL(blob);
      document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      showToast('Cards backup downloaded', { type:'success', duration:2400 });
    } catch (e) { console.error(e); alert('Could not create backup. See console for details.'); }
  }
  function ensureBackupCardsButton() {
    let btn = document.getElementById('backupCards');
    if (!btn) {
      btn = document.createElement('button');
      btn.id='backupCards'; btn.type='button'; btn.className='secondary';
      btn.textContent='Backup cards (.json)'; btn.title='Download a JSON backup of your saved cards';
    }
    const container = getCardsActionsContainer(); container.appendChild(btn); return btn;
  }
  const backupBtn = ensureBackupCardsButton();
  backupBtn?.addEventListener('click', (e)=>{ e.preventDefault(); exportCardsBackup(); });

  function normalizeCard(c) {
    const name = (c && typeof c.name === 'string') ? c.name.trim() : ''; const dueDay = Number(c?.dueDay);
    if (!name) return null; if (!Number.isInteger(dueDay) || dueDay<1 || dueDay>31) return null; return { name, dueDay };
  }
  function importCardsPayload(payload) {
    if (!payload || payload.type !== 'cardpaypro.cards' || !Array.isArray(payload.cards)) throw new Error('Invalid backup format');
    const mode = (prompt('Type MERGE to merge with existing cards (recommended), or type REPLACE to replace ALL existing cards (payments will be cleared).', 'MERGE') ?? '').toUpperCase().trim();
    if (mode !== 'MERGE' && mode !== 'REPLACE') throw new Error('Import cancelled');
    let added=0, updated=0, skipped=0;
    if (mode==='REPLACE') { if (!confirm('Replace ALL existing cards with the import? This will also CLEAR all payments.')) throw new Error('Import cancelled'); state.cards=[]; state.payments=[]; setIcsLock(false); updateIcsLockBadge(); }
    const byName = new Map(state.cards.map(c => [c.name.toLowerCase(), c]));
    for (const raw of payload.cards) {
      const c = normalizeCard(raw); if (!c) { skipped++; continue; }
      const key=c.name.toLowerCase(); const existing = byName.get(key);
      if (existing) { if (existing.dueDay !== c.dueDay) { existing.dueDay=c.dueDay; updated++; } else { skipped++; } }
      else { const nc = { id: uid(), name: c.name, dueDay: c.dueDay }; state.cards.push(nc); byName.set(key,nc); added++; }
    }
    save(STORAGE_KEYS.cards, state.cards); save(STORAGE_KEYS.pays, state.payments); return { added, updated, skipped, mode };
  }
  function handleImportClick() {
    let input = document.getElementById('importCardsInput');
    if (!input) {
      input = document.createElement('input'); input.type='file'; input.accept='application/json'; input.id='importCardsInput'; input.style.display='none'; document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const file = input.files?.[0]; if (!file) return;
        try { const text = await file.text(); const data = JSON.parse(text); const res = importCardsPayload(data); input.value=''; showToast(`Import complete: ${res.added} added, ${res.updated} updated, ${res.skipped} skipped${res.mode==='REPLACE' ? ' (replaced all)' : ''}`, { type:'success', duration:4200 }); renderCards(); renderPaymentCardOptions(); renderPaymentsTable(); }
        catch (e) { console.error(e); alert('Import failed. Please ensure this is a valid CardPay Pro cards backup JSON.'); }
      });
    }
    input.click();
  }
  function ensureImportCardsButton() {
    let btn = document.getElementById('importCards');
    if (!btn) {
      btn = document.createElement('button');
      btn.id='importCards'; btn.type='button'; btn.className='secondary';
      btn.textContent='Restore/Import cards (.json)'; btn.title='Import a JSON backup of your saved cards';
    }
    const container = getCardsActionsContainer(); container.appendChild(btn); return btn;
  }
  const importBtn = ensureImportCardsButton();
  importBtn?.addEventListener('click', (e)=>{ e.preventDefault(); handleImportClick(); });

  // Install prompt
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e; const btn = document.querySelector('#installBtn'); if (!btn) return; btn.hidden=false; btn.addEventListener('click', async ()=>{ if(!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; btn.hidden=true; }, { once:true });
  });

  // Init
  const badge = document.getElementById('appVersion'); if (badge) badge.textContent = APP_VERSION;
  applyLayoutTweaks();
  reorderTabsAndSetDefault();
  wireTabClicks();
  renderCards(); renderPaymentCardOptions(); renderPaymentsTable();
  ensureIcsLockBadge(); updateIcsLockBadge();
  arrangePaymentsActionsRow();

  // Service worker (SWR): show non-blocking Reload toast when assets refresh
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then(() => {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          console.log('[CardPay Pro] New service worker controlling this page.');
        });
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data === 'SW_UPDATED') {
            showReloadToast({ title: 'Update ready', message: 'New version downloaded. Click Reload to apply it now.', actionLabel: 'Reload' });
          }
        });
      }).catch(err => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  /** ICS .ics builder */
  function downloadICS({ title, description, startLocal, durationMinutes=60, alarmDescription='Payment due in 3 days' }) {
    function fmtICSDate(dt){ const pad=n=>String(n).padStart(2,'0'); const y=dt.getFullYear(); const m=pad(dt.getMonth()+1); const d=pad(dt.getDate()); const hh=pad(dt.getHours()); const mm=pad(dt.getMinutes()); return `${y}${m}${d}T${hh}${mm}00`; }
    const dtStart = new Date(startLocal); dtStart.setHours(21,0,0,0); const dtEnd = new Date(dtStart.getTime()+durationMinutes*60*1000); const now=new Date();
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','CALSCALE:GREGORIAN','METHOD:PUBLISH','PRODID:-//CardPay Pro//EN','BEGIN:VEVENT',`UID:${now.getTime()}-${Math.random().toString(36).slice(2)}@cardpaypro.local`,`DTSTAMP:${fmtICSDate(now)}`,`DTSTART:${fmtICSDate(dtStart)}`,`DTEND:${fmtICSDate(dtEnd)}`,`SUMMARY:${String(title??'').replace(/\n/g,' ')}`,`DESCRIPTION:${String(description??'').replace(/\n/g,' ')}`,'BEGIN:VALARM','TRIGGER:-P3D','ACTION:DISPLAY',`DESCRIPTION:${String(alarmDescription??'Payment due in 3 days').replace(/\n/g,' ')}`,'END:VALARM','END:VEVENT','END:VCALENDAR' ];
    const folded = lines.map(line=>{ if(line.length<=70) return line; let out=''; for(let i=0;i<line.length;i+=70) out += (i?'\r\n ':'') + line.slice(i,i+70); return out; }).join('\r\n');
    const blob = new Blob([folded+'\r\n'], { type:'text/calendar' }); const yyyy=dtStart.getFullYear(); const mm=String(dtStart.getMonth()+1).padStart(2,'0'); const dd=String(dtStart.getDate()).padStart(2,'0');
    const a = document.createElement('a'); a.download = `cardpay_${yyyy}${mm}${dd}.ics`; a.href = URL.createObjectURL(blob); document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  }
})();