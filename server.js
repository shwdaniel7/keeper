import http from 'node:http';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { openDb, HttpError } from './db.js';
import { caminhoBackup, criarBackup, iniciarBackupAutomatico, listarBackups } from './backup.js';
import { codigoNovo, confereSenha, hashSenha, hashToken, iguais, limitador, senhaValida, tokenNovo } from './auth.js';

const env = process.env;
const HOST = env.HOST || '127.0.0.1';
const PORT = Number(env.PORT) || 3000;
const DATA = resolve(env.KEEPER_DATA || import.meta.dirname);
const BACKUPS = join(DATA, 'backups');
const PUB = join(import.meta.dirname, 'public');
const HOSTS = new Set((env.KEEPER_ORIGIN || 'localhost,127.0.0.1').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
const HTTPS = env.KEEPER_HTTPS === '1'; // cookie Secure e HSTS: ligar atrás de HTTPS
const TRUST_PROXY = env.TRUST_PROXY === '1'; // lê o IP real do X-Forwarded-For (só atrás do Caddy)
const COOKIE = 'keeper_sid';
const SESSAO_MS = 7 * 24 * 3600e3;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml' };

const db = openDb(env.KEEPER_DB || join(DATA, 'keeper.db'));
const tentativas = limitador();

// Primeiro acesso: senha via variável, ou código de uso único impresso no console.
let codigoSetup = null;
if (!db.senhaHash()) {
  if (env.KEEPER_ADMIN_PASSWORD) {
    if (!senhaValida(env.KEEPER_ADMIN_PASSWORD)) throw new Error('KEEPER_ADMIN_PASSWORD precisa ter pelo menos 10 caracteres');
    db.definirSenha(hashSenha(env.KEEPER_ADMIN_PASSWORD));
  } else {
    codigoSetup = codigoNovo();
    console.log(`\nKEEPER: primeiro acesso. Código de configuração: ${codigoSetup}\n`);
  }
}

const SEGURANCA = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};
if (HTTPS) SEGURANCA['strict-transport-security'] = 'max-age=31536000';

const csv = (rows) => {
  const cols = Object.keys(rows[0] ?? {});
  // Prefixo ' evita que o Excel execute células iniciadas por = + - @.
  const cell = (v) => {
    v = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(v)) v = "'" + v;
    return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
  };
  return '﻿' + [cols, ...rows.map((r) => cols.map((c) => r[c]))].map((r) => r.map(cell).join(',')).join('\r\n');
};
const download = (nome, corpo, tipo = 'text/csv; charset=utf-8') => ({ arquivo: nome, corpo, tipo });

function restaurar(nome) {
  const origem = caminhoBackup(BACKUPS, nome);
  if (!existsSync(origem)) throw new HttpError(404, 'Backup não encontrado');
  // Copia antes: a rotação de backups poderia apagar o próprio arquivo de origem.
  const tmp = join(tmpdir(), `keeper-restauracao-${randomUUID()}.db`);
  copyFileSync(origem, tmp);
  try {
    const seguranca = criarBackup(db.conn, BACKUPS);
    db.restaurar(tmp);
    return { restaurado: nome, seguranca };
  } finally {
    rmSync(tmp, { force: true });
  }
}

const routes = [
  ['GET', /^\/dashboard$/, () => db.dashboard()],
  ['GET', /^\/equipment$/, () => db.list()],
  ['POST', /^\/equipment$/, (_, b) => db.create(b)],
  ['POST', /^\/equipment\/bulk$/, (_, b) => db.createMany(b)],
  ['GET', /^\/equipment\/(\d+)$/, ([id]) => db.get(id)],
  ['PUT', /^\/equipment\/(\d+)$/, ([id], b) => db.update(id, b)],
  ['POST', /^\/equipment\/(\d+)\/baixa$/, ([id], b) => db.setBaixa(id, b.baixar !== false)],
  ['GET', /^\/loans$/, () => db.listLoans()],
  ['POST', /^\/loans$/, (_, b) => db.lend(b)],
  ['POST', /^\/loans\/renovar$/, (_, b) => db.renovar(b.itens, { reverter: !!b.reverter })],
  ['POST', /^\/loans\/(\d+)\/devolver$/, ([id]) => db.giveBack(id)],
  ['POST', /^\/loans\/(\d+)\/desfazer$/, ([id]) => db.undoReturn(id)],
  ['GET', /^\/tickets$/, () => db.listTickets()],
  ['POST', /^\/tickets$/, (_, b) => db.openTicket(b)],
  ['PATCH', /^\/tickets\/(\d+)$/, ([id], b) => db.updateTicket(id, b)],
  ['POST', /^\/import$/, (_, b) => db.importRows(b.rows)],
  ['GET', /^\/relatorios$/, () => db.relatorios()],
  ['GET', /^\/export\/inventario\.csv$/, () => download('inventario.csv', csv(db.exportInventory()))],
  ['GET', /^\/export\/historico\.csv$/, () => download('historico.csv', csv(db.exportHistory()))],
  ['GET', /^\/export\/emprestimos\.csv$/, () => download('emprestimos.csv', csv(db.exportLoans()))],
  ['GET', /^\/backup$/, () => listarBackups(BACKUPS)],
  ['POST', /^\/backup$/, () => ({ nome: criarBackup(db.conn, BACKUPS) })],
  ['POST', /^\/backup\/([\w.-]+)\/restaurar$/, ([nome]) => restaurar(nome)],
  ['GET', /^\/backup\/([\w.-]+)$/, ([nome]) => download(nome, readFileSync(caminhoBackup(BACKUPS, nome)), 'application/octet-stream')],
];

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    if ((size += c.length) > 5e6) throw new HttpError(413, 'Corpo grande demais');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

const cookieSid = (req) => (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) ?? null;
const cookieAttrs = (valor, maxAge) => `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${HTTPS ? '; Secure' : ''}`;
const ipDe = (req) => (TRUST_PROXY ? (req.headers['x-forwarded-for'] ?? '').split(',').pop().trim() : '') || req.socket.remoteAddress;

function autenticado(req) {
  const sid = cookieSid(req);
  if (!sid) return false;
  const agora = Date.now();
  return db.sessaoValida(hashToken(sid), agora, agora + SESSAO_MS);
}

function enviar(res, status, data, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(data ?? { ok: true }));
}

function abrirSessao() {
  const sid = tokenNovo();
  const agora = Date.now();
  db.limparSessoes(agora);
  db.criarSessao(hashToken(sid), agora + SESSAO_MS);
  return cookieAttrs(sid, SESSAO_MS / 1000);
}

function entrar(req, res, b) {
  const ip = ipDe(req);
  const espera = tentativas.bloqueadoPor(ip);
  if (espera) throw new HttpError(429, `Muitas tentativas. Tente de novo em ${Math.ceil(espera / 60)} min.`);
  if (!confereSenha(b.senha, db.senhaHash())) {
    tentativas.falhou(ip);
    throw new HttpError(401, 'Senha incorreta', 'senha');
  }
  tentativas.ok(ip);
  enviar(res, 200, { ok: true }, { 'set-cookie': abrirSessao() });
}

function configurar(req, res, b) {
  if (db.senhaHash()) throw new HttpError(409, 'Já configurado');
  const chave = 'setup:' + ipDe(req);
  const espera = tentativas.bloqueadoPor(chave);
  if (espera) throw new HttpError(429, `Muitas tentativas. Tente de novo em ${Math.ceil(espera / 60)} min.`);
  if (!iguais(String(b.codigo ?? '').trim().toUpperCase(), codigoSetup ?? '\0')) {
    tentativas.falhou(chave);
    throw new HttpError(401, 'Código de configuração incorreto', 'codigo');
  }
  if (!senhaValida(b.senha)) throw new HttpError(400, 'Use pelo menos 10 caracteres', 'senha');
  db.definirSenha(hashSenha(b.senha));
  codigoSetup = null;
  tentativas.ok(chave);
  enviar(res, 200, { ok: true }, { 'set-cookie': abrirSessao() });
}

function trocarSenha(res, b) {
  if (!confereSenha(b.atual, db.senhaHash())) throw new HttpError(403, 'Senha atual incorreta', 'atual');
  if (!senhaValida(b.nova)) throw new HttpError(400, 'Use pelo menos 10 caracteres', 'nova');
  if (b.nova !== b.confirma) throw new HttpError(400, 'As senhas não conferem', 'confirma');
  db.definirSenha(hashSenha(b.nova));
  db.apagarSessoes(); // troca de senha derruba todas as sessões, inclusive esta
  enviar(res, 200, { ok: true }, { 'set-cookie': cookieAttrs('', 0) });
}

async function api(req, res, path) {
  // Exigir JSON em escritas bloqueia formulários de outros sites (CSRF) sem precisar de token.
  if (req.method !== 'GET' && !req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use application/json');
  const corpo = req.method === 'GET' ? {} : await readJson(req);
  const chave = `${req.method} ${path}`;

  if (chave === 'GET /status') return enviar(res, 200, { configurado: !!db.senhaHash(), autenticado: autenticado(req) });
  if (chave === 'POST /login') return entrar(req, res, corpo);
  if (chave === 'POST /setup') return configurar(req, res, corpo);
  if (chave === 'POST /logout') {
    const sid = cookieSid(req);
    if (sid) db.apagarSessao(hashToken(sid));
    return enviar(res, 200, { ok: true }, { 'set-cookie': cookieAttrs('', 0) });
  }

  if (!autenticado(req)) throw new HttpError(401, 'Entre para continuar');
  if (chave === 'POST /senha') return trocarSenha(res, corpo);

  for (const [method, re, fn] of routes) {
    const m = method === req.method && path.match(re);
    if (!m) continue;
    const out = await fn(m.slice(1), corpo);
    if (out?.arquivo) {
      res.writeHead(200, { 'content-type': out.tipo, 'content-disposition': `attachment; filename="${out.arquivo}"`, 'cache-control': 'no-store' });
      return res.end(out.corpo);
    }
    return enviar(res, 200, out);
  }
  throw new HttpError(404, 'Rota não encontrada');
}

async function serveStatic(res, path) {
  const rel = normalize(path === '/' ? '/index.html' : path);
  const full = join(PUB, rel);
  if (!full.startsWith(PUB)) throw new HttpError(403, 'Proibido');
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    throw new HttpError(404, 'Não encontrado');
  }
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEGURANCA)) res.setHeader(k, v);
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') return enviar(res, 200, { ok: true }); // sem dados; vale para qualquer Host (healthcheck do Docker)
    // Só aceita os hosts configurados: bloqueia DNS rebinding contra o servidor local.
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!HOSTS.has(host)) throw new HttpError(403, 'Host inválido');
    if (pathname.startsWith('/api/')) await api(req, res, pathname.slice(4));
    else await serveStatic(res, decodeURIComponent(pathname));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) enviar(res, status, { error: status === 500 ? 'Erro interno' : e.message, campo: e.campo });
  }
});

if (!env.KEEPER_SEM_BACKUP) iniciarBackupAutomatico(db.conn, BACKUPS);

server.listen(PORT, HOST, () => console.log(`KEEPER em http://${HOST}:${PORT}`));

const sair = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', sair);
process.on('SIGINT', sair);
