import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { descriptografar } from '../automacoes/n8n/descriptografar.js';

const wf = JSON.parse(readFileSync(new URL('../automacoes/n8n/backup-nuvem.json', import.meta.url)));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// Roda o código do nó "Criptografar" com um `this.helpers` falso, como o n8n faria.
async function criptografar(dados, frase) {
  const codigo = wf.nodes.find((n) => n.name === 'Criptografar').parameters.jsCode;
  const dolar = (nome) => ({ first: () => ({ json: nome === 'Config' ? { frase } : { nome: 'keeper-2026-01-01-000000.db' } }) });
  const helpers = { getBinaryDataBuffer: async () => dados, prepareBinaryData: async (buf) => ({ buf }) };
  const [saida] = await new AsyncFunction('require', '$', codigo).call({ helpers }, createRequire(import.meta.url), dolar);
  return saida;
}

const banco = Buffer.concat([Buffer.from('SQLite format 3\0'), randomBytes(500)]);

test('o nó Criptografar gera um arquivo que descriptografar.js abre, e só com a frase certa', async () => {
  const saida = await criptografar(banco, 'frase de teste');
  assert.equal(saida.binary.data.buf.length, banco.length + 44);
  assert.deepEqual(descriptografar(saida.binary.data.buf, 'frase de teste'), banco);
  assert.throws(() => descriptografar(saida.binary.data.buf, 'outra'));
});

test('o nó Criptografar recusa frase padrão e arquivo que não é SQLite', async () => {
  await assert.rejects(criptografar(banco, 'TROQUE-ESTA-FRASE'), /frase/);
  await assert.rejects(criptografar(Buffer.from('<html>erro</html>'), 'x'), /SQLite/);
});

test('todas as ligações do workflow apontam para nós que existem', () => {
  const nomes = new Set(wf.nodes.map((n) => n.name));
  for (const [de, { main }] of Object.entries(wf.connections)) {
    assert.ok(nomes.has(de));
    for (const { node } of main.flat()) assert.ok(nomes.has(node), node);
  }
});
