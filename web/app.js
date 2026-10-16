const $ = (selector, root = document) => root.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  list: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 9 1 1 2-2m-3 7 1 1 2-2m3-5h3m-3 6h3"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  edit: '<path d="m15 5 4 4M4 20l5-1L20 8a3 3 0 0 0-4-4L5 15l-1 5Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  link: '<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  logout: '<path d="M9 4H4v16h5m5-4 4-4-4-4m-6 4h12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  note: '<path d="M4 4h16v12l-4 4H4V4Zm12 16v-4h4M8 8h8m-8 4h5"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  moon: '<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.list}</svg>`;
const initials = name => name.trim().split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
const themeButton = (auth = false) => `<button type="button" class="theme-toggle${auth ? ' auth-theme-toggle' : ''}" data-command="toggle-theme" aria-label="Switch to dark mode" aria-pressed="false"><span data-theme-icon="moon">${icon('moon')}</span><span data-theme-icon="sun" hidden>${icon('sun')}</span>${auth ? '<span class="theme-label">Dark mode</span>' : ''}</button>`;
const app = $('#app');
const dialog = $('#dialog');
let state = null;
let selectedList = localStorage.getItem('together-list') || '';
let filter = 'all';
let search = '';
let events = null;
let busy = false;
let toastTimer;
let refreshSequence = 0;
let latestApplied = 0;
let inviteToken = new URLSearchParams(location.search).get('invite') || '';

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, error ? 6500 : 3500);
}
async function api(path, input) {
  const response = await fetch('/api/' + path, {
    credentials: 'same-origin', cache: 'no-store',
    ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Something went wrong.'); error.status = response.status; throw error; }
  return data;
}
function modal(title, content, wide = false) {
  dialog.innerHTML = `<div class="modal-head"><div><span class="eyebrow">TOGETHER</span><h2 id="dialog-title">${escape(title)}</h2></div><button class="icon-button" data-command="close-dialog" aria-label="Close dialog">${icon('close')}</button></div>${content}`;
  dialog.className = wide ? 'wide' : '';
  if (!dialog.open) dialog.showModal();
}
function closeDialog() { dialog.close(); }

async function boot() {
  events?.close(); events = null;
  try {
    const session = await api('session');
    if (!session.user) {
      let invalidInvite = '';
      if (inviteToken) {
        try { await api('invitation?token=' + encodeURIComponent(inviteToken)); }
        catch (error) { invalidInvite = error.message; }
      }
      renderAuth(session.setupNeeded ? 'setup' : inviteToken && !invalidInvite ? 'register' : 'login', invalidInvite);
      return;
    }
    if (inviteToken) { history.replaceState(null, '', '/'); inviteToken = ''; }
    state = null;
    shell();
    await refresh();
    connect();
  } catch (error) {
    app.innerHTML = `<div class="loading"><span class="brand-mark">✓</span><h2>We couldn’t open your notebook.</h2><p>${escape(error.message)}</p><button class="primary" data-command="retry">Try again ${icon('arrow')}</button></div>`;
  }
}

function renderAuth(mode, error = '') {
  const create = mode !== 'login';
  app.innerHTML = `<main class="auth-page">
    <section class="auth-story"><a class="brand" href="/" aria-label="Together home"><span class="brand-mark">✓</span>Together<span class="brand-period">.</span></a>
      <div class="story-copy"><span class="eyebrow">SMALL PLANS. SHARED MOMENTS.</span><h1>A little less<br>to remember<span>.</span></h1><p>For the everyday things and the big weekend plans.<br>One simple list. Everyone on the same page.</p>
      <div class="notebook-illustration" aria-hidden="true"><div class="paper-label">THE GOOD KIND OF PLANS ${icon('spark')}</div><div class="paper-row checked"><span>✓</span>Find our next adventure</div><div class="paper-row checked"><span>✓</span>Bring the good company</div><div class="paper-row"><span></span>Make a little time together</div><div class="paper-footer">A plan is better when it’s shared. <span>↗</span></div></div></div>
      <div class="story-footer">A shared notebook. A clearer head. ${icon('lock')} Private by invitation.</div>
    </section>
    <section class="auth-form-area">${themeButton(true)}<div class="auth-card"><span class="small-mark">${icon(create ? 'spark' : 'list')}</span>
      <span class="eyebrow">${mode === 'setup' ? 'A FRESH START' : mode === 'register' ? 'YOU’RE INVITED' : 'YOUR PLANS ARE WAITING'}</span>
      <h2>${mode === 'setup' ? 'Make yourself at home.' : mode === 'register' ? 'Better, together.' : 'Welcome back.'}</h2>
      <p>${mode === 'setup' ? 'Create the first account for your notebook. You’ll be the owner and can invite your friends.' : mode === 'register' ? 'Create your account using the email address your friend invited.' : 'Sign in to your shared notebook. Pick up right where you left off.'}</p>
      <form id="auth-form" data-mode="${mode}">
        ${create ? '<label>Your name<input name="name" autocomplete="name" placeholder="What should we call you?" maxlength="60" required></label>' : ''}
        <label>Email address<input type="email" name="email" autocomplete="email" placeholder="you@example.com" maxlength="254" required></label>
        <label>Password<input type="password" name="password" autocomplete="${create ? 'new-password' : 'current-password'}" placeholder="${create ? 'At least 10 characters' : 'Your password'}" minlength="10" maxlength="128" required></label>
        <p class="form-error" id="auth-error" role="alert">${escape(error)}</p>
        <button class="primary full" type="submit">${create ? 'Create account' : 'Sign in'} ${icon('arrow')}</button>
      </form>
      ${inviteToken ? `<p class="auth-switch">${create ? 'Already have an account?' : 'Joining for the first time?'} <button class="text-button" data-command="auth-switch" data-mode="${create ? 'login' : 'register'}">${create ? 'Sign in' : 'Create account'}</button></p>` : !create ? '<p class="auth-switch">New here? Ask the notebook owner for a personal invitation.</p>' : ''}
      <div class="auth-private">${icon('lock')} Your notebook is only visible to invited members.</div>
    </div><span class="auth-bottom">Less organizing. More living.</span></section>
  </main>`;
  window.togetherTheme.sync();
  $('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    $('#auth-error').textContent = '';
    try {
      const values = Object.fromEntries(new FormData(form));
      await api(mode === 'setup' ? 'setup' : mode === 'register' ? 'register' : 'login', { ...values, invite: inviteToken });
      history.replaceState(null, '', '/'); inviteToken = '';
      await boot();
    } catch (error) { $('#auth-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
}

function shell() {
  app.innerHTML = `<div class="workspace">
    <button class="sidebar-backdrop" data-command="mobile-menu" aria-label="Close navigation"></button>
    <aside class="sidebar"><a href="/" class="brand"><span class="brand-mark">✓</span>Together<span class="brand-period">.</span></a>
      <div class="notebook-label">YOUR SHARED SPACE</div><button class="notebook-button" data-command="notebook-settings">${icon('users')}<span id="notebook-name">Our notebook</span>${icon('chevron')}</button>
      <div class="sidebar-section"><span>YOUR LISTS</span><button class="icon-button" data-command="new-list" aria-label="Create a list">${icon('plus')}</button></div>
      <nav id="list-nav" aria-label="To-do lists"></nav>
      <button class="new-list-button" data-command="new-list">${icon('plus')} New list</button>
      <div class="sidebar-bottom"><div class="together-card"><span class="card-icon">${icon('users')}</span><h3>A little teamwork<br>goes a long way.</h3><p>Bring your people.<br>Check things off together.</p><button class="text-button" data-command="invite">Invite a friend ${icon('arrow')}</button></div>
      <button class="user-profile" data-command="account"><span class="avatar" id="my-avatar"></span><span><strong id="my-name"></strong><small>Account settings</small></span>${icon('more')}</button></div>
    </aside>
    <div class="main-wrap"><header class="topbar"><div class="breadcrumbs"><button class="icon-button mobile-toggle" data-command="mobile-menu" aria-label="Open navigation">${icon('menu')}</button>${icon('list')}<span id="breadcrumb-notebook">Our notebook</span>${icon('chevron')}<strong id="breadcrumb-list">Your lists</strong></div>
      <div class="topbar-right"><span id="connection" class="connection connecting"><span></span>Connecting</span><div id="member-avatars" class="avatar-group"></div>${themeButton()}<button class="primary compact" data-command="invite">${icon('users')}<span>Invite friends</span></button></div></header>
      <main class="main-content"><div class="page-intro"><span class="eyebrow">A LITTLE LESS TO REMEMBER</span><p>Make a plan. Share the load. Enjoy the little wins.</p></div>
        <section id="list-content"><div class="list-heading"><div><div id="list-symbol" class="list-symbol purple">${icon('list')}</div><h1 id="list-title">Your list</h1><p id="list-subtitle">One thing at a time. You’ve got this.</p></div><div class="list-controls"><button class="icon-button" data-command="list-options" aria-label="List options">${icon('more')}</button></div></div>
          <div class="progress-panel"><div><span class="progress-icon">${icon('check')}</span><span id="progress-text">A fresh start</span></div><span id="progress-count">0 of 0 done</span><progress id="progress" max="100" value="0" aria-label="List completion"></progress></div>
          <div class="task-toolbar"><div class="tabs" role="group" aria-label="Filter tasks"><button class="tab active" data-command="filter" data-filter="all" aria-pressed="true">All tasks <span id="all-count">0</span></button><button class="tab" data-command="filter" data-filter="open" aria-pressed="false">To do <span id="open-count">0</span></button><button class="tab" data-command="filter" data-filter="done" aria-pressed="false">Done <span id="done-count">0</span></button></div>
            <label class="task-search">${icon('search')}<input id="task-search" aria-label="Search this list" placeholder="Search tasks…"><kbd>/</kbd></label></div>
          <form id="add-task" class="add-task"><span class="add-symbol">${icon('plus')}</span><input name="text" id="task-input" placeholder="What needs to get done?" aria-label="New task" maxlength="300" autocomplete="off" required><button type="submit" class="primary">Add task ${icon('arrow')}</button></form>
          <div id="task-list" class="task-list" aria-label="Tasks"></div>
          <div class="list-footer"><span>${icon('lock')} Just you and your invited friends.</span><button class="text-button" data-command="complete-list" id="complete-all">${icon('check')} Check off all</button></div>
        </section>
        <section class="empty-notebook hidden" id="empty-notebook"><span class="empty-icon">${icon('list')}</span><h2>A little space for your plans.</h2><p>Create a list and start with one small thing.</p><button class="primary" data-command="new-list">${icon('plus')} Create your first list</button></section>
        <footer class="page-footer"><span>Together<span class="brand-period">.</span></span> Life’s a little lighter when you share the list.</footer>
      </main>
    </div></div>`;
  window.togetherTheme.sync();
  $('#task-search').addEventListener('input', event => { search = event.target.value; renderTasks(); });
  $('#add-task').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('#task-input');
    const taskText = input.value.trim();
    if (!taskText || busy) return;
    if (await act({ action: 'add-task', listId: selectedList, text: taskText })) { input.value = ''; input.focus(); }
  });
}

function connection(connected) {
  const el = $('#connection');
  if (!el) return;
  el.className = `connection ${connected ? '' : 'connecting'}`;
  el.innerHTML = `<span></span>${connected ? 'Live together' : 'Reconnecting…'}`;
}
function connect() {
  events?.close();
  events = new EventSource('/api/events');
  events.onopen = () => { connection(true); refresh().catch(handleRefreshError); };
  events.addEventListener('change', () => refresh().catch(handleRefreshError));
  events.onerror = () => { connection(false); refresh().catch(handleRefreshError); };
}
function handleRefreshError(error) {
  if (error.status === 401) { events?.close(); state = null; boot(); }
  else connection(false);
}
async function refresh() {
  const sequence = ++refreshSequence;
  const next = await api('state');
  if (sequence < latestApplied || (state && next.revision < state.revision)) return;
  latestApplied = sequence;
  state = next;
  if (!state.lists.some(list => list.id === selectedList)) selectedList = state.lists[0]?.id || '';
  render();
}
async function act(input) {
  if (busy) return false;
  busy = true;
  $('#add-task button')?.setAttribute('disabled', '');
  try {
    const result = await api('action', input);
    if (result.listId) selectedList = result.listId;
    await refresh();
    return result;
  } catch (error) {
    toast(error.message, true);
    if (error.status === 401) await boot();
    else try { await refresh(); } catch { connection(false); }
    return false;
  } finally { busy = false; $('#add-task button')?.removeAttribute('disabled'); }
}

function render() {
  if (!state || !$('#list-nav')) return;
  $('#notebook-name').textContent = state.name;
  $('#breadcrumb-notebook').textContent = state.name;
  $('#my-name').textContent = state.me.name;
  $('#my-avatar').textContent = initials(state.me.name);
  $('#list-nav').innerHTML = state.lists.map(list => {
    const count = state.tasks.filter(task => task.list_id === list.id && !task.done).length;
    return `<button class="nav-list${list.id === selectedList ? ' selected' : ''}" data-command="select-list" data-id="${escape(list.id)}"${list.id === selectedList ? ' aria-current="page"' : ''}><span class="list-dot ${escape(list.color)}"></span><span>${escape(list.title)}</span><small>${count}</small></button>`;
  }).join('');
  $('#member-avatars').innerHTML = state.members.slice(0, 4).map(member => `<span class="avatar ${member.online ? 'online' : ''}" title="${escape(member.name)}${member.online ? ' · Online' : ''}">${escape(initials(member.name))}</span>`).join('') + (state.members.length > 4 ? `<span class="avatar">+${state.members.length - 4}</span>` : '');
  const list = state.lists.find(item => item.id === selectedList);
  $('#list-content').classList.toggle('hidden', !list);
  $('#empty-notebook').classList.toggle('hidden', Boolean(list));
  if (!list) { $('#breadcrumb-list').textContent = 'Your lists'; return; }
  localStorage.setItem('together-list', selectedList);
  document.title = `${list.title} · Together`;
  $('#list-title').textContent = list.title;
  $('#breadcrumb-list').textContent = list.title;
  $('#list-symbol').className = `list-symbol ${list.color}`;
  const tasks = state.tasks.filter(task => task.list_id === selectedList);
  const done = tasks.filter(task => task.done).length;
  $('#list-subtitle').textContent = tasks.length && done === tasks.length ? 'All checked off. Make room for something good.' : 'One thing at a time. You’ve got this.';
  $('#progress-text').textContent = done === tasks.length && tasks.length ? 'Look at you, getting things done!' : done ? 'Small steps. Real progress.' : 'Every little thing starts somewhere.';
  $('#progress-count').textContent = `${done} of ${tasks.length} done`;
  $('#progress').value = tasks.length ? (done / tasks.length) * 100 : 0;
  $('#all-count').textContent = tasks.length;
  $('#open-count').textContent = tasks.length - done;
  $('#done-count').textContent = done;
  $('#complete-all').disabled = !tasks.some(task => !task.done);
  renderTasks();
}
function renderTasks() {
  if (!state) return;
  const all = state.tasks.filter(task => task.list_id === selectedList);
  const tasks = all.filter(task => (filter === 'all' || (filter === 'done' ? task.done : !task.done)) && `${task.text} ${task.note}`.toLowerCase().includes(search.toLowerCase()));
  tasks.sort((a, b) => a.done - b.done);
  $('#task-list').innerHTML = tasks.length ? tasks.map(task => {
    const author = state.members.find(member => member.id === task.updated_by);
    return `<article class="task-row${task.done ? ' completed' : ''}"><button class="task-checkbox" role="checkbox" aria-checked="${Boolean(task.done)}" aria-label="${escape(task.done ? 'Mark as to do: ' : 'Complete: ')}${escape(task.text)}" data-command="toggle-task" data-id="${escape(task.id)}">${task.done ? icon('check') : ''}</button><button class="task-copy" data-command="edit-task" data-id="${escape(task.id)}" aria-label="Edit ${escape(task.text)}"><span class="task-title">${escape(task.text)}</span>${task.note ? `<span class="task-note">${icon('note')}${escape(task.note)}</span>` : ''}</button><div class="task-actions">${author ? `<span class="task-author" title="Last changed by ${escape(author.name)}">${escape(initials(author.name))}</span>` : ''}<button class="icon-button" data-command="edit-task" data-id="${escape(task.id)}" aria-label="Edit task">${icon('edit')}</button></div></article>`;
  }).join('') : `<div class="empty-tasks"><span class="empty-icon">${icon(search ? 'search' : filter === 'done' ? 'check' : 'list')}</span><h3>${search ? 'No matching tasks.' : filter === 'done' ? 'Your little wins will live here.' : filter === 'open' && all.length ? 'A clean slate. Nicely done.' : 'Big plans start with a small task.'}</h3><p>${search ? 'Try a different word or clear your search.' : filter === 'done' ? 'Check off a task and watch your progress grow.' : filter === 'open' && all.length ? 'Everything on this list is checked off.' : 'Add your first task above. You can figure out the rest together.'}</p></div>`;
}

function listForm(rename = false) {
  const list = state.lists.find(item => item.id === selectedList);
  modal(rename ? 'A name for your list.' : 'What are we planning?', `<p class="modal-description">${rename ? 'Give this list a name that feels right.' : 'A weekend away, the weekly shop, or a little bit of everything.'}</p><form id="list-form"><label>List name<input name="title" placeholder="e.g. Weekend plans" maxlength="80" value="${rename ? escape(list.title) : ''}" required autofocus></label>${!rename ? '<fieldset class="color-picker"><legend>A little color</legend>' + ['purple','green','orange','blue','pink'].map((color, i) => `<label class="color-option ${color}"><input type="radio" name="color" value="${color}"${i === 0 ? ' checked' : ''}><span aria-label="${color}">✓</span></label>`).join('') + '</fieldset>' : ''}<button class="primary full" type="submit">${rename ? 'Save name' : 'Create list'} ${icon('arrow')}</button></form>`);
  $('#list-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (await act({ action: rename ? 'rename-list' : 'add-list', listId: selectedList, ...Object.fromEntries(new FormData(event.currentTarget)) })) closeDialog();
  });
}
function editTask(id) {
  const task = state.tasks.find(item => item.id === id);
  if (!task) return;
  modal('The little details.', `<form id="edit-task-form"><label>Task<input name="text" value="${escape(task.text)}" maxlength="300" required autofocus></label><label>Notes <span class="optional">optional</span><textarea name="note" rows="4" maxlength="2000" placeholder="Anything your friends should know?">${escape(task.note)}</textarea></label><div class="modal-actions"><button type="button" class="danger-quiet" data-command="delete-task" data-id="${escape(id)}">${icon('trash')} Delete task</button><button type="submit" class="primary">Save changes ${icon('check')}</button></div></form>`);
  $('#edit-task-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (await act({ action: 'update-task', taskId: task.id, version: task.version, ...Object.fromEntries(new FormData(event.currentTarget)) })) closeDialog();
  });
  dialog.dataset.taskVersion = task.version;
}
function confirmAction(title, description, label, callback) {
  modal(title, `<p class="modal-description">${escape(description)}</p><div class="modal-actions"><button class="secondary" data-command="close-dialog">Cancel</button><button class="danger" id="confirm-action">${escape(label)}</button></div>`);
  $('#confirm-action').addEventListener('click', async () => { if (await callback()) closeDialog(); });
}
function showInvite() {
  const owner = state.me.role === 'owner';
  modal('Good company. Shared plans.', `<p class="modal-description">${owner ? 'Invite a friend by email address. Only that address can use their personal link to create an account.' : 'Everyone here can add, edit, and check off tasks. Ask the notebook owner to invite more friends.'}</p>
    ${owner ? '<form id="invite-form"><label>Your friend’s email<div class="inline-input"><input type="email" name="email" placeholder="friend@example.com" maxlength="254" required autofocus><button class="primary" type="submit">Create link '+icon('arrow')+'</button></div></label></form><div id="invite-result"></div>' : ''}
    <h3 class="member-heading">IN THIS NOTEBOOK <span>${state.members.length}</span></h3><div class="member-list">${state.members.map(member => `<div class="member"><span class="avatar">${escape(initials(member.name))}</span><span class="member-info"><strong>${escape(member.name)}${member.id === state.me.id ? ' <small>(you)</small>' : ''}</strong><small>${escape(member.email)}</small></span>${member.role === 'owner' ? '<span class="role-badge">Owner</span>' : owner ? `<button class="icon-button" data-command="remove-member" data-id="${escape(member.id)}" aria-label="Remove ${escape(member.name)}">${icon('close')}</button>` : '<span class="role-badge">Member</span>'}</div>`).join('')}</div>
    ${state.invitations.length ? '<h3 class="member-heading">PENDING INVITATIONS</h3><div class="member-list">' + state.invitations.map(invite => `<div class="member"><span class="small-mark">${icon('link')}</span><span class="member-info"><strong>${escape(invite.email)}</strong><small>Expires ${escape(new Date(invite.expires_at).toLocaleDateString('en', { month: 'short', day: 'numeric' }))}</small></span><button class="icon-button" data-command="revoke-invite" data-id="${escape(invite.id)}" aria-label="Revoke invitation">${icon('close')}</button></div>`).join('') + '</div>' : ''}
    <p class="modal-footnote">${icon('lock')} Invitation links expire after 7 days. Share them yourself; no email is sent automatically.</p>`, true);
  $('#invite-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const result = await act({ action: 'invite', ...Object.fromEntries(new FormData(event.currentTarget)) });
    if (!result) return;
    const link = location.origin + result.invitePath;
    $('#invite-result').innerHTML = `<div class="invite-result"><strong>Ready to share with ${escape(result.email)}</strong><p>Send this personal link to your friend.</p><div class="inline-input"><input id="invite-link" readonly aria-label="Invitation link" value="${escape(link)}"><button class="secondary" id="copy-link">${icon('link')} Copy</button></div></div>`;
    $('#copy-link').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); toast('Invitation link copied.'); }
      catch { $('#invite-link').select(); toast('Select and copy the invitation link.'); }
    });
  });
}
function accountSettings() {
  modal('Your little corner.', `<p class="modal-description">Signed in as <strong>${escape(state.me.email)}</strong>.</p><form id="password-form"><label>Current password<input type="password" name="currentPassword" autocomplete="current-password" maxlength="128" required></label><label>New password<input type="password" name="password" autocomplete="new-password" minlength="10" maxlength="128" placeholder="At least 10 characters" required></label><button class="primary full" type="submit">Update password ${icon('lock')}</button></form><button class="sign-out" data-command="logout">${icon('logout')} Sign out</button>`);
  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    try { await api('password', Object.fromEntries(new FormData(event.currentTarget))); closeDialog(); toast('Password updated. Other sessions have been signed out.'); }
    catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-command]');
  if (!button) return;
  const command = button.dataset.command;
  const id = button.dataset.id;
  if (command === 'toggle-theme') return window.togetherTheme.toggle();
  if (command === 'close-dialog') return closeDialog();
  if (command === 'retry') return boot();
  if (command === 'auth-switch') return renderAuth(button.dataset.mode);
  if (!state) return;
  if (command === 'mobile-menu') { $('.workspace').classList.toggle('nav-open'); return; }
  if (command === 'select-list') {
    selectedList = id; search = ''; filter = 'all'; $('#task-search').value = '';
    $('.workspace').classList.remove('nav-open');
    document.querySelectorAll('.tab').forEach(tab => { tab.classList.toggle('active', tab.dataset.filter === filter); tab.setAttribute('aria-pressed', tab.dataset.filter === filter); });
    render(); return;
  }
  if (command === 'filter') {
    filter = button.dataset.filter;
    document.querySelectorAll('.tab').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', tab === button); });
    renderTasks(); return;
  }
  if (command === 'new-list') return listForm();
  if (command === 'edit-task') return editTask(id);
  if (command === 'toggle-task') {
    const task = state.tasks.find(item => item.id === id);
    if (!task || busy) return;
    button.disabled = true;
    return act({ action: 'update-task', taskId: id, version: task.version, done: !task.done });
  }
  if (command === 'delete-task') {
    const task = state.tasks.find(item => item.id === id);
    const version = Number(dialog.dataset.taskVersion);
    if (!task) return;
    return confirmAction('Remove this task?', task.text, 'Delete task', () => act({ action: 'delete-task', taskId: id, version }));
  }
  if (command === 'complete-list') {
    return confirmAction('Everything taken care of?', 'This checks off every remaining task in this list. You can uncheck individual tasks any time.', 'Check off all', () => act({ action: 'complete-list', listId: selectedList }));
  }
  if (command === 'list-options') {
    const list = state.lists.find(item => item.id === selectedList);
    modal('Make this list yours.', `<p class="modal-description">${escape(list.title)}</p><div class="option-list"><button data-command="rename-list">${icon('edit')} Rename list ${icon('chevron')}</button><button class="danger-quiet" data-command="delete-list">${icon('trash')} Delete list ${icon('chevron')}</button></div>`);
    return;
  }
  if (command === 'rename-list') return listForm(true);
  if (command === 'delete-list') {
    const list = state.lists.find(item => item.id === selectedList);
    const listId = selectedList;
    return confirmAction('Delete this list?', `“${list.title}” and all of its tasks will be permanently deleted for everyone.`, 'Delete list', () => act({ action: 'delete-list', listId }));
  }
  if (command === 'invite') return showInvite();
  if (command === 'revoke-invite') { if (await act({ action: 'revoke-invite', inviteId: id })) { showInvite(); toast('Invitation revoked.'); } return; }
  if (command === 'remove-member') {
    const member = state.members.find(item => item.id === id);
    return confirmAction('Remove this member?', `${member.name} will be signed out and lose access to this notebook. Their tasks will remain.`, 'Remove member', () => act({ action: 'remove-member', userId: id }));
  }
  if (command === 'account') return accountSettings();
  if (command === 'notebook-settings') {
    if (state.me.role !== 'owner') return showInvite();
    modal('A place for your people.', `<form id="notebook-form"><label>Notebook name<input name="title" value="${escape(state.name)}" maxlength="80" required autofocus></label><button type="submit" class="primary full">Save name ${icon('check')}</button></form>`);
    $('#notebook-form').addEventListener('submit', async event => { event.preventDefault(); if (await act({ action: 'rename-notebook', ...Object.fromEntries(new FormData(event.currentTarget)) })) closeDialog(); });
    return;
  }
  if (command === 'logout') {
    try { await api('logout', {}); closeDialog(); events?.close(); state = null; await boot(); }
    catch (error) { toast(error.message, true); }
  }
});
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });
document.addEventListener('keydown', event => {
  if (event.key === '/' && !dialog.open && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && $('#task-search')) { event.preventDefault(); $('#task-search').focus(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && state) refresh().catch(handleRefreshError); });
boot();
