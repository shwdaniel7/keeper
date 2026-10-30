import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, HttpError } from '../db.js';
import { backupDoDia, caminhoBackup, criarBackup, listarBackups } from '../backup.js';

const pasta = () => mkdtempSync(join(tmpdir(), 'keeper-bk-'));
const novo = (db, serial) => db.create({ tipo: 'notebook', modelo: 'X', serial });

test('criarBackup mantém só as 14 últimas cópias', () => {
  const db = openDb(':memory:');
  novo(db, 'A');
  const dir = pasta();
  for (let i = 0; i < 16; i++) criarBackup(db.conn, dir);
  assert.equal(listarBackups(dir).length, 14);
});

test('restaurar troca os dados, preserva senha e recusa arquivo inválido', () => {
  const db = openDb(':memory:');
  novo(db, 'A');
  db.definirSenha('hash-x');
  const dir = pasta();
  const nome = criarBackup(db.conn, dir);
  novo(db, 'B');
  assert.equal(db.list().length, 2);
  db.restaurar(caminhoBackup(dir, nome));
  assert.equal(db.list().length, 1);
  assert.equal(db.senhaHash(), 'hash-x');
  assert.equal(db.create({ tipo: 'notebook', modelo: 'X', serial: 'C' }).codigo, 'NB-0002'); // contagem segue certa

  const lixo = join(dir, 'lixo.db');
  writeFileSync(lixo, 'isto não é um banco sqlite');
  assert.throws(() => db.restaurar(lixo), (e) => e instanceof HttpError && e.status === 400);
  assert.equal(db.list().length, 2); // nada foi alterado
});

test('caminhoBackup recusa nomes fora do padrão (sem path traversal)', () => {
  const dir = pasta();
  for (const ruim of ['../server.js', 'server.js', 'keeper.db', 'keeper-2026-01-01-000000.db/../x']) {
    assert.throws(() => caminhoBackup(dir, ruim), (e) => e instanceof HttpError && e.status === 400);
  }
  assert.ok(caminhoBackup(dir, 'keeper-2026-01-01-093015.db').endsWith('keeper-2026-01-01-093015.db'));
});

test('backupDoDia cria um por dia', () => {
  const db = openDb(':memory:');
  const dir = pasta();
  assert.ok(backupDoDia(db.conn, dir));
  assert.equal(backupDoDia(db.conn, dir), null);
  assert.equal(listarBackups(dir).length, 1);
});
