import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _teste, formatoBits, qrMatriz, qrSvg } from '../public/qr.js';

test('campo de formato (nível M, máscara 0) bate com a especificação', () => {
  assert.equal(formatoBits(0), 0b101010000010010);
});

test('Reed-Solomon: palavra de código tem resto zero nas raízes do gerador', () => {
  const { correcaoRS, gmul, EXP } = _teste;
  const dados = Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
  for (const n of [10, 16, 26]) {
    const palavra = [...dados, ...correcaoRS(dados, n)];
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const c of palavra) v = gmul(v, EXP[i]) ^ c; // Horner em GF(256)
      assert.equal(v, 0, `raiz α^${i}, n=${n}`);
    }
  }
});

test('tamanho segue a versão: ID curto cabe na v1, URL de etiqueta na v3', () => {
  assert.equal(qrMatriz('NB-0001').length, 21);
  assert.equal(qrMatriz('https://keeper.exemplo.com/#/e/NB-0001').length, 29);
  assert.throws(() => qrMatriz('x'.repeat(300)));
});

test('os dados intercalados ocupam exatamente os codewords da versão', () => {
  const { codificarBytes, intercalar, codewordsBrutos } = _teste;
  for (const [texto, v] of [['abc', 1], ['x'.repeat(40), 3], ['x'.repeat(60), 4], ['x'.repeat(100), 6]]) {
    const bytes = [...new TextEncoder().encode(texto)];
    assert.equal(intercalar(codificarBytes(bytes, v), v).length, codewordsBrutos(v));
  }
});

test('marcadores de canto, temporização e módulo escuro fixo', () => {
  const m = qrMatriz('KEEPER');
  const n = m.length;
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let dy = 0; dy < 7; dy++)
      for (let dx = 0; dx < 7; dx++) {
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(m[oy + dy][ox + dx], dist !== 2, `marcador em (${ox},${oy}) célula ${dx},${dy}`);
      }
  }
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0);
    assert.equal(m[i][6], i % 2 === 0);
  }
  assert.equal(m[n - 8][8], true);
});

test('determinístico, e textos diferentes dão matrizes diferentes', () => {
  assert.deepEqual(qrMatriz('NB-0001'), qrMatriz('NB-0001'));
  assert.notDeepEqual(qrMatriz('NB-0001'), qrMatriz('NB-0002'));
});

test('SVG tem viewBox com borda e é só caminho preto', () => {
  const svg = qrSvg('NB-0001', 2);
  assert.match(svg, /viewBox="0 0 25 25"/);
  assert.ok(!/<script|onload/i.test(svg));
});
