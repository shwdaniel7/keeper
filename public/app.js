import { spring, project, rubberband, reduced } from './spring.js';
import { qrSvg } from './qr.js';

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]));
// Template que escapa tudo por padrão; só Raw (resultado de outro html``) passa sem escape.
const html = (s, ...v) => new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? val(v[i]) : ''), ''));
const strip = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const todayStr = () => new Date().toLocaleDateString('sv');
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv'); };
const days = (d) => Math.round((Date.parse(d) - Date.parse(todayStr())) / 864e5);
const fmt = (d) => (d ? d.split('-').reverse().join('/') : '—');
const fmtTs = (ts) => new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const eqName = (e) => [e.marca, e.modelo].filter(Boolean).join(' ');
const ESTADO = { disponivel: 'Disponível', emprestado: 'Emprestado', manutencao: 'Em manutenção', baixado: 'Baixado' };
const TICKET = { aberto: 'Aberto', em_reparo: 'Em reparo', resolvido: 'Resolvido' };
const badge = (s, label) => html`<span class="badge s-${s}">${label}</span>`;
const tag = (c, big) => html`<span class="tag ${big ? 'lg' : ''}">${c}</span>`;
const uniq = (a) => [...new Set(a.filter(Boolean))].sort();

async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  // Sessão expirada: volta ao login. Login/setup respondem 401 para senha errada, não para sessão perdida.
  if (r.status === 401 && !/^\/(login|setup)/.test(path)) {
    sessaoPerdida();
    throw Object.assign(new Error('Sessão expirada'), { silent: true });
  }
  if (!r.ok) throw Object.assign(new Error(data?.error || r.statusText), { campo: data?.campo });
  return data;
}
const falha = (e) => { if (!e.silent) toast(e.message, null, true); };

/* ---------- toast com desfazer (e atalho opcional) ---------- */
const toastEl = $('#toast');
let toastTimer;
function toast(msg, undo, err, link) {
  clearTimeout(toastTimer);
  toastEl.className = 'toast on' + (err ? ' err' : '');
  toastEl.innerHTML = html`<span>${msg}</span>${link ? html`<a class="btn sm" href="${link.href}">${link.label}</a>` : ''}${undo ? html`<button class="btn sm primary" data-act="undo">Desfazer</button>` : ''}`.s;
  toastEl.undo = undo;
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), err ? 6000 : 7000);
}

/* ---------- sheet: arrastável, interrompível, com projeção de momentum ---------- */
const layer = $('#layer'), sheetEl = $('#sheet'), scrim = $('#scrim');
let sx = 0, W = 0, anim = null, isOpen = false, opener = null, drag = null;

function setX(x) {
  sx = x;
  sheetEl.style.transform = `translate3d(${x}px,0,0)`;
  scrim.style.opacity = Math.max(0, Math.min(1, 1 - x / W));
}
function moveTo(target, velocity = 0) {
  anim?.stop();
  if (reduced()) { setX(0); if (target) finishClose(); return; }
  const flick = Math.abs(velocity) > 500; // só quica quando o gesto trouxe momentum
  anim = spring({ from: sx, to: target, velocity, response: 0.35, damping: flick ? 0.85 : 1, onUpdate: setX, onDone: () => target && finishClose() });
}
function openSheet(content) {
  sheetEl.innerHTML = content.s;
  if (!isOpen) {
    isOpen = true;
    opener = document.activeElement;
    layer.dataset.open = '1';
    W = sheetEl.offsetWidth + 24;
    $('#app').inert = true;
    setX(reduced() ? 0 : W);
    moveTo(0);
  }
  (sheetEl.querySelector('[autofocus]') || sheetEl.querySelector('[data-act=close]'))?.focus({ preventScroll: true });
}
function closeSheet() {
  if (isOpen) moveTo(W);
}
function finishClose() {
  isOpen = false;
  delete layer.dataset.open;
  sheetEl.innerHTML = '';
  $('#app').inert = false;
  if (opener?.isConnected) opener.focus({ preventScroll: true });
}

sheetEl.addEventListener('pointerdown', (e) => {
  if (!isOpen || reduced() || !e.target.closest('[data-grab]') || e.target.closest('button,input,select,textarea,a')) return;
  anim?.stop(); // interrompe: segue o dedo a partir do valor atual na tela
  sheetEl.setPointerCapture(e.pointerId);
  drag = { off: e.clientX - sx, pts: [[e.timeStamp, e.clientX]] };
});
sheetEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const x = e.clientX - drag.off;
  setX(x < 0 ? -rubberband(-x, W) : x);
  drag.pts.push([e.timeStamp, e.clientX]);
  while (drag.pts.length > 2 && e.timeStamp - drag.pts[0][0] > 100) drag.pts.shift();
});
const endDrag = () => {
  if (!drag) return;
  const [a, b] = [drag.pts[0], drag.pts.at(-1)];
  const v = b[0] > a[0] ? ((b[1] - a[1]) / (b[0] - a[0])) * 1000 : 0;
  drag = null;
  moveTo(sx + project(v) > W / 2 ? W : 0, v);
};
sheetEl.addEventListener('pointerup', endDrag);
sheetEl.addEventListener('pointercancel', endDrag);

/* ---------- página e animações de entrada ---------- */
const main = $('#main');
let fresh = false; // true só quando a rota mudou: refrescar dados não reanima a tela
function page(title, actions, content) {
  main.innerHTML = html`<div class="page ${fresh ? 'enter' : ''}"><header class="bar"><h1>${title}</h1><div class="actions">${actions}</div></header>${content}</div>`.s;
  if (!fresh) return;
  fresh = false;
  const pg = main.firstElementChild;
  pg.querySelectorAll('.tile,.row,tbody tr').forEach((el, i) => el.style.setProperty('--i', Math.min(i, 12)));
  pg.querySelectorAll('.dist i').forEach((el, i) => el.style.setProperty('--i', i));
  setTimeout(() => pg.classList.remove('enter'), 1400);
  if (!reduced()) pg.querySelectorAll('.n[data-n]').forEach((el, i) => {
    const to = Number(el.dataset.n);
    el.textContent = '0';
    setTimeout(() => spring({ from: 0, to, response: 0.9, onUpdate: (v) => (el.textContent = Math.round(v)) }), 80 + i * 60);
  });
}
const head = (eyebrow, title) =>
  html`<div class="sheet-head" data-grab><div><p class="eyebrow">${eyebrow}</p><h2>${title}</h2></div><button class="btn icon" data-act="close" aria-label="Fechar">✕</button></div>`;
const body = (...c) => html`<div class="sheet-body">${c}</div>`;
const empty = (t) => html`<p class="empty">${t}</p>`;

// Indicador da navegação desliza com mola (re-alvo a partir da posição atual).
let pillY = null, pillAnim = null;
function movePill() {
  const a = $('[data-nav][aria-current]'), p = $('#pill');
  if (!a) return (p.style.opacity = 0);
  const y = a.offsetTop;
  p.style.height = a.offsetHeight + 'px';
  p.style.opacity = 1;
  const set = (v) => { pillY = v; p.style.transform = `translateY(${v}px)`; };
  pillAnim?.stop();
  if (pillY == null || reduced()) return set(y);
  pillAnim = spring({ from: pillY, to: y, response: 0.4, damping: 0.8, onUpdate: set });
}

/* ---------- views ---------- */
let eqs = [];
const inv = { q: '', estado: '', tipo: '' };
const sel = new Set(); // equipamentos marcados para empréstimo em lote

let ultimoPainel = null;
async function dashboard() {
  const d = await api('GET', '/dashboard');
  ultimoPainel = d;
  const total = Object.values(d.contagem).reduce((a, b) => a + b, 0);
  const row = (e, mid, right) => html`<div class="row" role="button" tabindex="0" data-act="ficha" data-id="${e.equipment_id ?? e.id}">
    <div class="grow"><div class="t">${tag(e.codigo)} ${eqName(e)}</div><div class="s">${mid}</div></div>${right}</div>`;
  page('Visão geral', html`<button class="btn" data-act="emprestar">Novo empréstimo</button><button class="btn primary" data-act="novo">Novo equipamento</button>`, html`
    <div class="tiles">${Object.entries(ESTADO).map(([k, l]) => html`<button class="tile card" data-act="filtro" data-id="${k}"><span class="n" data-n="${d.contagem[k]}">${d.contagem[k]}</span>${badge(k, l)}</button>`)}</div>
    ${total ? html`<div class="dist" role="img" aria-label="Distribuição do parque de ${total} equipamentos">${Object.keys(ESTADO).map((k) => html`<i class="s-${k} ${d.contagem[k] ? '' : 'zero'}" style="flex-grow:${d.contagem[k]}" title="${ESTADO[k]}: ${d.contagem[k]}"></i>`)}</div>` : ''}
    <h2 class="sec">Empréstimos atrasados <small>${d.atrasados.length}</small></h2>
    <div class="card list">${d.atrasados.length ? d.atrasados.map((l) => row(l, `${l.pessoa}${l.setor ? ' · ' + l.setor : ''} · previsto ${fmt(l.previsto_para)}`,
      html`<span class="late">${-days(l.previsto_para)} d</span><button class="btn sm" data-act="copiar-cobranca" data-id="${l.loan_id}">Copiar cobrança</button><button class="btn sm" data-act="renovar" data-id="${l.loan_id}">Renovar</button><button class="btn sm primary" data-act="devolver" data-id="${l.loan_id}">Devolver</button>`)) : empty('Nenhum atraso. Tudo em dia.')}</div>
    <h2 class="sec">Chamados abertos <small>${d.chamados.length}</small></h2>
    <div class="card list">${d.chamados.length ? d.chamados.map((c) => row(c, c.descricao, badge(c.status, TICKET[c.status]))) : empty('Nenhum chamado aberto.')}</div>`);
}

const matches = (e) => {
  const q = strip(inv.q);
  return (!inv.estado || e.estado === inv.estado) && (!inv.tipo || e.tipo === inv.tipo) &&
    (!q || strip([e.codigo, e.serial, e.marca, e.modelo, e.tipo, e.pessoa].join(' ')).includes(q));
};
const quick = (e) => e.estado === 'disponivel' ? html`<button class="btn sm" data-act="emprestar" data-id="${e.id}">Emprestar</button>`
  : e.estado === 'emprestado' ? html`<button class="btn sm primary" data-act="devolver" data-id="${e.loan_id}">Devolver</button>` : '';
const invRows = () => {
  const rows = eqs.filter(matches);
  return rows.length ? rows.map((e) => html`<tr role="button" tabindex="0" data-act="ficha" data-id="${e.id}">
    <td class="sel">${e.estado === 'disponivel' ? html`<input type="checkbox" data-sel="${e.id}" aria-label="Selecionar ${e.codigo}" ${sel.has(e.id) ? 'checked' : ''}>` : ''}</td>
    <td class="nowrap">${tag(e.codigo)}</td><td><div>${eqName(e)}</div><div class="sub">${e.pessoa ? 'com ' + e.pessoa : e.tipo}</div></td>
    <td class="sub" style="font-family:var(--mono)">${e.serial}</td>
    <td class="nowrap">${badge(e.estado, ESTADO[e.estado])} ${e.atrasado ? badge('atrasado', 'Atrasado') : ''}</td><td class="quick">${quick(e)}</td></tr>`)
    : html`<tr style="cursor:default"><td colspan="6" class="empty">${eqs.length ? 'Nada encontrado com esses filtros.' : 'Nenhum equipamento ainda. Cadastre um ou importe um CSV.'}</td></tr>`;
};
async function inventario() {
  eqs = await api('GET', '/equipment');
  page('Inventário', html`<button class="btn primary" id="lend-sel" data-act="emprestar-sel" hidden></button><a class="btn" href="/api/export/inventario.csv" download>Exportar</a><a class="btn" href="/api/export/historico.csv" download>Histórico</a><button class="btn primary" data-act="novo">Novo equipamento</button>`, html`
    <div class="toolbar">
      <input id="q" type="search" placeholder="Buscar por ID, serial, modelo ou pessoa…" aria-label="Buscar" value="${inv.q}" autocomplete="off">
      <select id="f-estado" aria-label="Estado"><option value="">Todos os estados</option>${Object.entries(ESTADO).map(([k, l]) => html`<option value="${k}" ${inv.estado === k ? 'selected' : ''}>${l}</option>`)}</select>
      <select id="f-tipo" aria-label="Tipo"><option value="">Todos os tipos</option>${uniq(eqs.map((e) => e.tipo)).map((t) => html`<option ${inv.tipo === t ? 'selected' : ''}>${t}</option>`)}</select>
    </div>
    <div class="card table-wrap"><table class="inv"><thead><tr><th class="sel"><input type="checkbox" data-selall aria-label="Selecionar todos os disponíveis visíveis"></th><th>ID</th><th>Equipamento</th><th>Serial</th><th>Estado</th><th></th></tr></thead><tbody id="inv-body">${invRows()}</tbody></table></div>`);
  updSel();
}
const refilter = () => { $('#inv-body').innerHTML = html`${invRows()}`.s; updSel(); };
function updSel() {
  const b = $('#lend-sel');
  if (!b) return;
  b.hidden = !sel.size;
  b.textContent = `Emprestar ${sel.size}`;
  const vis = eqs.filter((e) => matches(e) && e.estado === 'disponivel');
  $('[data-selall]').checked = vis.length > 0 && vis.every((e) => sel.has(e.id));
}

async function emprestimos() {
  const all = await api('GET', '/loans');
  const ativos = all.filter((l) => !l.devolvido_em);
  const hist = all.filter((l) => l.devolvido_em).slice(0, 15);
  // Itens emprestados juntos (mesma pessoa, setor e datas) aparecem como um grupo.
  const grupos = [...Map.groupBy(ativos, (l) => [l.pessoa, l.setor, l.retirado_em, l.previsto_para].join('|')).values()];
  const row = (l, right) => html`<div class="row" role="button" tabindex="0" data-act="ficha" data-id="${l.equipment_id}">
    <div class="grow"><div class="t">${tag(l.codigo)} ${eqName(l)}</div><div class="s">${l.pessoa}${l.setor ? ' · ' + l.setor : ''} · retirado ${fmt(l.retirado_em)}</div></div>${right}</div>`;
  const prazo = (l) => (l.atrasado ? badge('atrasado', `Atrasado ${-days(l.previsto_para)} d`) : html`<span class="sub">até ${fmt(l.previsto_para)}</span>`);
  const devolver = (l) => html`<button class="btn sm primary" data-act="devolver" data-id="${l.id}">Devolver</button>`;
  const extras = (ids) => html`<button class="btn sm" data-act="renovar" data-id="${ids}">Renovar</button><button class="btn sm" data-act="termo" data-id="${ids}">Termo</button>`;
  const grupo = (g) => g.length === 1 ? html`<div class="card list">${row(g[0], html`${prazo(g[0])}${extras(g[0].id)}${devolver(g[0])}`)}</div>` : html`<div class="card list group">
    <div class="row ghead"><div class="grow"><div class="t">${g[0].pessoa}${g[0].setor ? ' · ' + g[0].setor : ''} <span class="sub">${g.length} equipamentos</span></div><div class="s">retirado ${fmt(g[0].retirado_em)}</div></div>
    ${prazo(g[0])}${extras(g.map((l) => l.id).join(','))}<button class="btn sm primary" data-act="devolver-lote" data-id="${g.map((l) => l.id).join(',')}">Devolver todos</button></div>
    ${g.map((l) => html`<div class="row" role="button" tabindex="0" data-act="ficha" data-id="${l.equipment_id}"><div class="grow"><div class="t">${tag(l.codigo)} ${eqName(l)}</div></div>${devolver(l)}</div>`)}</div>`;
  page('Empréstimos', html`<button class="btn primary" data-act="emprestar">Novo empréstimo</button>`, html`
    <h2 class="sec">Em andamento <small>${ativos.length}</small></h2>
    ${grupos.length ? html`<div class="groups">${grupos.map(grupo)}</div>` : html`<div class="card list">${empty('Nada emprestado no momento.')}</div>`}
    <h2 class="sec">Devolvidos recentemente</h2>
    <div class="card list">${hist.length ? hist.map((l) => row(l, html`<span class="sub">devolvido ${fmt(l.devolvido_em)}</span>`)) : empty('Sem devoluções ainda.')}</div>`);
}

async function manutencao() {
  const all = await api('GET', '/tickets');
  const abertos = all.filter((t) => t.status !== 'resolvido');
  const feitos = all.filter((t) => t.status === 'resolvido').slice(0, 15);
  page('Manutenção', html`<button class="btn primary" data-act="chamado">Abrir chamado</button>`, html`
    <h2 class="sec">Abertos <small>${abertos.length}</small></h2>
    <div class="card list">${abertos.length ? abertos.map((t) => html`<div class="row">
      <div class="grow"><div class="t">${tag(t.codigo)} <a href="#" data-act="ficha" data-id="${t.equipment_id}" style="text-decoration:none">${eqName(t)}</a></div><div class="s">${t.descricao} · aberto ${fmt(t.aberto_em)}</div></div>
      ${badge(t.status, TICKET[t.status])}
      ${t.status === 'aberto' ? html`<button class="btn sm" data-act="reparo" data-id="${t.id}">Em reparo</button>` : ''}
      <button class="btn sm primary" data-act="resolver" data-id="${t.id}">Resolver</button></div>`) : empty('Nenhum chamado aberto.')}</div>
    <h2 class="sec">Resolvidos recentemente</h2>
    <div class="card list">${feitos.length ? feitos.map((t) => html`<div class="row"><div class="grow"><div class="t">${tag(t.codigo)} ${eqName(t)}</div><div class="s">${t.descricao}${t.solucao ? ' — ' + t.solucao : ''}</div></div><span class="sub">${fmt(t.resolvido_em)}</span></div>`) : empty('Sem chamados resolvidos.')}</div>`);
}

/* Importar CSV */
const IMP = [['tipo', 'Tipo', 1], ['marca', 'Marca'], ['modelo', 'Modelo', 1], ['serial', 'Serial', 1], ['condicao', 'Condição'], ['notas', 'Notas']];
const ALIAS = { tipo: ['tipo', 'categoria'], marca: ['marca', 'fabricante'], modelo: ['modelo'], serial: ['serial', 'numero de serie', 'n/s', 'serie', 'ns'], condicao: ['condicao', 'estado de conservacao'], notas: ['notas', 'obs', 'observacoes'] };
let imp = null;

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const d = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const mapped = () => imp.rows.map((r) => Object.fromEntries(IMP.map(([f]) => [f, imp.map[f] >= 0 ? r[imp.map[f]] ?? '' : ''])));
const canImport = () => IMP.every(([f, , req]) => !req || imp.map[f] >= 0);
const impPreview = () => html`<h2 class="sec">Pré-visualização</h2>
  <div class="card table-wrap"><table><thead><tr>${IMP.filter(([f]) => imp.map[f] >= 0).map(([, l]) => html`<th>${l}</th>`)}</tr></thead>
  <tbody>${mapped().slice(0, 5).map((r) => html`<tr style="cursor:default">${IMP.filter(([f]) => imp.map[f] >= 0).map(([f]) => html`<td>${r[f]}</td>`)}</tr>`)}</tbody></table></div>
  ${canImport() ? '' : html`<p class="form-err" style="margin-top:.75rem">Associe as colunas obrigatórias: tipo, modelo e serial.</p>`}`;

function importar() {
  if (imp?.result) {
    const r = imp.result;
    return page('Importar CSV', html`<button class="btn" data-act="imp-novo">Importar outro arquivo</button>`, html`
      <div class="tiles" style="grid-template-columns:repeat(2,1fr)"><div class="tile card"><span class="n">${r.importados}</span>${badge('disponivel', 'Importados')}</div><div class="tile card"><span class="n">${r.rejeitadas.length}</span>${badge(r.rejeitadas.length ? 'atrasado' : 'baixado', 'Rejeitadas')}</div></div>
      ${r.rejeitadas.length ? html`<h2 class="sec">Linhas rejeitadas</h2><div class="card table-wrap"><table><thead><tr><th>Linha</th><th>Serial</th><th>Motivo</th></tr></thead>
        <tbody>${r.rejeitadas.map((x) => html`<tr style="cursor:default"><td>${x.linha}</td><td>${x.serial ?? '—'}</td><td>${x.motivo}</td></tr>`)}</tbody></table></div>` : ''}`);
  }
  if (!imp) {
    return page('Importar CSV', '', html`
      <label class="drop" id="drop"><input type="file" id="file" accept=".csv,text/csv"><strong>Escolha ou solte um arquivo CSV</strong><br><span class="sub">No Excel: Arquivo → Salvar como → CSV. Aceita “;” ou “,”.</span></label>
      <p class="sub" style="margin-top:1rem">Sem arquivo à mão? Baixe o <a href="exemplo.csv" download>CSV de exemplo</a> (tem linhas inválidas de propósito).</p>`);
  }
  page('Importar CSV', html`<button class="btn" data-act="imp-novo">Trocar arquivo</button><button class="btn primary" id="imp-go" data-act="imp-go" ${canImport() ? '' : 'disabled'}>Importar ${imp.rows.length} linhas</button>`, html`
    <p class="sub">${imp.name} · ${imp.rows.length} linhas de dados</p>
    <h2 class="sec">Colunas</h2>
    <div class="card map">${IMP.map(([f, l, req]) => html`<label class="f"><span>${l}${req ? ' *' : ''}</span><select data-map="${f}"><option value="-1">— ignorar —</option>${imp.header.map((h, i) => html`<option value="${i}" ${imp.map[f] === i ? 'selected' : ''}>${h}</option>`)}</select></label>`)}</div>
    <div id="imp-prev">${impPreview()}</div>`);
}
async function loadFile(file) {
  const rows = parseCsv(await file.text());
  if (rows.length < 2) return toast('Arquivo vazio ou sem linhas de dados.', null, true);
  const header = rows[0].map((h) => h.trim());
  const map = Object.fromEntries(IMP.map(([f]) => [f, header.findIndex((h) => ALIAS[f].includes(strip(h)))]));
  imp = { name: file.name, header, rows: rows.slice(1), map };
  importar();
}

/* ---------- relatórios ---------- */
async function relatorios() {
  const r = await api('GET', '/relatorios');
  const barras = (lista, rotulo) => {
    const max = Math.max(1, ...lista.map((x) => x.n));
    return lista.length
      ? html`<ol class="bars">${lista.map((x) => html`<li><span class="bar-l">${rotulo(x)}</span><span class="bar-t"><i style="width:${((x.n / max) * 100).toFixed(1)}%"></i></span><b>${x.n}</b></li>`)}</ol>`
      : empty('Sem dados ainda.');
  };
  page('Relatórios', html`<a class="btn" href="/api/export/emprestimos.csv" download>Exportar empréstimos</a>`, html`
    <div class="tiles" style="grid-template-columns:repeat(3,1fr)">
      <div class="tile card"><span class="n">${r.totalEmprestimos}</span><span class="sub">empréstimos já feitos</span></div>
      <div class="tile card"><span class="n">${r.diasMedio == null ? '—' : Math.round(r.diasMedio)}</span><span class="sub">dias, em média, até a devolução</span></div>
      <div class="tile card"><span class="n">${r.emAtraso}</span><span class="sub">em atraso agora</span></div>
    </div>
    <div class="grid2 rel">
      <div><h2 class="sec">Mais emprestados</h2><div class="card pad">${barras(r.maisEmprestados, (x) => `${x.codigo} · ${eqName(x)}`)}</div></div>
      <div><h2 class="sec">Mais chamados de manutenção</h2><div class="card pad">${barras(r.maisChamados, (x) => `${x.codigo} · ${eqName(x)}`)}</div></div>
      <div><h2 class="sec">Por pessoa</h2><div class="card pad">${barras(r.porPessoa, (x) => x.pessoa)}</div></div>
      <div><h2 class="sec">Por setor</h2><div class="card pad">${barras(r.porSetor, (x) => x.setor)}</div></div>
    </div>
    <h2 class="sec">Por mês</h2>
    <div class="card table-wrap"><table><thead><tr><th>Mês</th><th>Empréstimos</th><th>Com atraso</th></tr></thead>
      <tbody>${r.porMes.length ? r.porMes.map((m) => html`<tr style="cursor:default"><td>${m.mes}</td><td>${m.n}</td><td>${m.atrasados}</td></tr>`) : html`<tr style="cursor:default"><td colspan="3" class="empty">Sem dados ainda.</td></tr>`}</tbody></table></div>`);
}

/* ---------- etiquetas com QR ---------- */
const etq = new Set(); // códigos marcados para imprimir
function desenharEtiquetas() {
  const alvo = $('#labels');
  if (!alvo) return;
  const itens = eqs.filter((e) => etq.has(e.codigo));
  alvo.innerHTML = itens.length
    ? itens.map((e) => html`<div class="label">${raw(qrSvg(`${location.origin}/#/e/${e.codigo}`))}<div class="lb"><div>${tag(e.codigo)}</div><div class="lb-n">${eqName(e)}</div><div class="lb-s">${e.serial}</div></div></div>`).map((x) => x.s).join('')
    : html`<p class="empty no-print">Marque equipamentos para ver as etiquetas.</p>`.s;
  const n = $('#etq-n');
  if (n) n.textContent = `${itens.length} selecionadas`;
}
async function etiquetas() {
  eqs = await api('GET', '/equipment');
  page('Etiquetas', html`<button class="btn primary" data-act="imprimir">Imprimir</button>`, html`
    <p class="sub no-print">Marque os equipamentos. Cada etiqueta leva um QR que abre a ficha do item (é preciso estar logado). Imprima em A4 ou em folha de etiquetas adesivas.</p>
    <form class="no-print" data-form="etq" novalidate>
      <div class="f" style="margin-top:1rem"><span>Equipamentos <span class="sub" id="etq-n">0 selecionadas</span></span>
        <input type="search" data-pick-q placeholder="Filtrar por ID, tipo, modelo ou serial…" autocomplete="off">
        <div class="pick">${eqs.length ? eqs.map((e) => html`<label class="pick-row" data-t="${strip([e.codigo, e.tipo, eqName(e), e.serial].join(' '))}"><input type="checkbox" data-etq="${e.codigo}" ${etq.has(e.codigo) ? 'checked' : ''}>${tag(e.codigo)}<span class="grow">${eqName(e)}</span><span class="sub" style="font-family:var(--mono)">${e.serial}</span></label>`) : empty('Nenhum equipamento cadastrado.')}</div>
        <div class="chips"><button type="button" class="btn sm" data-act="etq-all">Marcar visíveis</button><button type="button" class="btn sm" data-act="etq-none">Limpar</button></div>
      </div>
    </form>
    <div class="labels" id="labels"></div>`);
  desenharEtiquetas();
}

/* ---------- termo de empréstimo (imprimível) ---------- */
async function termo(ids) {
  const quero = ids.split(',').map(Number).filter(Boolean);
  const itens = (await api('GET', '/loans')).filter((l) => quero.includes(l.id));
  if (!itens.length) { toast('Empréstimo não encontrado.', null, true); return emprestimos(); }
  const f = itens[0];
  page('Termo de empréstimo', html`<button class="btn primary" data-act="imprimir">Imprimir</button><a class="btn" href="#/emprestimos">Voltar</a>`, html`
    <article class="termo card">
      <h2>Termo de empréstimo de equipamento</h2>
      <dl class="kv"><dt>Responsável</dt><dd>${f.pessoa}</dd><dt>Setor / sala</dt><dd>${f.setor ?? '—'}</dd><dt>Retirado em</dt><dd>${fmt(f.retirado_em)}</dd><dt>Devolver até</dt><dd>${fmt(f.previsto_para)}</dd></dl>
      <table class="termo-t"><thead><tr><th>ID</th><th>Equipamento</th><th>Serial</th></tr></thead>
        <tbody>${itens.map((l) => html`<tr style="cursor:default"><td>${tag(l.codigo)}</td><td>${eqName(l)}</td><td style="font-family:var(--mono)">${l.serial}</td></tr>`)}</tbody></table>
      <p class="termo-texto">Declaro ter recebido os equipamentos acima em bom estado de funcionamento. Comprometo-me a zelar por eles e a devolvê-los na data indicada. Em caso de perda, dano ou defeito, comunicarei imediatamente o setor de TI.</p>
      <div class="assina"><div><span></span>Responsável</div><div><span></span>Setor de TI</div></div>
      <p class="sub" style="margin-top:1.5rem">Data: ____/____/________</p>
    </article>`);
}

/* ---------- configurações: backup e senha ---------- */
async function config() {
  const lista = await api('GET', '/backup');
  page('Configurações', '', html`
    <h2 class="sec">Backup <small>${lista.length}</small></h2>
    <div class="card list">
      <div class="row"><div class="grow"><div class="t">Cópias do banco de dados</div><div class="s">Uma por dia, automática; ficam as últimas 14. Copie a pasta de backups para outro lugar também.</div></div>
        <button class="btn primary" data-act="backup-agora">Fazer backup agora</button></div>
      ${lista.length ? lista.map((b) => html`<div class="row"><div class="grow"><div class="t" style="font:600 .88rem var(--mono)">${b.nome}</div><div class="s">${Math.max(1, Math.round(b.tamanho / 1024))} KB</div></div>
        <a class="btn sm" href="/api/backup/${b.nome}" download>Baixar</a><button class="btn sm danger" data-act="restaurar" data-id="${b.nome}">Restaurar</button></div>`) : empty('Nenhum backup ainda.')}
    </div>
    <h2 class="sec">Senha do administrador</h2>
    <form class="card pad" data-form="senha" novalidate style="max-width:30rem">
      ${fld('atual', 'Senha atual *', '', 'type="password" required autocomplete="current-password"')}
      ${fld('nova', 'Nova senha * (mínimo 10 caracteres)', '', 'type="password" required minlength="10" autocomplete="new-password"')}
      ${fld('confirma', 'Repita a nova senha *', '', 'type="password" required autocomplete="new-password"')}
      <p class="form-err" data-err="_"></p>
      <button class="btn primary" type="submit">Trocar senha</button>
    </form>
    <h2 class="sec">Sessão</h2>
    <div class="card list"><div class="row"><div class="grow"><div class="t">Sair deste navegador</div></div><button class="btn" data-act="sair">Sair</button></div></div>`);
}

/* ---------- login, primeiro acesso e sessão ---------- */
let autenticado = false;
function telaLogin(configurado) {
  document.body.classList.add('anon');
  main.innerHTML = html`<div class="login-wrap"><form class="login card" data-form="${configurado ? 'login' : 'setup'}" novalidate>
    <div>${tag('KEEPER', true)}</div>
    <h1>${configurado ? 'Entrar' : 'Primeiro acesso'}</h1>
    <p class="sub" style="margin-bottom:1rem">${configurado ? 'Acesso restrito ao administrador.' : 'Crie a senha do administrador. O código de configuração aparece no console do servidor.'}</p>
    ${configurado ? '' : fld('codigo', 'Código de configuração *', '', 'required autocomplete="off" spellcheck="false" style="font-family:var(--mono);text-transform:uppercase"')}
    ${fld('senha', configurado ? 'Senha *' : 'Nova senha * (mínimo 10 caracteres)', '', `type="password" required ${configurado ? '' : 'minlength="10"'} autocomplete="${configurado ? 'current-password' : 'new-password'}"`)}
    <p class="form-err" data-err="_"></p>
    <button class="btn primary wide" type="submit">${configurado ? 'Entrar' : 'Criar acesso'}</button>
  </form></div>`.s;
  main.querySelector('input')?.focus();
}
function entrar() {
  autenticado = true;
  document.body.classList.remove('anon');
  lastRoute = null;
  render();
}
function sessaoPerdida() {
  if (!autenticado) return;
  autenticado = false;
  if (isOpen) finishClose();
  telaLogin(true);
}
async function boot() {
  try {
    const st = await api('GET', '/status');
    if (st.autenticado) entrar();
    else telaLogin(st.configurado);
  } catch {
    main.textContent = 'Não foi possível conectar ao servidor.';
  }
}

/* ---------- roteador ---------- */
// Abrir por QR/link (#/e/NB-0001): mostra o inventário com a ficha do item por cima.
async function fichaPorCodigo(cod) {
  await inventario();
  const x = eqs.find((e) => e.codigo === cod.toUpperCase());
  history.replaceState(null, '', '#/inventario'); // não reabrir a ficha a cada refresh
  if (x) await ficha(x.id);
  else toast(`ID não encontrado: ${cod}`, null, true);
}
const views = { '': dashboard, inventario, emprestimos, manutencao, importar, relatorios, etiquetas, config, termo, e: fichaPorCodigo };
const NAV_DE = { e: 'inventario', termo: 'emprestimos' };
let lastRoute = null;
async function render() {
  if (!autenticado) return;
  const r = location.hash.replace(/^#\/?/, '');
  const i = r.indexOf('/');
  const rota = i < 0 ? r : r.slice(0, i);
  const arg = i < 0 ? '' : decodeURIComponent(r.slice(i + 1));
  const nav = NAV_DE[rota] ?? rota;
  document.querySelectorAll('[data-nav]').forEach((a) => (a.dataset.nav === nav ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  movePill();
  fresh = r !== lastRoute;
  try { await (Object.hasOwn(views, rota) ? views[rota] : views[''])(arg); } catch (e) { fresh = false; falha(e); }
  if (r !== lastRoute) main.scrollTop = 0;
  lastRoute = location.hash.replace(/^#\/?/, '');
  badges();
}
async function badges() {
  try {
    const d = await api('GET', '/dashboard');
    for (const [id, n] of [['emprestimos', d.atrasados.length], ['manutencao', d.chamados.length]]) {
      const el = $('#n-' + id);
      el.hidden = !n;
      el.textContent = n;
    }
  } catch {}
}
addEventListener('hashchange', render);
addEventListener('resize', () => { pillY = null; movePill(); });

/* ---------- ficha e formulários no sheet ---------- */
const fld = (name, label, v = '', attrs = '') => html`<label class="f"><span>${label}</span><input name="${name}" value="${v}" ${raw(attrs)}><small class="err" data-err="${name}"></small></label>`;
const txt = (name, label, v = '', attrs = '') => html`<label class="f"><span>${label}</span><textarea name="${name}" rows="3" ${raw(attrs)}>${v}</textarea><small class="err" data-err="${name}"></small></label>`;
const submitRow = (label) => html`<p class="form-err" data-err="_"></p><div class="btns"><button class="btn primary" type="submit">${label}</button><button class="btn" type="button" data-act="close">Cancelar</button></div>`;

async function ficha(id) {
  const e = await api('GET', '/equipment/' + id);
  const loan = e.loans.find((l) => !l.devolvido_em);
  const abertos = e.tickets.filter((t) => t.status !== 'resolvido');
  const A = (act, label, cls = '') => html`<button class="btn ${cls}" data-act="${act}" data-id="${e.id}" data-back="1">${label}</button>`;
  const acoes = {
    disponivel: [A('emprestar', 'Emprestar', 'primary'), A('chamado', 'Abrir chamado'), A('editar', 'Editar'), A('baixar', 'Baixar', 'danger')],
    emprestado: [html`<button class="btn primary" data-act="devolver" data-id="${loan?.id}" data-back="1">Devolver</button>`, A('editar', 'Editar')],
    manutencao: [A('chamado', 'Outro chamado'), A('editar', 'Editar'), A('baixar', 'Baixar', 'danger')],
    baixado: [A('reativar', 'Reativar', 'primary'), A('editar', 'Editar')],
  }[e.estado];
  openSheet(html`${head(tag(e.codigo, true), eqName(e))}${body(
    html`<p>${badge(e.estado, ESTADO[e.estado])} ${loan && days(loan.previsto_para) < 0 ? badge('atrasado', 'Atrasado') : ''}</p>
      ${loan ? html`<p class="sub" style="margin-top:.6rem">Com <strong>${loan.pessoa}</strong>${loan.setor ? ` (${loan.setor})` : ''} · devolver até ${fmt(loan.previsto_para)}</p>` : ''}`,
    html`<div class="btns" style="margin-top:.4rem">${acoes}</div>`,
    abertos.length ? html`<div><h3>Chamados abertos</h3>${abertos.map((t) => html`<div class="ticket"><div>${t.descricao}</div><div class="sub">${badge(t.status, TICKET[t.status])} aberto ${fmt(t.aberto_em)}</div>
      <div class="btns">${t.status === 'aberto' ? html`<button class="btn sm" data-act="reparo" data-id="${t.id}" data-back="1">Em reparo</button>` : ''}<button class="btn sm primary" data-act="resolver" data-id="${t.id}" data-back="1">Resolver</button></div></div>`)}</div>` : '',
    html`<div><h3>Dados</h3><dl class="kv"><dt>Tipo</dt><dd>${e.tipo}</dd><dt>Serial</dt><dd style="font-family:var(--mono)">${e.serial}</dd><dt>Condição</dt><dd>${e.condicao}</dd>${e.notas ? html`<dt>Notas</dt><dd>${e.notas}</dd>` : ''}</dl></div>`,
    html`<div><h3>Histórico</h3><ol class="timeline">${e.events.map((v) => html`<li><time>${fmtTs(v.ts)}</time>${v.detalhe}</li>`)}</ol></div>`,
  )}`);
}

const TIPOS = { notebook: 'Notebook', tablet: 'Tablet', chromebook: 'Chromebook' };
const parseSerials = (v) => [...new Set(String(v).split(/[\n,;\t]+/).map((x) => x.trim()).filter(Boolean))];
const last = () => { try { return JSON.parse(localStorage.getItem('keeper.last')) ?? {}; } catch { return {}; } };
const tipoSelect = (v, attrs = '') => html`<label class="f"><span>Tipo *</span><select name="tipo" ${raw(attrs)}>${Object.entries(TIPOS).map(([k, l]) => html`<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`)}</select></label>`;
const condSelect = (v) => html`<label class="f"><span>Condição</span><select name="condicao">${['novo', 'bom', 'regular', 'ruim'].map((c) => html`<option ${(v || 'bom') === c ? 'selected' : ''}>${c}</option>`)}</select></label>`;

// Cadastro em lote: dados comuns uma vez (lembrados da última vez), um serial por linha.
async function bulkForm() {
  eqs = await api('GET', '/equipment');
  const l = last();
  openSheet(html`${head('Cadastro', 'Novo equipamento')}${body(html`
    <form data-form="bulk" novalidate>
      <div class="grid2">${tipoSelect(l.tipo, 'autofocus')}${fld('marca', 'Marca', l.marca ?? '', 'list="marcas" autocomplete="off"')}</div>
      <datalist id="marcas">${uniq(eqs.map((x) => x.marca)).map((m) => html`<option value="${m}">`)}</datalist>
      ${fld('modelo', 'Modelo *', l.modelo ?? '', 'required list="modelos" autocomplete="off"')}
      <datalist id="modelos">${uniq(eqs.map((x) => x.modelo)).map((m) => html`<option value="${m}">`)}</datalist>
      ${condSelect('bom')}
      <label class="f"><span>Seriais * <span class="sub" id="bulk-n">0 equipamentos</span></span><textarea name="seriais" rows="7" required spellcheck="false" style="font-family:var(--mono)" placeholder="Um serial por linha.&#10;Dá para colar uma coluna inteira do Excel."></textarea><small class="err" data-err="seriais"></small></label>
      ${submitRow('Cadastrar')}</form>`)}`);
}

async function equipForm(id) {
  const e = await api('GET', '/equipment/' + id);
  const v = (k) => e[k] ?? '';
  openSheet(html`${head(tag(e.codigo, true), 'Editar equipamento')}${body(html`
    <form data-form="equip" data-id="${id}" data-back="1" novalidate>
      <div class="grid2">${tipoSelect(e.tipo, 'disabled')}<input type="hidden" name="tipo" value="${e.tipo}">${fld('marca', 'Marca', v('marca'), 'autofocus')}</div>
      ${fld('modelo', 'Modelo *', v('modelo'), 'required')}
      ${fld('serial', 'Serial *', v('serial'), 'required')}
      ${condSelect(v('condicao'))}
      ${txt('notas', 'Notas', v('notas'))}${submitRow('Salvar')}</form>`)}`);
}

// Empréstimo: escolha um ou vários equipamentos disponíveis (filtro + marcar visíveis).
async function loanForm(pre = [], back) {
  const [loans, all] = await Promise.all([api('GET', '/loans'), api('GET', '/equipment')]);
  const lista = all.filter((e) => e.estado === 'disponivel');
  openSheet(html`${head('Empréstimo', 'Novo empréstimo')}${body(html`
    <form data-form="loan" data-back="${back ?? ''}" novalidate>
      <div class="f"><span>Equipamentos * <span class="sub" id="pick-n">${pre.length} selecionados</span></span>
        ${lista.length ? html`<input type="search" data-pick-q placeholder="Filtrar por ID, tipo, modelo ou serial…" autocomplete="off" ${pre.length ? '' : 'autofocus'}>
        <div class="pick">${lista.map((e) => html`<label class="pick-row" data-t="${strip([e.codigo, e.tipo, eqName(e), e.serial].join(' '))}"><input type="checkbox" name="ids" value="${e.id}" ${pre.includes(e.id) ? 'checked' : ''}>${tag(e.codigo)}<span class="grow">${eqName(e)}</span><span class="sub" style="font-family:var(--mono)">${e.serial}</span></label>`)}</div>
        <div class="chips"><button type="button" class="btn sm" data-act="pick-all">Marcar visíveis</button><button type="button" class="btn sm" data-act="pick-none">Limpar</button></div>`
        : html`<p class="empty">Nenhum equipamento disponível.</p>`}
        <small class="err" data-err="ids"></small></div>
      ${fld('pessoa', 'Pessoa *', '', 'required list="pessoas" autocomplete="off"' + (pre.length ? ' autofocus' : ''))}
      <datalist id="pessoas">${uniq(loans.map((l) => l.pessoa)).map((p) => html`<option value="${p}">`)}</datalist>
      ${fld('setor', 'Setor / sala', '', 'list="setores" autocomplete="off"')}
      <datalist id="setores">${uniq(loans.map((l) => l.setor)).map((p) => html`<option value="${p}">`)}</datalist>
      ${fld('previsto_para', 'Devolver até *', plus(7), `type="date" required min="${todayStr()}"`)}
      <div class="chips" style="margin:-.5rem 0 .9rem">${[[0, 'Hoje'], [1, 'Amanhã'], [7, '1 semana'], [30, '1 mês']].map(([n, l]) => html`<button type="button" class="btn sm" data-act="dias" data-id="${n}">${l}</button>`)}</div>
      ${submitRow('Emprestar')}</form>`)}`);
}

async function ticketForm(id, back) {
  const lista = id ? [] : (await api('GET', '/equipment')).filter((e) => e.estado === 'disponivel' || e.estado === 'manutencao');
  const e = id ? await api('GET', '/equipment/' + id) : null;
  openSheet(html`${head('Manutenção', 'Abrir chamado')}${body(html`
    <form data-form="ticket" data-id="${id ?? ''}" data-back="${back ?? ''}" novalidate>
      ${e ? html`<p style="margin-bottom:1rem">${tag(e.codigo)} ${eqName(e)}</p><input type="hidden" name="equipment_id" value="${e.id}">`
        : html`<label class="f"><span>Equipamento *</span><select name="equipment_id" required autofocus><option value="">Selecione…</option>${lista.map((x) => html`<option value="${x.id}">${x.codigo} · ${eqName(x)} (${x.serial})</option>`)}</select><small class="err" data-err="equipment_id"></small></label>`}
      ${txt('descricao', 'O que aconteceu? *', '', 'required' + (e ? ' autofocus' : ''))}${submitRow('Abrir chamado')}</form>
    ${e ? '' : html`<p class="sub">Itens emprestados precisam ser devolvidos antes.</p>`}`)}`);
}

/* ---------- ações ---------- */
async function done(eid, back) {
  await render();
  if (back && eid) await ficha(eid);
  else closeSheet();
}
const acts = {
  close: closeSheet,
  undo: async () => { const u = toastEl.undo; toastEl.classList.remove('on'); await u(); },
  ficha: (id) => ficha(id),
  filtro: (estado) => { inv.estado = estado; inv.q = ''; inv.tipo = ''; location.hash = '#/inventario'; },
  novo: () => bulkForm(),
  editar: (id) => equipForm(id),
  emprestar: (id, el) => loanForm(id ? [Number(id)] : [], el?.dataset.back),
  'emprestar-sel': () => loanForm([...sel]),
  'pick-all': (_, el) => { el.closest('form').querySelectorAll('.pick-row:not([hidden]) input').forEach((c) => (c.checked = true)); countPick(el.closest('form')); },
  'pick-none': (_, el) => { el.closest('form').querySelectorAll('.pick-row input').forEach((c) => (c.checked = false)); countPick(el.closest('form')); },
  async 'devolver-lote'(ids) {
    const lista = ids.split(',');
    for (const id of lista) await api('POST', `/loans/${id}/devolver`);
    toast(`${lista.length} equipamentos devolvidos.`, async () => { for (const id of lista) await api('POST', `/loans/${id}/desfazer`); toast('Devolução desfeita.'); await done(null, false); });
    await done(null, false);
  },
  chamado: (id, el) => ticketForm(id, el?.dataset.back),
  dias: (n, el) => { el.closest('form').querySelector('input[type=date]').value = plus(Number(n)); },
  imprimir: () => window.print(),
  termo: (ids) => { location.hash = `#/termo/${ids}`; },
  renovar: (ids) => openSheet(html`${head('Empréstimo', ids.includes(',') ? 'Renovar o grupo' : 'Renovar prazo')}${body(html`
    <form data-form="renovar" data-ids="${ids}" novalidate>
      ${fld('ate', 'Nova data de devolução *', plus(7), `type="date" required min="${todayStr()}" autofocus`)}
      <div class="chips" style="margin:-.5rem 0 .9rem">${[[7, 'Em 7 dias'], [14, 'Em 14 dias'], [30, 'Em 30 dias']].map(([n, l]) => html`<button type="button" class="btn sm" data-act="dias" data-id="${n}">${l}</button>`)}</div>
      ${submitRow('Renovar')}</form>`)}`),
  async 'copiar-cobranca'(id) {
    const l = ultimoPainel?.atrasados.find((x) => String(x.loan_id) === id);
    if (!l) return;
    const texto = `Olá ${l.pessoa}, o equipamento ${l.codigo} (${eqName(l)}) deveria ter sido devolvido em ${fmt(l.previsto_para)}. Pode devolvê-lo ao setor de TI? Obrigado!`;
    try { await navigator.clipboard.writeText(texto); toast('Mensagem copiada.'); } catch { toast(texto); }
  },
  'etq-all': (_, el) => {
    el.closest('form').querySelectorAll('.pick-row:not([hidden]) input').forEach((c) => { c.checked = true; etq.add(c.dataset.etq); });
    desenharEtiquetas();
  },
  'etq-none': (_, el) => { etq.clear(); el.closest('form').querySelectorAll('.pick-row input').forEach((c) => (c.checked = false)); desenharEtiquetas(); },
  async 'backup-agora'() {
    const r = await api('POST', '/backup');
    toast(`Backup criado: ${r.nome}`);
    await render();
  },
  restaurar: (nome) => openSheet(html`${head('Restaurar backup', 'Substituir os dados atuais?')}${body(html`
    <p>Os dados atuais serão trocados pelos do backup <strong style="font-family:var(--mono)">${nome}</strong>. Antes disso, um backup do estado atual é salvo automaticamente. Você continua conectado.</p>
    <div class="btns"><button class="btn danger" data-act="restaurar-ok" data-id="${nome}" autofocus>Restaurar</button><button class="btn" data-act="close">Cancelar</button></div>`)}`),
  async 'restaurar-ok'(nome) {
    const r = await api('POST', `/backup/${nome}/restaurar`);
    toast(`Backup restaurado. Estado anterior guardado em ${r.seguranca}.`);
    await done(null, false);
  },
  async sair() {
    try { await api('POST', '/logout'); } catch {}
    autenticado = false;
    if (isOpen) finishClose();
    telaLogin(true);
  },
  async devolver(id, el) {
    const r = await api('POST', `/loans/${id}/devolver`);
    toast('Devolvido.', async () => { await api('POST', `/loans/${id}/desfazer`); toast('Devolução desfeita.'); await done(r.equipment_id, isOpen); });
    await done(r.equipment_id, el?.dataset.back || isOpen);
  },
  async reparo(id, el) {
    const r = await api('PATCH', '/tickets/' + id, { status: 'em_reparo' });
    await done(r.equipment_id, el?.dataset.back);
  },
  resolver(id, el) {
    openSheet(html`${head('Manutenção', 'Resolver chamado')}${body(html`<form data-form="resolve" data-id="${id}" data-back="${el?.dataset.back ?? ''}" novalidate>${txt('solucao', 'O que foi feito?', '', 'autofocus')}${submitRow('Marcar como resolvido')}</form>`)}`);
  },
  baixar: (id) => openSheet(html`${head('Baixar equipamento', 'Tem certeza?')}${body(html`<p>O equipamento sai de uso e chamados abertos são encerrados. Dá para reativar depois.</p>
    <div class="btns"><button class="btn danger" data-act="baixar-ok" data-id="${id}" autofocus>Baixar equipamento</button><button class="btn" data-act="ficha" data-id="${id}">Cancelar</button></div>`)}`),
  async 'baixar-ok'(id) {
    await api('POST', `/equipment/${id}/baixa`, { baixar: true });
    toast('Equipamento baixado.', async () => { await api('POST', `/equipment/${id}/baixa`, { baixar: false }); toast('Baixa desfeita.'); await done(id, isOpen); });
    await done(id, true);
  },
  async reativar(id) {
    await api('POST', `/equipment/${id}/baixa`, { baixar: false });
    toast('Equipamento reativado.');
    await done(id, true);
  },
  'imp-novo': () => { imp = null; importar(); },
  async 'imp-go'(_, el) {
    el.disabled = true;
    try { imp.result = await api('POST', '/import', { rows: mapped() }); } finally { el.disabled = false; }
    importar();
    badges();
  },
};

const countPick = (f) => { $('#pick-n', f).textContent = `${f.querySelectorAll('[name=ids]:checked').length} selecionados`; };
const forms = {
  async bulk(d, f) {
    const seriais = parseSerials(d.seriais);
    if (!seriais.length) throw Object.assign(new Error('Informe ao menos um serial'), { campo: 'seriais' });
    const r = await api('POST', '/equipment/bulk', { tipo: d.tipo, marca: d.marca, modelo: d.modelo, condicao: d.condicao, seriais });
    try { localStorage.setItem('keeper.last', JSON.stringify({ tipo: d.tipo, marca: d.marca, modelo: d.modelo })); } catch {}
    if (r.rejeitadas.length) { // mantém só os rejeitados para corrigir e reenviar
      f.elements.seriais.value = r.rejeitadas.map((x) => x.serial).join('\n');
      f.elements.seriais.dispatchEvent(new Event('input', { bubbles: true }));
      f.querySelector('[data-err="_"]').textContent = `${r.importados} cadastrados. Rejeitados: ` + r.rejeitadas.map((x) => `${x.serial} (${x.motivo})`).join('; ');
      return render();
    }
    toast(r.importados === 1 ? `${r.codigos[0]} cadastrado.` : `${r.importados} cadastrados: ${r.codigos[0]} → ${r.codigos.at(-1)}`);
    await done(null, false);
  },
  async equip(d, f) {
    const r = await api('PUT', '/equipment/' + f.dataset.id, d);
    toast('Alterações salvas.');
    await done(r.id, true);
  },
  async loan(d, f) {
    const ids = [...f.querySelectorAll('[name=ids]:checked')].map((c) => Number(c.value));
    if (!ids.length) throw Object.assign(new Error('Selecione ao menos um equipamento'), { campo: 'ids' });
    const r = await api('POST', '/loans', { ...d, equipment_ids: ids });
    sel.clear();
    toast(ids.length > 1 ? `${ids.length} equipamentos emprestados.` : 'Emprestado.', async () => {
      for (const id of r.ids) await api('POST', `/loans/${id}/devolver`);
      toast('Empréstimo desfeito.');
      await done(null, false);
    }, false, { label: 'Termo', href: `#/termo/${r.ids.join(',')}` });
    await done(ids[0], f.dataset.back && ids.length === 1);
  },
  async renovar(d, f) {
    const ids = f.dataset.ids.split(',').map(Number);
    const r = await api('POST', '/loans/renovar', { itens: ids.map((id) => ({ id, ate: d.ate })) });
    toast(`Prazo renovado até ${fmt(d.ate)}.`, async () => {
      await api('POST', '/loans/renovar', { itens: r.map((x) => ({ id: x.id, ate: x.anterior })), reverter: true });
      toast('Renovação desfeita.');
      await done(null, false);
    });
    await done(null, false);
  },
  async login(d) {
    await api('POST', '/login', { senha: d.senha });
    entrar();
  },
  async setup(d) {
    await api('POST', '/setup', { codigo: d.codigo, senha: d.senha });
    entrar();
  },
  async senha(d) {
    if (d.nova !== d.confirma) throw Object.assign(new Error('As senhas não conferem'), { campo: 'confirma' });
    await api('POST', '/senha', { atual: d.atual, nova: d.nova, confirma: d.confirma });
    autenticado = false; // o servidor encerrou todas as sessões
    telaLogin(true);
    toast('Senha trocada. Entre de novo.');
  },
  async etq() {}, // Enter no filtro das etiquetas não deve recarregar a página
  async ticket(d, f) {
    const r = await api('POST', '/tickets', { ...d, equipment_id: Number(d.equipment_id) });
    toast('Chamado aberto.');
    await done(r.equipment_id, f.dataset.back);
  },
  async resolve(d, f) {
    const r = await api('PATCH', '/tickets/' + f.dataset.id, { status: 'resolvido', solucao: d.solucao });
    toast('Chamado resolvido.');
    await done(r.equipment_id, f.dataset.back);
  },
};

/* ---------- eventos globais ---------- */
const guard = (fn) => (...a) => Promise.resolve(fn(...a)).catch(falha);

document.addEventListener('click', guard((e) => {
  if (e.target.closest('[data-sel],[data-selall],.pick-row')) return; // caixas de seleção não abrem a ficha
  const el = e.target.closest('[data-act]');
  if (!el || !acts[el.dataset.act]) return;
  e.preventDefault();
  return acts[el.dataset.act](el.dataset.id, el);
}));
document.addEventListener('keydown', (e) => {
  const t = e.target;
  // Busca: Enter abre o primeiro resultado, ↓ desce para a lista. Linhas: ↑↓ navegam.
  if (t.id === 'q' && e.key === 'Enter') { const first = eqs.find(matches); if (first) { e.preventDefault(); guard(ficha)(first.id); } return; }
  if (t.id === 'q' && e.key === 'ArrowDown') { e.preventDefault(); $('#inv-body tr[tabindex]')?.focus(); return; }
  if (t.matches?.('tbody tr[tabindex]') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const n = e.key === 'ArrowDown' ? t.nextElementSibling : t.previousElementSibling;
    (n ?? (e.key === 'ArrowUp' ? $('#q') : null))?.focus();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    if (t.matches?.('[role=button][data-act]')) { e.preventDefault(); t.click(); }
    return;
  }
  if (e.key === 'Escape' && isOpen) return closeSheet();
  if (isOpen || e.metaKey || e.ctrlKey || e.altKey || t.matches?.('input,textarea,select')) return;
  if (e.key === '/') { e.preventDefault(); if (location.hash !== '#/inventario') location.hash = '#/inventario'; setTimeout(() => $('#q')?.focus(), 80); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); guard(acts.novo)(); }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'q') { inv.q = t.value; refilter(); }
  if (t.dataset.pickQ !== undefined) {
    const q = strip(t.value);
    t.form.querySelectorAll('.pick-row').forEach((r) => (r.hidden = !r.dataset.t.includes(q)));
  }
  if (t.name === 'seriais') $('#bulk-n').textContent = `${parseSerials(t.value).length} equipamentos`;
  const err = t.form?.querySelector(`[data-err="${t.name}"]`);
  if (err) err.textContent = '';
});
document.addEventListener('change', guard((e) => {
  const t = e.target;
  if (t.dataset.sel) { t.checked ? sel.add(Number(t.dataset.sel)) : sel.delete(Number(t.dataset.sel)); updSel(); }
  else if (t.dataset.selall !== undefined) {
    eqs.filter((e) => matches(e) && e.estado === 'disponivel').forEach((e) => (t.checked ? sel.add(e.id) : sel.delete(e.id)));
    refilter();
  }
  else if (t.name === 'ids') countPick(t.form);
  else if (t.id === 'f-estado') { inv.estado = t.value; refilter(); }
  else if (t.id === 'f-tipo') { inv.tipo = t.value; refilter(); }
  else if (t.id === 'file' && t.files[0]) return loadFile(t.files[0]);
  else if (t.dataset.map) {
    imp.map[t.dataset.map] = Number(t.value);
    $('#imp-prev').innerHTML = impPreview().s;
    $('#imp-go').disabled = !canImport();
  }
}));
document.addEventListener('dragover', (e) => { const d = e.target.closest?.('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
document.addEventListener('dragleave', (e) => e.target.closest?.('#drop')?.classList.remove('over'));
document.addEventListener('drop', guard((e) => {
  if (!e.target.closest?.('#drop')) return;
  e.preventDefault();
  if (e.dataTransfer.files[0]) return loadFile(e.dataTransfer.files[0]);
}));

// Validação inline ao sair do campo, não só no envio.
const showErr = (f) => {
  const s = f.form.querySelector(`[data-err="${f.name}"]`);
  if (s) s.textContent = f.validity.valid ? '' : f.validity.valueMissing ? 'Obrigatório' : f.validationMessage;
};
document.addEventListener('focusout', (e) => { if (e.target.form?.dataset.form && e.target.willValidate && e.target.value !== '') showErr(e.target); });
document.addEventListener('submit', guard(async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const bad = [...f.elements].filter((x) => x.willValidate && !x.validity.valid);
  bad.forEach(showErr);
  if (bad.length) return bad[0].focus();
  const btn = f.querySelector('[type=submit]');
  if (btn) btn.disabled = true;
  try {
    await forms[f.dataset.form](Object.fromEntries(new FormData(f)), f);
  } catch (err) {
    const s = f.querySelector(`[data-err="${err.campo}"]`) || f.querySelector('[data-err="_"]');
    if (s) s.textContent = err.message;
    if (err.campo) f.elements[err.campo]?.focus?.();
  } finally {
    if (btn) btn.disabled = false;
  }
}));

// Marcar/desmarcar etiquetas redesenha a folha
document.addEventListener('change', (e) => {
  const c = e.target.dataset?.etq;
  if (c === undefined) return;
  e.target.checked ? etq.add(c) : etq.delete(c);
  desenharEtiquetas();
});

boot();
