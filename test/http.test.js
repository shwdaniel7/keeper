import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENHA = 'senha-de-teste-123';
const servidores = [];

// Sobe o servidor de verdade (processo filho) com dados numa pasta temporária.
function iniciar(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-http-'));
  const porta = 41000 + Math.floor(Math.random() * 3000);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, KEEPER_DATA: dir, KEEPER_DB: '', PORT: String(porta), HOST: '127.0.0.1', KEEPER_ORIGIN: 'localhost,127.0.0.1', KEEPER_ADMIN_PASSWORD: '', TRUST_PROXY: '', KEEPER_HTTPS: '', ...extra },
  });
  let saida = '';
  const s = { proc, dir, porta, saida: () => saida };
  s.pronto = new Promise((ok, erro) => {
    proc.stdout.on('data', (d) => { saida += d; if (saida.includes('KEEPER em')) ok(); });
    proc.stderr.on('data', (d) => { saida += d; });
    proc.on('exit', (c) => erro(new Error(`servidor saiu (${c}): ${saida}`)));
    setTimeout(() => erro(new Error('timeout ao iniciar: ' + saida)), 10000);
  });
  s.pronto.catch(() => {});
  servidores.push(s);
  return s;
}

function pedir(s, metodo, caminho, { cookie, corpo, host, json = true } = {}) {
  return new Promise((ok, erro) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const headers = { host: host ?? `localhost:${s.porta}` };
    if (cookie) headers.cookie = cookie;
    if (json && metodo !== 'GET') headers['content-type'] = 'application/json';
    if (dados) headers['content-length'] = Buffer.byteLength(dados);
    const req = http.request({ host: '127.0.0.1', port: s.porta, method: metodo, path: caminho, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString();
        let corpoJson;
        try { corpoJson = JSON.parse(texto); } catch {}
        ok({ status: res.statusCode, headers: res.headers, texto, json: corpoJson });
      });
    });
    req.on('error', erro);
    if (dados) req.write(dados);
    req.end();
  });
}

const cookieDe = (r) => r.headers['set-cookie']?.[0]?.split(';')[0];
async function logar(s, senha = SENHA) {
  const r = await pedir(s, 'POST', '/api/login', { corpo: { senha } });
  assert.equal(r.status, 200);
  return cookieDe(r);
}

const principal = iniciar({ KEEPER_ADMIN_PASSWORD: SENHA });
before(() => principal.pronto);
after(async () => {
  for (const s of servidores) {
    const saiu = new Promise((r) => s.proc.once('exit', r));
    s.proc.kill();
    await saiu;
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('sem sessão: /api/status é público, o resto dá 401; cabeçalhos de segurança presentes', async () => {
  const st = await pedir(principal, 'GET', '/api/status');
  assert.deepEqual(st.json, { configurado: true, autenticado: false });
  assert.match(st.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(st.headers['x-content-type-options'], 'nosniff');
  for (const [m, p] of [['GET', '/api/equipment'], ['GET', '/api/dashboard'], ['GET', '/api/backup'], ['GET', '/api/export/inventario.csv'], ['POST', '/api/loans']]) {
    assert.equal((await pedir(principal, m, p, { corpo: m === 'POST' ? {} : undefined })).status, 401, `${m} ${p}`);
  }
  const estatico = await pedir(principal, 'GET', '/');
  assert.equal(estatico.status, 200); // o shell do app é público; os dados não
});

test('login: senha errada = 401, certa = cookie HttpOnly/SameSite; logout invalida a sessão', async () => {
  assert.equal((await pedir(principal, 'POST', '/api/login', { corpo: { senha: 'errada' } })).status, 401);
  const ok = await pedir(principal, 'POST', '/api/login', { corpo: { senha: SENHA } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'][0], /HttpOnly/);
  assert.match(ok.headers['set-cookie'][0], /SameSite=Strict/);
  assert.ok(!/Secure/.test(ok.headers['set-cookie'][0])); // KEEPER_HTTPS desligado neste teste
  const cookie = cookieDe(ok);
  assert.equal((await pedir(principal, 'GET', '/api/equipment', { cookie })).status, 200);
  await pedir(principal, 'POST', '/api/logout', { cookie, corpo: {} });
  assert.equal((await pedir(principal, 'GET', '/api/equipment', { cookie })).status, 401);
});

test('CSRF e host: escrita sem JSON = 415; Host desconhecido = 403', async () => {
  const cookie = await logar(principal);
  assert.equal((await pedir(principal, 'POST', '/api/loans', { cookie, json: false })).status, 415);
  assert.equal((await pedir(principal, 'GET', '/api/status', { host: 'evil.com' })).status, 403);
  assert.equal((await pedir(principal, 'GET', '/healthz', { host: 'qualquer.coisa' })).status, 200); // healthcheck do Docker
});

test('fluxo completo: lote, empréstimo em lote, renovar, relatórios, CSV', async () => {
  const cookie = await logar(principal);
  const bulk = await pedir(principal, 'POST', '/api/equipment/bulk', { cookie, corpo: { tipo: 'chromebook', marca: 'Positivo', modelo: 'C1', seriais: ['A', 'B', 'C'] } });
  assert.deepEqual(bulk.json.codigos, ['CB-0001', 'CB-0002', 'CB-0003']);
  const lista = (await pedir(principal, 'GET', '/api/equipment', { cookie })).json;
  const emp = await pedir(principal, 'POST', '/api/loans', { cookie, corpo: { equipment_ids: lista.slice(0, 2).map((e) => e.id), pessoa: 'Ana', setor: 'Sala 3', previsto_para: '2099-01-01' } });
  assert.equal(emp.json.ids.length, 2);
  const ren = await pedir(principal, 'POST', '/api/loans/renovar', { cookie, corpo: { itens: emp.json.ids.map((id) => ({ id, ate: '2099-02-01' })) } });
  assert.equal(ren.json[0].anterior, '2099-01-01');
  const rel = await pedir(principal, 'GET', '/api/relatorios', { cookie });
  assert.equal(rel.json.totalEmprestimos, 2);
  const csv = await pedir(principal, 'GET', '/api/export/emprestimos.csv', { cookie });
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.texto, /Ana/);
});

test('backup: criar, listar, baixar, restaurar (continua logado) e recusar nome inválido', async () => {
  const cookie = await logar(principal);
  const antes = (await pedir(principal, 'GET', '/api/equipment', { cookie })).json.length;
  const b = await pedir(principal, 'POST', '/api/backup', { cookie, corpo: {} });
  assert.match(b.json.nome, /^keeper-\d{4}-\d{2}-\d{2}-\d{6}/);
  assert.ok((await pedir(principal, 'GET', '/api/backup', { cookie })).json.some((x) => x.nome === b.json.nome));
  const baixado = await pedir(principal, 'GET', `/api/backup/${b.json.nome}`, { cookie });
  assert.equal(baixado.status, 200);
  assert.ok(baixado.texto.startsWith('SQLite format 3'));

  await pedir(principal, 'POST', '/api/equipment/bulk', { cookie, corpo: { tipo: 'tablet', modelo: 'T', seriais: ['Z1'] } });
  assert.equal((await pedir(principal, 'GET', '/api/equipment', { cookie })).json.length, antes + 1);
  const rest = await pedir(principal, 'POST', `/api/backup/${b.json.nome}/restaurar`, { cookie, corpo: {} });
  assert.equal(rest.status, 200);
  assert.equal((await pedir(principal, 'GET', '/api/equipment', { cookie })).json.length, antes);

  assert.equal((await pedir(principal, 'GET', '/api/backup/server.js', { cookie })).status, 400);
  assert.equal((await pedir(principal, 'GET', '/api/backup/..%2f..%2fserver.js', { cookie })).status, 404);
});

test('trocar a senha derruba as sessões; a antiga deixa de valer', async () => {
  const s = iniciar({ KEEPER_ADMIN_PASSWORD: SENHA });
  await s.pronto;
  const cookie = await logar(s);
  const errada = await pedir(s, 'POST', '/api/senha', { cookie, corpo: { atual: 'nao-e-essa', nova: 'nova-senha-123', confirma: 'nova-senha-123' } });
  assert.equal(errada.status, 403); // 403, não 401: não deve parecer sessão expirada
  assert.equal((await pedir(s, 'POST', '/api/senha', { cookie, corpo: { atual: SENHA, nova: 'curta', confirma: 'curta' } })).status, 400);
  assert.equal((await pedir(s, 'POST', '/api/senha', { cookie, corpo: { atual: SENHA, nova: 'nova-senha-123', confirma: 'outra-coisa-123' } })).status, 400);
  assert.equal((await pedir(s, 'POST', '/api/senha', { cookie, corpo: { atual: SENHA, nova: 'nova-senha-123', confirma: 'nova-senha-123' } })).status, 200);
  assert.equal((await pedir(s, 'GET', '/api/equipment', { cookie })).status, 401);
  assert.equal((await pedir(s, 'POST', '/api/login', { corpo: { senha: SENHA } })).status, 401);
  assert.equal((await pedir(s, 'POST', '/api/login', { corpo: { senha: 'nova-senha-123' } })).status, 200);
});

test('limite de tentativas: após 5 erros, até a senha certa fica bloqueada (429)', async () => {
  const s = iniciar({ KEEPER_ADMIN_PASSWORD: SENHA });
  await s.pronto;
  for (let i = 0; i < 5; i++) assert.equal((await pedir(s, 'POST', '/api/login', { corpo: { senha: 'errada' + i } })).status, 401);
  assert.equal((await pedir(s, 'POST', '/api/login', { corpo: { senha: SENHA } })).status, 429);
});

test('primeiro acesso: exige o código do console, senha de 10+ caracteres e só vale uma vez', async () => {
  const s = iniciar(); // sem KEEPER_ADMIN_PASSWORD
  await s.pronto;
  assert.deepEqual((await pedir(s, 'GET', '/api/status')).json, { configurado: false, autenticado: false });
  const codigo = s.saida().match(/Código de configuração: ([0-9A-F]{10})/)?.[1];
  assert.ok(codigo, 'o código deve aparecer no console');
  assert.equal((await pedir(s, 'POST', '/api/login', { corpo: { senha: SENHA } })).status, 401);
  assert.equal((await pedir(s, 'POST', '/api/setup', { corpo: { codigo: '0000000000', senha: SENHA } })).status, 401);
  assert.equal((await pedir(s, 'POST', '/api/setup', { corpo: { codigo, senha: 'curta' } })).status, 400);
  const ok = await pedir(s, 'POST', '/api/setup', { corpo: { codigo: codigo.toLowerCase(), senha: SENHA } });
  assert.equal(ok.status, 200);
  assert.equal((await pedir(s, 'GET', '/api/equipment', { cookie: cookieDe(ok) })).status, 200);
  assert.equal((await pedir(s, 'POST', '/api/setup', { corpo: { codigo, senha: 'outra-senha-123' } })).status, 409);
});

test('atrás de HTTPS (KEEPER_HTTPS=1): cookie Secure e HSTS', async () => {
  const s = iniciar({ KEEPER_ADMIN_PASSWORD: SENHA, KEEPER_HTTPS: '1' });
  await s.pronto;
  const r = await pedir(s, 'POST', '/api/login', { corpo: { senha: SENHA } });
  assert.match(r.headers['set-cookie'][0], /; Secure/);
  assert.match(r.headers['strict-transport-security'], /max-age/);
});
