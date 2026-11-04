import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('../automacoes/n8n/registrar-retirada.json', import.meta.url)));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const dia = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('sv');
const HOJE = dia(0);
const AMANHA = dia(1);

// Roda o código de um nó Code como o n8n faria: `ctx` mapeia nome do nó -> json (ou lista de json); `entrada` são os itens do nó anterior.
async function roda(nome, { ctx = {}, entrada = [{}], sd = {}, binario } = {}) {
  const codigo = wf.nodes.find((n) => n.name === nome).parameters.jsCode;
  const itens = entrada.map((json) => ({ json, binary: binario }));
  const lista = (n) => (Array.isArray(ctx[n]) ? ctx[n] : [ctx[n]]).map((json) => ({ json }));
  const dolar = (n) => ({ first: () => lista(n)[0], all: () => lista(n) });
  const input = { first: () => itens[0], all: () => itens };
  const helpers = { getBinaryDataBuffer: async () => Buffer.from('foto') };
  const out = await new AsyncFunction('$', '$input', '$getWorkflowStaticData', codigo).call({ helpers }, dolar, input, () => sd);
  return out.map((i) => i.json);
}

const config = { chatId: '42' };
const msg = (id, chat, extra) => ({ update_id: id, message: { chat: { id: chat }, ...extra } });

test('Triagem só atende o chat configurado, uma mensagem por vez, e avança o offset', async () => {
  const sd = {};
  const result = [msg(10, 99, { text: 'intruso' }), msg(11, 42, { photo: [{ file_id: 'p-pequena' }, { file_id: 'p-grande' }] }), msg(12, 42, { text: 'ok' })];
  const [a] = await roda('Triagem', { ctx: { Config: config }, entrada: [{ result }], sd });
  assert.deepEqual(a, { chatId: '42', tipo: 'foto', fileId: 'p-grande', texto: '' });
  assert.equal(sd.offset, 12); // a mensagem 12 fica para a próxima rodada
  const [b] = await roda('Triagem', { ctx: { Config: config }, entrada: [{ result: [result[2]] }], sd });
  assert.equal(b.tipo, 'texto');
  assert.equal(b.texto, 'ok');
  assert.equal(sd.offset, 13);
});

test('Triagem descarta mensagens de outros chats e não devolve nada', async () => {
  const sd = {};
  const out = await roda('Triagem', { ctx: { Config: config }, entrada: [{ result: [msg(5, 99, { text: 'oi' })] }], sd });
  assert.deepEqual(out, []);
  assert.equal(sd.offset, 6);
});

// --- Planejar: a folha é uma planilha com várias linhas; só o que o KEEPER ainda não tem vira retirada nova.
const linha = (extra = {}) => ({ pessoa: 'Marcos', sala: 'Sala 12', tipo: 'notebook', quantidade: 1, data_retirada: HOJE, data_devolucao: AMANHA, assinaturas: 2, ...extra });
const folha = (linhas, duvidas = null) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ linhas, duvidas }) }] } }] });
const eq = (id, tipo, estado = 'disponivel', condicao = 'bom') => ({ id, codigo: (tipo === 'notebook' ? 'NB-' : 'TB-') + String(id).padStart(4, '0'), tipo, estado, condicao });
const estoque = [eq(1, 'notebook', 'emprestado'), eq(2, 'notebook', 'disponivel', 'ruim'), eq(4, 'notebook'), eq(3, 'notebook', 'disponivel', 'novo'), eq(5, 'notebook'), eq(6, 'tablet'), eq(7, 'tablet')];
const emp = (pessoa, tipo, previsto_para, id = 1, devolvido_em = null) => ({ id, pessoa, tipo, previsto_para, devolvido_em });

function planeja(linhas, { emprestimos = [{}], sd = {}, itens = estoque, duvidas } = {}) {
  return roda('Planejar', { ctx: { Triagem: { chatId: '42' }, 'Ler folha (Gemini)': folha(linhas, duvidas), Empréstimos: emprestimos }, entrada: itens, sd });
}

test('Planejar: uma retirada nova escolhe os disponíveis de menor código, pula emprestados e em condição ruim, e guarda o pedido', async () => {
  const sd = {};
  const [r] = await planeja([linha({ quantidade: 2 })], { sd });
  assert.match(r.resposta, /1\) NB-0003, NB-0004 para Marcos \(Sala 12\), devolução em/);
  assert.match(r.resposta, /"ok"/);
  assert.doesNotMatch(r.resposta, /⚠/);
  assert.deepEqual(sd.pendente.lends, [{ equipment_ids: [3, 4], pessoa: 'Marcos', setor: 'Sala 12', previsto_para: AMANHA, obs: 'Registrado por foto da folha de retirada' }]);
});

test('Planejar: linhas já registradas (abertas ou devolvidas) são ignoradas e só a nova é proposta', async () => {
  const sd = {};
  const emprestimos = [emp('Marcos', 'notebook', AMANHA, 1), emp('Marcos', 'notebook', AMANHA, 2, HOJE), emp('Ana', 'tablet', AMANHA, 3)];
  const [r] = await planeja([linha({ quantidade: 2 }), linha({ pessoa: 'Ana', tipo: 'tablet' }), linha({ pessoa: 'Carla', tipo: 'tablet', sala: 'Sala 3' })], { sd, emprestimos });
  assert.match(r.resposta, /Retiradas novas \(1\)/);
  assert.match(r.resposta, /TB-0006 para Carla \(Sala 3\)/);
  assert.match(r.resposta, /Já registradas no KEEPER \(ignoradas\): 2/);
  assert.equal(sd.pendente.lends.length, 1);
});

test('Planejar: tolera um erro de leitura no nome e acentos ao reconhecer o que já existe', async () => {
  const emprestimos = [emp('José da Silva Santos', 'notebook', AMANHA)];
  const [r] = await planeja([linha({ pessoa: 'Jose da Silva Santus' })], { emprestimos });
  assert.match(r.resposta, /Nenhuma retirada nova/);
  const [outra] = await planeja([linha({ pessoa: 'Ana' })], { emprestimos: [emp('Ano', 'notebook', AMANHA)] });
  assert.match(outra.resposta, /Retiradas novas \(1\)/); // nomes curtos têm que ser idênticos
});

test('Planejar: retirada parcialmente registrada propõe só o que falta, e linhas repetidas são somadas', async () => {
  const sd = {};
  await planeja([linha({ quantidade: 3 })], { sd, emprestimos: [emp('Marcos', 'notebook', AMANHA)] });
  assert.deepEqual(sd.pendente.lends[0].equipment_ids, [3, 4]);
  const sd2 = {};
  await planeja([linha(), linha()], { sd: sd2, emprestimos: [emp('Marcos', 'notebook', AMANHA)] });
  assert.deepEqual(sd2.pendente.lends[0].equipment_ids, [3]);
});

test('Planejar: devolução já passada é histórico e não vira empréstimo', async () => {
  const sd = {};
  const [r] = await planeja([linha({ data_devolucao: '2020-01-02' }), linha({ pessoa: 'Ana', tipo: 'tablet' })], { sd });
  assert.match(r.resposta, /histórico, ignoradas\): 1/);
  assert.equal(sd.pendente.lends.length, 1);
  const [so] = await planeja([linha({ data_devolucao: '2020-01-02' })]);
  assert.match(so.resposta, /Nenhuma retirada nova/);
});

test('Planejar: várias retiradas novas não repetem equipamento entre si', async () => {
  const sd = {};
  await planeja([linha(), linha({ pessoa: 'Ana', quantidade: 2 })], { sd });
  assert.deepEqual(sd.pendente.lends.map((l) => l.equipment_ids), [[3], [4, 5]]);
});

test('Planejar: estoque insuficiente em qualquer retirada não registra nada', async () => {
  const sd = {};
  const [r] = await planeja([linha({ quantidade: 2 }), linha({ pessoa: 'Ana', quantidade: 2 })], { sd });
  assert.match(r.resposta, /Nada foi registrado/);
  assert.match(r.resposta, /2 notebook\(s\) para Ana \(há 1\)/);
  assert.equal(sd.pendente, undefined);
});

test('Planejar: linha ilegível é reportada e as demais seguem; lixo da IA pede nova foto', async () => {
  const sd = {};
  const [r] = await planeja([linha({ pessoa: null, data_devolucao: null }), linha({ pessoa: 'Ana', tipo: 'tablet' })], { sd });
  assert.match(r.resposta, /linha 1: nome, devolução/);
  assert.match(r.resposta, /Retiradas novas \(1\)/);
  const [lixo] = await roda('Planejar', { ctx: { Triagem: { chatId: '42' }, 'Ler folha (Gemini)': { candidates: [] }, Empréstimos: [{}] }, entrada: estoque, sd: {} });
  assert.match(lixo.resposta, /Tire outra foto/);
  const [vazia] = await planeja([]);
  assert.match(vazia.resposta, /nenhuma linha preenchida/);
});

test('Planejar: avisa sobre assinatura faltando e retirada em outro dia', async () => {
  const sd = {};
  const [r] = await planeja([linha({ assinaturas: 1, data_retirada: '2020-01-01' })], { sd, duvidas: 'sala borrada' });
  assert.match(r.resposta, /Marcos: só 1 de 2 assinaturas/);
  assert.match(r.resposta, /retirada em 01\/01\/2020/);
  assert.match(r.resposta, /sala borrada/);
  assert.match(sd.pendente.lends[0].obs, /Retirada na folha: 01\/01\/2020/);
});

const confirma = (texto, sd) => roda('Confirmar', { ctx: { Triagem: { chatId: '42', texto } }, sd });
const pendente = () => ({ pendente: { expira: Date.now() + 1000, confirmacao: '1) NB-0003 para Marcos', lends: [{ equipment_ids: [3] }, { equipment_ids: [4] }] } });

test('Confirmar: "ok" libera um empréstimo por retirada, uma única vez', async () => {
  const sd = pendente();
  const r = await confirma('ok', sd);
  assert.deepEqual(r.map((i) => i.lend), [{ equipment_ids: [3] }, { equipment_ids: [4] }]);
  assert.equal(sd.pendente, undefined);
  const [de_novo] = await confirma('ok', sd);
  assert.match(de_novo.resposta, /Não há retirada pendente/);
});

test('Confirmar: cancelar, texto qualquer e pedido expirado não registram nada', async () => {
  const sd = pendente();
  const [qualquer] = await confirma('talvez', sd);
  assert.match(qualquer.resposta, /Responda "ok"/);
  assert.ok(sd.pendente);
  const [cancelado] = await confirma('cancelar', sd);
  assert.match(cancelado.resposta, /Cancelado/);
  assert.equal(sd.pendente, undefined);
  const vencido = { pendente: { expira: Date.now() - 1, lends: [{}] } };
  const [r] = await confirma('ok', vencido);
  assert.equal(r.lend, undefined);
  assert.match(r.resposta, /expirou/);
});

test('Pedido à IA envia a foto em base64 e pede JSON com todas as linhas da planilha', async () => {
  const [{ body }] = await roda('Pedido à IA', { binario: { data: { mimeType: 'image/png' } } });
  const [, foto] = body.contents[0].parts;
  assert.equal(foto.inline_data.mime_type, 'image/png');
  assert.equal(foto.inline_data.data, Buffer.from('foto').toString('base64'));
  const esquema = body.generationConfig.responseSchema;
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(esquema.properties.linhas.type, 'ARRAY');
  assert.deepEqual(Object.keys(esquema.properties.linhas.items.properties), ['pessoa', 'sala', 'tipo', 'quantidade', 'data_retirada', 'data_devolucao', 'assinaturas']);
});

test('as ligações do workflow apontam para nós que existem', () => {
  const nomes = new Set(wf.nodes.map((n) => n.name));
  for (const [de, { main }] of Object.entries(wf.connections)) {
    assert.ok(nomes.has(de), de);
    for (const { node } of main.flat()) assert.ok(nomes.has(node), node);
  }
});
