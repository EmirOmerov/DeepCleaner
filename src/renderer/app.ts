import type {
  CleanReport,
  DeepCleanerApi,
  FileCategory,
  HistoryEntry,
  InstalledProgram,
  LargeFile,
  Leftover,
  OpResult,
  QuarantineItem,
  SystemInfo,
  TargetScan,
  UninstallOutcome,
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
  lf: {
    roots: [] as string[],
    minBytes: 500 * 1024 ** 2,
    files: null as LargeFile[] | null,
    scanning: false,
    progress: { scannedFiles: 0, found: 0 },
    sel: new Set<string>(),
    cats: new Set<FileCategory>(),
    olderThanDays: 0,
  },
  prog: {
    list: null as InstalledProgram[] | null,
    loading: false,
    query: '',
    sort: 'name' as 'name' | 'size' | 'date',
    wizard: null as Wizard | null,
  },
};

type WizardStep = 'confirm' | 'running' | 'still' | 'scanning' | 'leftovers' | 'done';
interface Wizard {
  program: InstalledProgram;
  step: WizardStep;
  outcome?: UninstallOutcome;
  leftovers: Leftover[];
  sel: Set<string>;
  result?: OpResult;
  error?: string;
}

const CATEGORY: Record<FileCategory, [label: string, color: string]> = {
  video: ['Video', '#ff3dbb'],
  'disk-image': ['ISO / diskovi', '#22e3ff'],
  archive: ['Arhive', '#7b8cff'],
  installer: ['Instalacije', '#ffb547'],
  document: ['Dokumenti', '#8cff6b'],
  image: ['Slike', '#ff8a5c'],
  audio: ['Audio', '#c38bff'],
  other: ['Ostalo', '#6f7fa8'],
};
const MIN_SIZES = [100, 500, 1024, 5120].map((mb) => mb * 1024 ** 2);
const DAY_MS = 86_400_000;

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
        <button class="panel mod" data-go="largefiles">
          <div class="t">Veliki fajlovi <span>${state.lf.files ? `${state.lf.files.length} fajlova` : 'nije skenirano'}</span></div>
          <b>${state.lf.files ? fmt(state.lf.files.reduce((s, f) => s + f.size, 0)) : '—'}</b>
          <span class="muted">Najveći fajlovi na svim diskovima</span>
        </button>
        <button class="panel mod" data-go="quarantine">
          <div class="t">Karantin <span>30 dana</span></div>
          <b>${fmt(qBytes)}</b>
          <span class="muted">${state.quarantine.length} stavki se može vratiti</span>
        </button>
        <button class="panel mod" data-go="programs">
          <div class="t">Programi <span>${state.prog.list ? `${state.prog.list.length} instalirano` : 'duboka deinstalacija'}</span></div>
          <b>${state.prog.list ? fmt(state.prog.list.reduce((s, p) => s + p.sizeBytes, 0)) : '—'}</b>
          <span class="muted">Deinstalacija + uklanjanje ostataka</span>
        </button>
        <div class="panel mod soon"><div class="t">Slike <span>uskoro</span></div><b>U izradi</b><span class="muted">Sljedeći modul</span></div>
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
          <span class="chips"><span class="chip mag">${esc(MODULE_LABEL[q.module] ?? q.module)}</span>${q.kind === 'registry' ? '<span class="chip">Registar</span>' : ''}</span>
          <span class="num">${q.kind === 'registry' ? '.reg' : fmt(q.bytes)}</span>
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

function visibleLargeFiles(): LargeFile[] {
  const { files, cats, olderThanDays } = state.lf;
  if (!files) return [];
  const cutoff = Date.now() - olderThanDays * DAY_MS;
  return files.filter((f) => (!cats.size || cats.has(f.category)) && (!olderThanDays || f.mtimeMs < cutoff));
}

function ageLabel(mtimeMs: number) {
  const days = Math.floor((Date.now() - mtimeMs) / DAY_MS);
  if (days < 1) return 'danas';
  if (days < 30) return `prije ${days} d`;
  if (days < 365) return `prije ${Math.floor(days / 30)} mj.`;
  return `prije ${(days / 365).toFixed(1)} god.`;
}

function renderLargeFiles() {
  const lf = state.lf;
  const rootChips = lf.roots
    .map((r) => `<span class="chip cyan mono">${esc(r)} <button class="x" data-lf-root="${esc(r)}" aria-label="Ukloni ${esc(r)}">×</button></span>`)
    .join('');
  const sizeChips = MIN_SIZES.map(
    (b) => `<button class="chip ${lf.minBytes === b ? 'cyan' : ''}" data-lf-min="${b}">&gt; ${fmt(b)}</button>`,
  ).join('');
  const setup = `
    <div class="panel lf-setup">
      <div class="row"><span class="lbl">Lokacije</span><div class="chips">${rootChips}<button class="chip" data-act="lf-add">+ Dodaj folder</button></div></div>
      <div class="row"><span class="lbl">Veće od</span><div class="chips">${sizeChips}</div></div>
    </div>`;

  const title = head('Veliki fajlovi', 'Vidi gdje <span class="grad">nestaje prostor</span>',
    lf.scanning
      ? '<button class="btn ghost" data-act="lf-cancel">Otkaži</button>'
      : `<button class="btn primary" data-act="lf-scan" ${lf.roots.length ? '' : 'disabled'}>${lf.files ? 'Skeniraj ponovo' : 'Skeniraj'}</button>`);

  if (lf.scanning) {
    return `${title}${setup}<div class="scanning"><div class="radar"></div>
      <span>Pregledano <b class="mono" id="lf-count">${lf.progress.scannedFiles.toLocaleString('bs')}</b> fajlova · pronađeno <b class="mono" id="lf-found">${lf.progress.found}</b></span></div>`;
  }
  if (!lf.files) {
    return `${title}${setup}<div class="empty"><h2>Još nije skenirano</h2><p>Skeniranje samo čita veličine. Windows, Program Files i AppData se preskaču.</p></div>`;
  }
  if (!lf.files.length) {
    return `${title}${setup}<div class="empty"><h2>Nema fajlova većih od ${fmt(lf.minBytes)}</h2><p>Probaj manji prag ili dodaj drugi folder.</p></div>`;
  }

  // Category filter chips with totals
  const totals = new Map<FileCategory, number>();
  for (const f of lf.files) totals.set(f.category, (totals.get(f.category) ?? 0) + f.size);
  const catChips = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, bytes]) => `<button class="chip ${lf.cats.has(c) ? 'cyan' : ''}" data-lf-cat="${c}"><i class="dot" style="background:${CATEGORY[c][1]}"></i>${CATEGORY[c][0]} · ${fmt(bytes)}</button>`)
    .join('');
  const ageChips = [[0, 'Bilo kada'], [180, 'Starije od 6 mj.'], [365, 'Starije od 1 god.']]
    .map(([d, l]) => `<button class="chip ${lf.olderThanDays === d ? 'cyan' : ''}" data-lf-age="${d}">${l}</button>`)
    .join('');

  const visible = visibleLargeFiles();
  const visTotal = visible.reduce((s, f) => s + f.size, 0) || 1;
  const tiles = visible
    .slice(0, 14)
    .map((f) => {
      const name = f.path.split('\\').pop()!;
      const sel = lf.sel.has(f.path) ? 'sel' : '';
      return `<button class="tile ${sel} ${f.locked ? 'locked' : ''}" data-lf-tile="${esc(f.path)}" title="${esc(f.path)}"
        style="flex-grow:${Math.max(1, Math.round((f.size / visTotal) * 1000))};--c:${CATEGORY[f.category][1]}">
        <b class="mono">${fmt(f.size)}</b><span>${esc(name)}</span></button>`;
    })
    .join('');

  const rows = visible
    .map((f) => {
      const name = f.path.split('\\').pop()!;
      const folder = f.path.slice(0, f.path.length - name.length - 1);
      const checked = lf.sel.has(f.path) ? 'checked' : '';
      return `
        <label class="tr ${checked ? 'sel' : ''}">
          <input type="checkbox" class="cb" data-lf="${esc(f.path)}" ${checked} ${f.locked ? 'disabled' : ''}>
          <span class="name"><b class="selectable">${esc(name)}</b><small class="mono selectable" title="${esc(folder)}">${esc(folder)} · ${ageLabel(f.mtimeMs)}</small></span>
          <span class="chips">${f.locked ? '<span class="chip warn">U upotrebi</span>' : ''}<span class="chip"><i class="dot" style="background:${CATEGORY[f.category][1]}"></i>${CATEGORY[f.category][0]}</span></span>
          <span class="num">${fmt(f.size)}</span>
          <button class="btn ghost sm" data-lf-reveal="${esc(f.path)}" title="Otvori lokaciju">📂</button>
        </label>`;
    })
    .join('');

  const selected = visible.filter((f) => lf.sel.has(f.path));
  const selBytes = selected.reduce((s, f) => s + f.size, 0);
  return `${title}${setup}
    <div class="filters"><div class="chips">${catChips}</div><div class="chips">${ageChips}</div></div>
    <div class="treemap" aria-label="Najveći fajlovi">${tiles}</div>
    <div class="tbl t-lf">
      <div class="tr head"><span></span><span>Fajl · ${visible.length}</span><span></span><span class="num">Veličina</span><span></span></div>
      ${rows || '<div class="empty">Nijedan fajl ne odgovara filterima.</div>'}
    </div>
    <div class="action-bar">
      <span class="sum muted">${selected.length} odabrano · <b>${fmt(selBytes)}</b></span>
      <div class="btns">
        <button class="btn red" data-act="lf-delete" ${selected.length ? '' : 'disabled'}>Trajno obriši</button>
        <button class="btn danger" data-act="lf-quarantine" ${selected.length ? '' : 'disabled'}>U karantin</button>
      </div>
    </div>`;
}

async function scanLargeFiles() {
  const lf = state.lf;
  lf.scanning = true;
  lf.progress = { scannedFiles: 0, found: 0 };
  render();
  const off = api.largeFiles.onProgress((p) => {
    lf.progress = p;
    // Update counters in place instead of re-rendering the whole view.
    const c = document.getElementById('lf-count');
    const f = document.getElementById('lf-found');
    if (c) c.textContent = p.scannedFiles.toLocaleString('bs');
    if (f) f.textContent = String(p.found);
  });
  try {
    lf.files = await api.largeFiles.scan(lf.roots, lf.minBytes);
    lf.sel.clear();
  } catch (err) {
    toast('Skeniranje nije uspjelo: ' + (err as Error).message, true);
  } finally {
    off();
    lf.scanning = false;
    render();
  }
}

async function removeLargeFiles(permanent: boolean) {
  const selected = visibleLargeFiles().filter((f) => state.lf.sel.has(f.path));
  const bytes = selected.reduce((s, f) => s + f.size, 0);
  const list = `<ul>${selected.slice(0, 6).map((f) => `<li class="mono">${esc(f.path.split('\\').pop()!)}: ${fmt(f.size)}</li>`).join('')}${selected.length > 6 ? `<li>… i još ${selected.length - 6}</li>` : ''}</ul>`;
  const ok = await modal(
    permanent
      ? { title: `Trajno obrisati ${selected.length} fajlova?`, body: `<p>Ovo je <b>nepovratno</b>. ${fmt(bytes)} se oslobađa odmah.</p>${list}`, confirm: 'Trajno obriši', kind: 'red' }
      : { title: `Premjestiti ${selected.length} fajlova u karantin?`, body: `<p>Fajlovi se čuvaju 30 dana i mogu se vratiti iz Karantina.</p>${list}<p class="muted">Napomena: prostor se oslobađa tek kad se karantin isprazni ili istekne.</p>`, confirm: 'U karantin', kind: 'danger' },
  );
  if (!ok) return;
  const paths = selected.map((f) => f.path);
  let r: OpResult;
  try {
    r = permanent ? await api.largeFiles.deletePermanently(paths) : await api.largeFiles.quarantine(paths);
  } catch (err) {
    toast((err as Error).message, true);
    return;
  }
  const gone = new Set(r.done.map((d) => d.path.toLowerCase()));
  state.lf.files = state.lf.files!.filter((f) => !gone.has(f.path.toLowerCase()));
  state.lf.sel.clear();
  if (r.failed.length) {
    await modal({ title: `Uklonjeno ${r.done.length} od ${paths.length}`, body: failureList(r.failed), confirm: 'U redu', cancel: null });
  } else {
    toast(permanent ? `✓ Trajno obrisano ${fmt(r.bytes)}` : `✓ ${r.done.length} fajlova u karantinu`);
  }
  await Promise.all([refreshQuarantine(), refreshInfo()]);
  render();
}

// ---------- Programs / deep uninstall ----------

const ICON_COLORS = ['#22e3ff', '#ff3dbb', '#8cff6b', '#ffb547', '#7b8cff', '#ff8a5c', '#c38bff', '#9aa7c9'];
const LEFTOVER_GROUPS: Array<[Leftover['kind'][], string]> = [
  [['folder', 'file'], 'Fajlovi i folderi'],
  [['shortcut'], 'Prečice'],
  [['registry'], 'Registar'],
];

function iconFor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const letters = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?';
  return `<span class="app-ico" style="background:${ICON_COLORS[h % ICON_COLORS.length]}">${esc(letters)}</span>`;
}

function sortedPrograms(): InstalledProgram[] {
  const { list, query, sort } = state.prog;
  const q = query.trim().toLowerCase();
  const filtered = (list ?? []).filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.publisher.toLowerCase().includes(q),
  );
  if (sort === 'size') return filtered.sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (sort === 'date') return filtered.sort((a, b) => (b.installDate ?? '').localeCompare(a.installDate ?? ''));
  return filtered;
}

function programRows(): string {
  const rows = sortedPrograms()
    .map((p) => `
      <div class="tr">
        ${iconFor(p.name)}
        <span class="name"><b>${esc(p.name)}</b><small>${esc(p.publisher || 'Nepoznat izdavač')}${p.version ? ' · ' + esc(p.version) : ''}</small></span>
        <span class="chips"><span class="chip ${p.scope === 'machine' ? '' : 'cyan'}">${p.scope === 'machine' ? 'Svi korisnici' : 'Samo ti'}</span>${p.isMsi ? '<span class="chip">MSI</span>' : ''}</span>
        <span class="num muted">${p.installDate ? p.installDate.split('-').reverse().join('.') : '—'}</span>
        <span class="num">${p.sizeBytes ? fmt(p.sizeBytes) : '—'}</span>
        <button class="btn danger sm" data-prog-uninstall="${esc(p.id)}">Duboko ukloni</button>
      </div>`)
    .join('');
  return rows || '<div class="empty">Nijedan program ne odgovara pretrazi.</div>';
}

function renderPrograms() {
  const pr = state.prog;
  if (pr.wizard) return renderWizard(pr.wizard);
  const title = head('Programi', 'Pronađi šta ti <span class="grad">više ne treba</span>',
    `<button class="btn ghost" data-act="prog-refresh" ${pr.loading ? 'disabled' : ''}>Osvježi</button>`);
  if (pr.loading || !pr.list) {
    return `${title}<div class="scanning"><div class="radar"></div>Čitam listu instaliranih programa…</div>`;
  }
  const sortChips = ([['name', 'Ime'], ['size', 'Veličina'], ['date', 'Datum instalacije']] as const)
    .map(([k, l]) => `<button class="chip ${pr.sort === k ? 'cyan' : ''}" data-prog-sort="${k}">${l}</button>`)
    .join('');
  const total = pr.list.reduce((s, p) => s + p.sizeBytes, 0);
  return `${title}
    <div class="toolbar">
      <input class="search" type="search" placeholder="⌕ Pretraži programe ili izdavače…" value="${esc(pr.query)}" data-prog-search>
      <div class="chips">${sortChips}</div>
      <span class="muted">${pr.list.length} programa · ${fmt(total)}</span>
    </div>
    <div class="tbl t-prog">
      <div class="tr head"><span></span><span>Program</span><span></span><span class="num">Instaliran</span><span class="num">Veličina</span><span></span></div>
      <div id="prog-rows">${programRows()}</div>
    </div>`;
}

function renderWizard(w: Wizard) {
  const p = w.program;
  const busy = w.step === 'running' || w.step === 'scanning';
  const stepIdx = { confirm: 0, running: 0, still: 0, scanning: 1, leftovers: 1, done: 2 }[w.step];
  const steps = ['Standardna deinstalacija', 'Ostaci', 'Uklanjanje']
    .map((s, i) => `<div class="${i < stepIdx || w.step === 'done' ? 'done' : i === stepIdx ? 'now' : ''}">${i < stepIdx || w.step === 'done' ? '✓' : i + 1} · ${s}</div>`)
    .join('');
  const title = head('Duboka deinstalacija', esc(p.name), busy ? '' : '<button class="btn ghost" data-act="wiz-back">← Nazad</button>');
  const needsUac = p.scope === 'machine' && !state.info?.isAdmin;

  let body = '';
  if (w.step === 'confirm') {
    body = `<div class="panel wiz-panel">
      <h2>Kako ovo radi</h2>
      <ol>
        <li>Pokreće se <b>originalni uninstaller</b> programa. Prati njegove korake.</li>
        <li>Kad završi, DeepCleaner traži <b>ostatke</b>: foldere, prečice i ključeve registra.</li>
        <li>Ti biraš šta se uklanja. Sve ide u <b>karantin</b>, a registar dobija .reg backup.</li>
      </ol>
      ${needsUac ? '<p class="banner-inline">⚠ Program je instaliran za sve korisnike, pa će Windows tražiti dozvolu (UAC).</p>' : ''}
      <div class="btns"><button class="btn danger" data-act="wiz-run">Pokreni deinstalaciju</button></div>
    </div>`;
  } else if (w.step === 'running') {
    body = '<div class="scanning"><div class="radar"></div>Čekam da se deinstalacija završi… Prati prozor uninstallera.</div>';
  } else if (w.step === 'still') {
    const o = w.outcome;
    const why = o?.cancelled
      ? 'Deinstalacija je otkazana (UAC dozvola nije data).'
      : o?.error
        ? `Uninstaller je javio grešku: <span class="mono">${esc(o.error)}</span>`
        : 'Program je još uvijek instaliran. Neki uninstalleri završavaju tek kad zatvoriš njihov prozor ili nakon restarta.';
    body = `<div class="panel wiz-panel warn">
      <h2>Program nije uklonjen</h2><p>${why}</p>
      <p class="muted">Ostaci se ne traže dok je program instaliran. Tako se ništa ne briše programu koji još radi.</p>
      <div class="btns"><button class="btn ghost" data-act="wiz-recheck">Provjeri ponovo</button><button class="btn danger" data-act="wiz-run">Pokreni ponovo</button></div>
    </div>`;
  } else if (w.step === 'scanning') {
    body = '<div class="scanning"><div class="radar"></div>Tražim ostatke u Program Files, AppData, Start meniju i registru…</div>';
  } else if (w.step === 'leftovers') {
    if (!w.leftovers.length) {
      body = `<div class="empty"><h2>Nema ostataka</h2><p>${esc(p.name)} je čisto uklonjen.</p><br><button class="btn primary" data-act="wiz-done">Gotovo</button></div>`;
    } else {
      const groups = LEFTOVER_GROUPS.map(([kinds, label]) => {
        const items = w.leftovers.filter((l) => kinds.includes(l.kind));
        if (!items.length) return '';
        const total = kinds.includes('registry')
          ? `${items.length} ${items.length === 1 ? 'ključ' : 'ključeva'}`
          : fmt(items.reduce((s, l) => s + l.bytes, 0));
        return `<div class="tr grp"><span></span><span>${label}</span><span></span><span class="num">${total}</span></div>` +
          items.map((l) => {
            const checked = w.sel.has(l.path) ? 'checked' : '';
            return `<label class="tr ${checked ? 'sel' : ''}">
              <input type="checkbox" class="cb" data-left="${esc(l.path)}" ${checked}>
              <span class="name"><b class="mono selectable">${esc(l.path)}</b><small>${esc(l.reason)}</small></span>
              <span><span class="chip ${l.risk === 'safe' ? 'safe' : 'warn'}">${l.risk === 'safe' ? 'Sigurno' : 'Provjeri'}</span></span>
              <span class="num">${l.kind === 'registry' ? '—' : fmt(l.bytes)}</span>
            </label>`;
          }).join('');
      }).join('');
      const sel = w.leftovers.filter((l) => w.sel.has(l.path));
      body = `<div class="tbl t-left">${groups}</div>
        <p class="muted hint">„Sigurno“ je unaprijed označeno. „Provjeri“ označi samo ako si siguran da pripada ovom programu.</p>
        <div class="action-bar">
          <span class="sum muted">${sel.length} odabrano · <b>${fmt(sel.reduce((s, l) => s + l.bytes, 0))}</b></span>
          <div class="btns"><button class="btn ghost" data-act="wiz-done">Preskoči</button><button class="btn danger" data-act="wiz-remove" ${sel.length ? '' : 'disabled'}>Ukloni ostatke</button></div>
        </div>`;
    }
  } else if (w.step === 'done') {
    const r = w.result!;
    body = `<div class="panel wiz-panel">
      <h2>${esc(p.name)} je uklonjen</h2>
      <p>Uklonjeno <b>${r.done.length}</b> ostataka (${fmt(r.bytes)}). Sve je u karantinu 30 dana, a ključevi registra imaju .reg backup.</p>
      ${failureList(r.failed)}
      <div class="btns"><button class="btn ghost" data-go="quarantine">Otvori karantin</button><button class="btn primary" data-act="wiz-done">Gotovo</button></div>
    </div>`;
  }
  if (w.error) body = `<div class="banner"><span>⚠</span><span>${esc(w.error)}</span></div>` + body;
  return `${title}<div class="stepper">${steps}</div>${body}`;
}

async function loadPrograms() {
  state.prog.loading = true;
  render();
  try {
    state.prog.list = await api.programs.list();
  } catch (err) {
    toast((err as Error).message, true);
  } finally {
    state.prog.loading = false;
    render();
  }
}

function setWizard(patch: Partial<Wizard>) {
  Object.assign(state.prog.wizard!, patch);
  render();
}

async function runUninstall() {
  const w = state.prog.wizard!;
  state.busy = true;
  setWizard({ step: 'running', error: undefined });
  try {
    const outcome = await api.programs.uninstall(w.program.id);
    if (outcome.stillInstalled) setWizard({ step: 'still', outcome });
    else await findProgramLeftovers();
  } catch (err) {
    setWizard({ step: 'confirm', error: (err as Error).message });
  } finally {
    state.busy = false;
    render();
  }
}

async function recheckInstalled() {
  const w = state.prog.wizard!;
  if (await api.programs.isInstalled(w.program.id)) return toast('Program je i dalje instaliran.', true);
  await findProgramLeftovers();
}

async function findProgramLeftovers() {
  const w = state.prog.wizard!;
  state.busy = true;
  setWizard({ step: 'scanning' });
  try {
    const leftovers = await api.programs.leftovers(w.program.id);
    setWizard({ step: 'leftovers', leftovers, sel: new Set(leftovers.filter((l) => l.risk === 'safe').map((l) => l.path)) });
  } catch (err) {
    setWizard({ step: 'still', error: (err as Error).message });
  } finally {
    state.busy = false;
    render();
  }
}

async function removeProgramLeftovers() {
  const w = state.prog.wizard!;
  const sel = w.leftovers.filter((l) => w.sel.has(l.path));
  const ok = await modal({
    title: `Ukloniti ${sel.length} ostataka?`,
    body: `<p>Fajlovi i folderi idu u karantin (30 dana). Ključevi registra se prvo izvezu u .reg backup.</p>
      <ul>${sel.slice(0, 8).map((l) => `<li class="mono">${esc(l.path)}</li>`).join('')}${sel.length > 8 ? `<li>… i još ${sel.length - 8}</li>` : ''}</ul>`,
    confirm: 'Ukloni',
    kind: 'danger',
  });
  if (!ok) return;
  state.busy = true;
  try {
    const result = await api.programs.removeLeftovers(w.program.id, sel.map((l) => l.path));
    setWizard({ step: 'done', result });
  } catch (err) {
    toast((err as Error).message, true);
  } finally {
    state.busy = false;
    await refreshQuarantine();
    render();
  }
}

async function finishWizard() {
  state.prog.wizard = null;
  await loadPrograms();
}

const SOON: Record<string, [string, string]> = {
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
    programs: renderPrograms,
    largefiles: renderLargeFiles,
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
  if (view === 'programs' && !state.prog.list && !state.prog.loading) await loadPrograms();
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

/** Large-files controls that just tweak state and re-render. */
function handleLargeFilesClick(t: HTMLElement, e: Event): boolean {
  const lf = state.lf;
  const el = t.closest<HTMLElement>('[data-lf-root],[data-lf-min],[data-lf-cat],[data-lf-age],[data-lf-tile],[data-lf-reveal]');
  if (!el) return false;
  const d = el.dataset;
  if (d.lfReveal) {
    e.preventDefault(); // don't toggle the row checkbox
    void api.largeFiles.reveal(d.lfReveal);
    return true;
  }
  if (lf.scanning) return true;
  if (d.lfRoot) lf.roots = lf.roots.filter((r) => r !== d.lfRoot);
  else if (d.lfMin) lf.minBytes = Number(d.lfMin);
  else if (d.lfCat) {
    const c = d.lfCat as FileCategory;
    if (lf.cats.has(c)) lf.cats.delete(c);
    else lf.cats.add(c);
  } else if (d.lfAge) lf.olderThanDays = Number(d.lfAge);
  else if (d.lfTile) {
    const f = lf.files?.find((x) => x.path === d.lfTile);
    if (f && !f.locked) {
      if (lf.sel.has(f.path)) lf.sel.delete(f.path);
      else lf.sel.add(f.path);
    }
  }
  render();
  return true;
}

viewEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const goBtn = t.closest<HTMLElement>('[data-go]');
  if (goBtn) return void go(goBtn.dataset.go as View);
  if (handleLargeFilesClick(t, e)) return;

  const uninstallBtn = t.closest<HTMLElement>('[data-prog-uninstall]');
  if (uninstallBtn && !state.busy) {
    const program = state.prog.list?.find((p) => p.id === uninstallBtn.dataset.progUninstall);
    if (program) state.prog.wizard = { program, step: 'confirm', leftovers: [], sel: new Set() };
    return render();
  }
  const sortBtn = t.closest<HTMLElement>('[data-prog-sort]');
  if (sortBtn) {
    state.prog.sort = sortBtn.dataset.progSort as typeof state.prog.sort;
    return render();
  }

  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'lf-cancel') return void api.largeFiles.cancel();
  if (!act || state.busy || state.lf.scanning) return;
  if (act === 'lf-scan') void scanLargeFiles();
  if (act === 'lf-add') {
    void api.largeFiles.pickFolder().then((p) => {
      if (p && !state.lf.roots.some((r) => r.toLowerCase() === p.toLowerCase())) state.lf.roots.push(p);
      render();
    });
  }
  if (act === 'lf-quarantine') void removeLargeFiles(false);
  if (act === 'lf-delete') void removeLargeFiles(true);
  if (act === 'prog-refresh') void loadPrograms();
  if (act === 'wiz-back') {
    state.prog.wizard = null;
    render();
  }
  if (act === 'wiz-run') void runUninstall();
  if (act === 'wiz-recheck') void recheckInstalled();
  if (act === 'wiz-remove') void removeProgramLeftovers();
  if (act === 'wiz-done') void finishWizard();
  if (act === 'scan') void scanCache();
  if (act === 'scan-go') void go('cache').then(scanCache);
  if (act === 'clean') void cleanCache();
  if (act === 'q-restore') void quarantineAction('restore');
  if (act === 'q-remove') void quarantineAction('remove');
});

viewEl.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const d = input.dataset;
  const wiz = state.prog.wizard;
  const setFor = d.cache ? state.cacheSel : d.q ? state.qSel : d.lf ? state.lf.sel : d.left && wiz ? wiz.sel : null;
  const id = d.cache ?? d.q ?? d.lf ?? d.left;
  if (!setFor || !id) return;
  if (input.checked) setFor.add(id);
  else setFor.delete(id);
  render();
});

// Search filters rows in place so the input keeps focus while typing.
viewEl.addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.dataset.progSearch === undefined) return;
  state.prog.query = input.value;
  const rows = document.getElementById('prog-rows');
  if (rows) rows.innerHTML = programRows();
});

// ---------- Boot ----------

(async () => {
  render();
  const [roots] = await Promise.all([api.largeFiles.defaultRoots(), refreshInfo(), refreshQuarantine()]);
  state.lf.roots = roots;
  render();
})();
