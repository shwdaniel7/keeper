import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codigoNovo, confereSenha, hashSenha, hashToken, limitador, senhaValida, tokenNovo } from '../auth.js';

test('senha: hash com sal próprio, confere certa e recusa errada', () => {
  const a = hashSenha('uma-senha-longa');
  const b = hashSenha('uma-senha-longa');
  assert.notEqual(a, b); // sais diferentes
  assert.ok(confereSenha('uma-senha-longa', a));
  assert.ok(!confereSenha('outra-senha-aqui', a));
  assert.ok(!confereSenha('x', 'lixo'));
  assert.ok(!confereSenha('x', null));
  assert.ok(!a.includes('uma-senha-longa'));
});

test('senha precisa de 10+ caracteres', () => {
  assert.ok(!senhaValida('curta'));
  assert.ok(!senhaValida(undefined));
  assert.ok(senhaValida('dez-chars!'));
});

test('token: aleatório, e o hash é estável e diferente do token', () => {
  const t = tokenNovo();
  assert.notEqual(t, tokenNovo());
  assert.equal(hashToken(t), hashToken(t));
  assert.notEqual(hashToken(t), t);
  assert.match(codigoNovo(), /^[0-9A-F]{10}$/);
});

test('limitador bloqueia na 5ª falha e libera depois da janela', () => {
  const l = limitador({ max: 5, janelaMs: 1000 });
  for (let i = 0; i < 4; i++) l.falhou('ip', 0);
  assert.equal(l.bloqueadoPor('ip', 0), 0);
  l.falhou('ip', 0);
  assert.ok(l.bloqueadoPor('ip', 10) > 0);
  assert.equal(l.bloqueadoPor('ip', 1001), 0);
  assert.equal(l.bloqueadoPor('outro', 10), 0); // por chave
  l.ok('ip');
  assert.equal(l.bloqueadoPor('ip', 10), 0);
});
