import type {
  CleanReport,
  DeepCleanerApi,
  HistoryEntry,
  OpResult,
  QuarantineItem,
  SystemInfo,
  TargetScan,
} from '../shared/api';
import { daysUntil, escapeHtml as esc, formatBytes as fmt, formatDate } from '../shared/format';

declare global {
  interface Window {
    deepCleaner: DeepCleanerApi;
  }
}

const api = window.deepCleaner;

type View = 'dashboard' | 'programs' | 'largefiles' | 'cache' | 'images' | 'quarantine' | 'history';

const state = {
  view: 'dashboard' as View,
  info: null as SystemInfo | null,
  cache: null as TargetScan[] | null,
  cacheSel: new Set<string>(),
  busy: false,
  quarantine: [] as QuarantineItem[],
  qSel: new Set<string>(),
  history: [] as HistoryEntry[],
};

const viewEl = document.getElementById('view')!;
const ACTION_LABEL: Record<string, string> = {
  clean: 'Čišćenje',
  quarantine: 'U karantin',
  restore: 'Vraćeno',
  delete: 'Trajno obrisano',
  purge: 'Istekao karantin',
  uninstall: 'Deinstalacija',
};
const MODULE_LABEL: Record<string, string> = {
  cache: 'Windows cache',
  largefiles: 'Veliki fajlovi',
  uninstall: 'Programi',
  images: 'Slike',
  quarantine: 'Karantin',
};

// ---------- Small UI primitives ----------

function toast(msg: string, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toast-root')!.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

interface ModalOpts {
  title: string;
  body: string;
  confirm: string;
  cancel?: string | null;
  kind?: 'primary' | 'danger' | 'red';
}

/** Resolves true when confirmed. Escape / backdrop click cancels. */
function modal(o: ModalOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root')!;
    root.innerHTML = `
      <div class="modal-back" data-close>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h2 id="m-title">${esc(o.title)}</h2>
          <div class="body">${o.body}</div>
          <div class="btns">
            ${o.cancel === null ? '' : `<button class="btn ghost" data-close>${esc(o.cancel ?? 'Otkaži')}</button>`}
            <button class="btn ${o.kind ?? 'primary'}" data-ok>${esc(o.confirm)}</button>
          </div>
        </div>
      </div>`;
    const done = (v: boolean) => {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && done(false);
    document.addEventListener('keydown', onKey);
    root.querySelector<HTMLButtonElement>('[data-ok]')!.focus();
    root.querySelector('[data-ok]')!.addEventListener('click', () => done(true));
    root.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', (e) => e.target === el && done(false)),
    );
  });
}

function head(kicker: string, title: string, actions = '') {
  return `<div class="view-head"><div><div class="kicker">${kicker}</div><h1>${title}</h1></div><div>${actions}</div></div>`;
}

function failureList(failed: { path: string; reason: string }[]) {
  if (!failed.length) return '';
  const rows = failed
    .slice(0, 6)
    .map((f) => `<li class="selectable"><span class="mono">${esc(f.path)}</span>: ${esc(f.reason)}</li>`)
    .join('');
  return `<p>Nije uspjelo (${failed.length}):</p><ul>${rows}</ul>`;
}

// ---------- Data ----------

async function refreshInfo() {
  state.info = await api.system.info();
  const foot = document.getElementById('side-foot')!;
  foot.innerHTML = state.info.isAdmin
    ? '<span class="chip safe">● Administrator</span>'
    : '<span class="chip warn">● Standardni korisnik</span>';
}

async function refreshQuarantine() {
  state.quarantine = await api.quarantine.list();
  const ids = new Set(state.quarantine.map((q) => q.id));
  state.qSel = new Set([...state.qSel].filter((id) => ids.has(id)));
  document.getElementById('q-count')!.textContent = state.quarantine.length ? String(state.quarantine.length) : '';
}

async function scanCache() {
  state.busy = true;
  state.cache = null;
  render();
  try {
    state.cache = await api.cache.scan();
    state.cacheSel = new Set(state.cache.filter((t) => t.bytes > 0 && canClean(t)).map((t) => t.id));
  } catch (err) {
    toast('Skeniranje nije uspjelo: ' + (err as Error).message, true);
  } finally {
    state.busy = false;
    render();
  }
}

function canClean(t: TargetScan) {
  return !t.requiresAdmin || !!state.info?.isAdmin;
}

// ---------- Views ----------

function renderDashboard() {
  const d = state.info?.disk;
  const used = d ? d.total - d.free : 0;
  const pct = d ? Math.round((used / d.total) * 100) : 0;
  const reclaim = state.cache?.filter(canClean).reduce((s, t) => s + t.bytes, 0) ?? 0;
  const reclaimPct = d ? Math.min(pct, (reclaim / d.total) * 100) : 0;
  const qBytes = state.quarantine.reduce((s, q) => s + q.bytes, 0);
  const usedOnly = pct - reclaimPct;

  return `
    ${head('Kontrolna tabla', `Disk ${esc(d?.drive ?? 'C:')} <span class="grad">pregled</span>`,
      `<button class="btn primary" data-act="scan-go">${state.cache ? 'Skeniraj ponovo' : 'Pametno skeniranje'}</button>`)}
    <div class="dash">
      <div class="panel disk">
        <div class="ring" style="background: conic-gradient(var(--cyan) 0 ${usedOnly}%, var(--magenta) ${usedOnly}% ${pct}%, rgba(255,255,255,.07) ${pct}% 100%)">
          <div><b>${pct}%</b><span class="muted">${d ? `${fmt(used)} / ${fmt(d.total)}` : '…'}</span></div>
        </div>
        <div class="legend">
          <span><i style="background:var(--cyan)"></i>Zauzeto</span>
          <span><i style="background:var(--magenta)"></i>Može se osloboditi</span>
          <span><i style="background:#26314f"></i>Slobodno ${d ? fmt(d.free) : ''}</span>
        </div>
      </div>
      <div class="mods">
        <button class="panel mod" data-go="cache">
          <div class="t">Windows cache <span>${state.cache ? 'skenirano' : 'nije skenirano'}</span></div>
          <b>${state.cache ? fmt(reclaim) : '—'}</b>
          <span class="muted">Samo sigurne lokacije. Sistem se ne dira.</span>
        </button>
        <button class="panel mod" data-go="quarantine">
          <div class="t">Karantin <span>30 dana</span></div>
          <b>${fmt(qBytes)}</b>
          <span class="muted">${state.quarantine.length} stavki se može vratiti</span>
        </button>
        ${['Programi', 'Veliki fajlovi', 'Slike']
          .map((m) => `<div class="panel mod soon"><div class="t">${m} <span>uskoro</span></div><b>U izradi</b><span class="muted">Sljedeći modul</span></div>`)
          .join('')}
      </div>
    </div>`;
}

function renderCache() {
  const adminBanner = state.info && !state.info.isAdmin
    ? `<div class="banner"><span>⚠</span><span><b>Pokrenuto bez administratorskih prava.</b> Windows Temp, Update preuzimanja i sistemski dumpovi se preskaču. Za njih pokreni DeepCleaner kao administrator.</span></div>`
    : '';

  if (state.busy || !state.cache) {
    return `${head('Windows cache', 'Čisti cache, <span class="grad">sistem ostaje netaknut</span>')}
      ${adminBanner}
      ${state.busy
        ? '<div class="scanning"><div class="radar"></div>Skeniram sigurne lokacije…</div>'
        : '<div class="empty"><h2>Još nije skenirano</h2><p>Skeniranje samo čita veličine, ništa ne briše.</p><br><button class="btn primary" data-act="scan">Skeniraj</button></div>'}`;
  }

  const rows = state.cache
    .map((t) => {
      const allowed = canClean(t);
      const checked = state.cacheSel.has(t.id) ? 'checked' : '';
      const chips = [
        t.requiresAdmin && !allowed ? '<span class="chip warn">Treba admin</span>' : '',
        t.lockedBy?.length ? `<span class="chip lock" title="Zatvori program za potpuno čišćenje">${esc(t.lockedBy.join(', '))}</span>` : '',
        t.roots.length === 0 ? '<span class="chip">Nije pronađeno</span>' : '',
      ].join('');
      return `
        <label class="tr ${checked ? 'sel' : ''}">
          <input type="checkbox" class="cb" data-cache="${esc(t.id)}" ${checked} ${allowed && t.bytes > 0 ? '' : 'disabled'}>
          <span class="name"><b>${esc(t.label)}</b><small>${esc(t.description)}</small></span>
          <span class="chips">${chips}</span>
          <span class="num">${t.files ? fmt(t.bytes) : '0 B'}</span>
        </label>`;
    })
    .join('');

  const selected = state.cache.filter((t) => state.cacheSel.has(t.id));
  const total = selected.reduce((s, t) => s + t.bytes, 0);

  return `
    ${head('Windows cache', 'Čisti cache, <span class="grad">sistem ostaje netaknut</span>',
      '<button class="btn ghost" data-act="scan">Skeniraj ponovo</button>')}
    ${adminBanner}
    <div class="tbl t-cache">
      <div class="tr head"><span></span><span>Kategorija</span><span></span><span class="num">Veličina</span></div>
      ${rows}
    </div>
    <div class="protected">
      <h2>Zaštićeno, nikad se ne dira</h2>
      <ul>
        <li>C:\\Windows\\System32</li><li>C:\\Windows\\WinSxS</li><li>DriverStore</li>
        <li>Registry hives (NTUSER.DAT)</li><li>pagefile.sys · hiberfil.sys</li><li>C:\\Windows\\Fonts</li>
        <li>Lozinke, kolačići i historija preglednika</li><li>Tvoji dokumenti, slike i Desktop</li>
      </ul>
    </div>
    <div class="action-bar">
      <span class="sum muted">${selected.length} kategorija · <b>${fmt(total)}</b></span>
      <div class="btns"><button class="btn primary" data-act="clean" ${selected.length && total ? '' : 'disabled'}>Očisti cache</button></div>
    </div>`;
}

function renderQuarantine() {
  const items = state.quarantine;
  if (!items.length) {
    return `${head('Karantin', 'Svaka greška se može <span class="grad">poništiti</span>')}
      <div class="empty"><h2>Karantin je prazan</h2><p>Fajlovi koje ukloniš iz modula Veliki fajlovi, Programi i Slike čuvaju se ovdje 30 dana.</p></div>`;
  }
  const rows = items
    .map((q) => {
      const checked = state.qSel.has(q.id) ? 'checked' : '';
      const name = q.originalPath.split('\\').pop() ?? q.originalPath;
      return `
        <label class="tr ${checked ? 'sel' : ''}">
          <input type="checkbox" class="cb" data-q="${esc(q.id)}" ${checked}>
          <span class="name"><b>${esc(name)}</b><small class="mono selectable" title="${esc(q.originalPath)}">${esc(q.originalPath)}</small></span>
          <span><span class="chip mag">${esc(MODULE_LABEL[q.module] ?? q.module)}</span></span>
          <span class="num">${fmt(q.bytes)}</span>
          <span class="num muted">ističe za ${daysUntil(q.expiresAt)} d</span>
        </label>`;
    })
    .join('');
  const sel = items.filter((q) => state.qSel.has(q.id));
  return `
    ${head('Karantin', 'Svaka greška se može <span class="grad">poništiti</span>')}
    <div class="tbl t-q">
      <div class="tr head"><span></span><span>Stavka</span><span>Modul</span><span class="num">Veličina</span><span class="num">Rok</span></div>
      ${rows}
    </div>
    <div class="action-bar">
      <span class="sum muted">${sel.length} odabrano · <b>${fmt(sel.reduce((s, q) => s + q.bytes, 0))}</b></span>
      <div class="btns">
        <button class="btn red" data-act="q-remove" ${sel.length ? '' : 'disabled'}>Trajno obriši</button>
        <button class="btn primary" data-act="q-restore" ${sel.length ? '' : 'disabled'}>Vrati odabrano</button>
      </div>
    </div>`;
}

function renderHistory() {
  if (!state.history.length) {
    return `${head('Historija', 'Dnevnik <span class="grad">svih akcija</span>')}
      <div class="empty"><h2>Još nema akcija</h2><p>Svako čišćenje, karantin i vraćanje bilježi se ovdje.</p></div>`;
  }
  const rows = state.history
    .map((h) => `
      <div class="tr" title="${esc((h.sample ?? []).join('\n'))}">
        <span class="mono muted">${formatDate(h.ts)}</span>
        <span>${esc(ACTION_LABEL[h.action] ?? h.action)}</span>
        <span class="muted">${esc(MODULE_LABEL[h.module] ?? h.module)}</span>
        <span class="num">${h.items}</span>
        <span class="num">${fmt(h.bytes)}</span>
        <span class="num ${h.failed ? '' : 'muted'}" style="${h.failed ? 'color:var(--amber)' : ''}">${h.failed}</span>
      </div>`)
    .join('');
  return `${head('Historija', 'Dnevnik <span class="grad">svih akcija</span>')}
    <div class="tbl t-h">
      <div class="tr head"><span>Vrijeme</span><span>Akcija</span><span>Modul</span><span class="num">Stavki</span><span class="num">Veličina</span><span class="num">Preskočeno</span></div>
      ${rows}
    </div>`;
}

const SOON: Record<string, [string, string]> = {
  programs: ['Programi', 'Duboka deinstalacija: originalni uninstaller, zatim pregled ostataka (fajlovi, registar, servisi) sa nivoom rizika.'],
  largefiles: ['Veliki fajlovi', 'Treemap i lista najvećih fajlova, filteri po tipu i starosti, uklanjanje u karantin.'],
  images: ['Slike', 'Grupisanje sličnih slika, ocjena kvaliteta: BOLJA ostaje, LOŠIJE se mogu ukloniti.'],
};

function renderSoon(v: string) {
  const [title, desc] = SOON[v];
  return `${head(title, `${title} <span class="grad">uskoro</span>`)}
    <div class="empty"><h2>Modul je u izradi</h2><p>${esc(desc)}</p></div>`;
}

function render() {
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((b) =>
    b.classList.toggle('on', b.dataset.view === state.view),
  );
  const html: Record<View, () => string> = {
    dashboard: renderDashboard,
    cache: renderCache,
    quarantine: renderQuarantine,
    history: renderHistory,
    programs: () => renderSoon('programs'),
    largefiles: () => renderSoon('largefiles'),
    images: () => renderSoon('images'),
  };
  viewEl.innerHTML = html[state.view]();
}

async function go(view: View) {
  state.view = view;
  if (view === 'quarantine') await refreshQuarantine();
  if (view === 'history') state.history = await api.history.list();
  render();
  viewEl.focus();
}

// ---------- Actions ----------

async function cleanCache() {
  const selected = state.cache!.filter((t) => state.cacheSel.has(t.id));
  const total = selected.reduce((s, t) => s + t.bytes, 0);
  const ok = await modal({
    title: `Očistiti ${fmt(total)} cache-a?`,
    body: `<p>Keš fajlovi se brišu trajno. Windows i programi ih po potrebi ponovo kreiraju, pa ne idu u karantin.</p>
           <ul>${selected.map((t) => `<li>${esc(t.label)}: ${fmt(t.bytes)}</li>`).join('')}</ul>
           <p class="muted">Fajlovi koji su trenutno u upotrebi biće preskočeni.</p>`,
    confirm: 'Očisti',
  });
  if (!ok) return;

  state.busy = true;
  viewEl.innerHTML = `${head('Windows cache', 'Čistim…')}<div class="scanning"><div class="radar"></div>Brišem keš fajlove…</div>`;
  let report: CleanReport | null = null;
  try {
    report = await api.cache.clean([...state.cacheSel]);
  } catch (err) {
    toast('Čišćenje nije uspjelo: ' + (err as Error).message, true);
  }
  state.busy = false;
  if (report) await showCleanReport(report);
  await Promise.all([refreshInfo(), scanCache()]);
}

async function showCleanReport(r: CleanReport) {
  const reasons: Record<string, number> = {};
  for (const t of r.targets) for (const [k, v] of Object.entries(t.skipReasons)) reasons[k] = (reasons[k] ?? 0) + v;
  const reasonList = Object.entries(reasons)
    .map(([k, v]) => `<li>${esc(k)}: ${v}</li>`)
    .join('');
  await modal({
    title: `Oslobođeno ${fmt(r.bytes)}`,
    body: `<p>Obrisano <b>${r.deleted}</b> fajlova.${r.skipped ? ` Preskočeno <b>${r.skipped}</b>:` : ''}</p>
           ${reasonList ? `<ul>${reasonList}</ul>` : ''}`,
    confirm: 'Gotovo',
    cancel: null,
  });
}

async function quarantineAction(kind: 'restore' | 'remove') {
  const ids = [...state.qSel];
  const items = state.quarantine.filter((q) => state.qSel.has(q.id));
  if (kind === 'remove') {
    const ok = await modal({
      title: `Trajno obrisati ${items.length} stavki?`,
      body: `<p>Ovo je <b>nepovratno</b>. ${fmt(items.reduce((s, q) => s + q.bytes, 0))} će biti oslobođeno odmah.</p>`,
      confirm: 'Trajno obriši',
      kind: 'red',
    });
    if (!ok) return;
  }
  let r: OpResult;
  try {
    r = kind === 'restore' ? await api.quarantine.restore(ids) : await api.quarantine.remove(ids);
  } catch (err) {
    toast((err as Error).message, true);
    return;
  }
  const renamed = r.done.filter((d) => d.restoredTo && d.restoredTo !== d.path);
  if (r.failed.length || renamed.length) {
    await modal({
      title: kind === 'restore' ? `Vraćeno ${r.done.length} od ${ids.length}` : `Obrisano ${r.done.length} od ${ids.length}`,
      body: `${renamed.length ? `<p>Originalna putanja je zauzeta, pa je vraćeno pod novim imenom:</p><ul>${renamed.map((d) => `<li class="mono selectable">${esc(d.restoredTo!)}</li>`).join('')}</ul>` : ''}${failureList(r.failed)}`,
      confirm: 'U redu',
      cancel: null,
    });
  } else {
    toast(kind === 'restore' ? `✓ Vraćeno ${r.done.length} stavki` : `✓ Trajno obrisano ${fmt(r.bytes)}`);
  }
  state.qSel.clear();
  await Promise.all([refreshQuarantine(), refreshInfo()]);
  render();
}

// ---------- Events (delegated) ----------

document.getElementById('nav')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
  if (b && !state.busy) void go(b.dataset.view as View);
});

viewEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const goBtn = t.closest<HTMLElement>('[data-go]');
  if (goBtn) return void go(goBtn.dataset.go as View);
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!act || state.busy) return;
  if (act === 'scan') void scanCache();
  if (act === 'scan-go') void go('cache').then(scanCache);
  if (act === 'clean') void cleanCache();
  if (act === 'q-restore') void quarantineAction('restore');
  if (act === 'q-remove') void quarantineAction('remove');
});

viewEl.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const setFor = input.dataset.cache ? state.cacheSel : input.dataset.q ? state.qSel : null;
  const id = input.dataset.cache ?? input.dataset.q;
  if (!setFor || !id) return;
  if (input.checked) setFor.add(id);
  else setFor.delete(id);
  render();
});

// ---------- Boot ----------

(async () => {
  render();
  await Promise.all([refreshInfo(), refreshQuarantine()]);
  render();
})();
