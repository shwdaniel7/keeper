import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, HttpError } from '../db.js';

const novo = (db, serial, extra = {}) => db.create({ tipo: 'notebook', modelo: 'X', serial, ...extra });
const ontem = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv');
};
const amanha = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('sv');
};
const rejeita = (fn, status) => assert.throws(fn, (e) => e instanceof HttpError && e.status === status);

test('serial duplicado é rejeitado (sem diferenciar maiúsculas)', () => {
  const db = openDb(':memory:');
  novo(db, 'ABC');
  rejeita(() => novo(db, 'abc'), 409);
  assert.equal(db.list().length, 1);
});

test('código usa as iniciais do tipo, com contagem por tipo', () => {
  const db = openDb(':memory:');
  assert.equal(novo(db, 'A').codigo, 'NB-0001');
  assert.equal(novo(db, 'B').codigo, 'NB-0002');
  assert.equal(novo(db, 'C', { tipo: 'Tablet' }).codigo, 'TB-0001');
  assert.equal(novo(db, 'D', { tipo: 'Chromebook' }).codigo, 'CB-0001');
});

test('só aceita notebook, tablet e chromebook; tipo não muda na edição', () => {
  const db = openDb(':memory:');
  rejeita(() => novo(db, 'A', { tipo: 'Projetor' }), 400);
  const e = novo(db, 'B');
  rejeita(() => db.update(e.id, { tipo: 'tablet', modelo: 'X', serial: 'B' }), 400);
});

test('cadastro em lote: dados comuns + um serial por item; duplicados são relatados', () => {
  const db = openDb(':memory:');
  novo(db, 'S2');
  const r = db.createMany({ tipo: 'Chromebook', marca: 'Positivo', modelo: 'C1', seriais: ['S1', 'S2', 'S3'] });
  assert.equal(r.importados, 2);
  assert.deepEqual(r.codigos, ['CB-0001', 'CB-0002']);
  assert.deepEqual(r.rejeitadas.map((x) => x.serial), ['S2']);
  rejeita(() => db.createMany({ tipo: 'Chromebook', modelo: '', seriais: ['Z'] }), 400);
});

test('empréstimo em lote é tudo ou nada', () => {
  const db = openDb(':memory:');
  const a = novo(db, 'A'), b = novo(db, 'B'), c = novo(db, 'C');
  db.openTicket({ equipment_id: c.id, descricao: 'x' });
  rejeita(() => db.lend({ equipment_ids: [a.id, b.id, c.id], pessoa: 'Ana', previsto_para: amanha() }), 409);
  assert.equal(db.get(a.id).estado, 'disponivel');
  const r = db.lend({ equipment_ids: [a.id, b.id], pessoa: 'Ana', previsto_para: amanha() });
  assert.equal(r.ids.length, 2);
  assert.equal(db.get(b.id).estado, 'emprestado');
});

test('emprestar item indisponível falha; devolver libera', () => {
  const db = openDb(':memory:');
  const e = novo(db, 'A');
  const loan = db.lend({ equipment_id: e.id, pessoa: 'Ana', previsto_para: amanha() });
  assert.equal(db.get(e.id).estado, 'emprestado');
  rejeita(() => db.lend({ equipment_id: e.id, pessoa: 'Bia', previsto_para: amanha() }), 409);
  db.giveBack(loan.ids[0]);
  assert.equal(db.get(e.id).estado, 'disponivel');
  rejeita(() => db.giveBack(loan.ids[0]), 409);
  db.undoReturn(loan.ids[0]);
  assert.equal(db.get(e.id).estado, 'emprestado');
});

test('chamado → manutenção; resolver → disponível (só quando todos resolvidos)', () => {
  const db = openDb(':memory:');
  const e = novo(db, 'A');
  const t1 = db.openTicket({ equipment_id: e.id, descricao: 'Tela' });
  const t2 = db.openTicket({ equipment_id: e.id, descricao: 'Bateria' });
  assert.equal(db.get(e.id).estado, 'manutencao');
  rejeita(() => db.lend({ equipment_id: e.id, pessoa: 'Ana', previsto_para: amanha() }), 409);
  db.updateTicket(t1.id, { status: 'resolvido' });
  assert.equal(db.get(e.id).estado, 'manutencao');
  db.updateTicket(t2.id, { status: 'resolvido', solucao: 'Trocada' });
  assert.equal(db.get(e.id).estado, 'disponivel');
});

test('não abre chamado em item emprestado; baixa exige devolução', () => {
  const db = openDb(':memory:');
  const e = novo(db, 'A');
  const loan = db.lend({ equipment_id: e.id, pessoa: 'Ana', previsto_para: amanha() });
  rejeita(() => db.openTicket({ equipment_id: e.id, descricao: 'x' }), 409);
  rejeita(() => db.setBaixa(e.id, true), 409);
  db.giveBack(loan.ids[0]);
  assert.equal(db.setBaixa(e.id, true).estado, 'baixado');
  assert.equal(db.setBaixa(e.id, false).estado, 'disponivel');
});

test('atrasados no painel', () => {
  const db = openDb(':memory:');
  const a = novo(db, 'A');
    db.lend({ equipment_id: a.id, pessoa: 'Ana', previsto_para: ontem() });
  const p = db.dashboard();
  assert.equal(p.atrasados.length, 1);
  assert.equal(p.atrasados[0].equipment_id, a.id);
  assert.deepEqual(p.contagem, { disponivel: 0, emprestado: 1, manutencao: 0, baixado: 0 });
});

test('importação relata linhas rejeitadas', () => {
  const db = openDb(':memory:');
  const r = db.importRows([
    { tipo: 'Tablet', modelo: 'P1', serial: 'S1' },
    { tipo: 'Tablet', modelo: 'P2', serial: 'S1' },
    { tipo: 'Tablet', modelo: '', serial: 'S3' },
    { tipo: 'Tablet', modelo: 'P4', serial: 'S4', condicao: 'péssimo' },
  ]);
  assert.equal(r.importados, 1);
  assert.deepEqual(r.rejeitadas.map((x) => x.linha), [3, 4, 5]);
  assert.equal(db.importRows([{ tipo: 'Projetor', modelo: 'M', serial: 'Q' }]).rejeitadas.length, 1);
});

test('renovar muda o prazo, registra evento e dá para reverter', () => {
  const db = openDb(':memory:');
  const e = novo(db, 'A');
  const { ids } = db.lend({ equipment_ids: [e.id], pessoa: 'Ana', previsto_para: amanha() });
  const r = db.renovar([{ id: ids[0], ate: '2099-05-01' }]);
  assert.equal(db.listLoans()[0].previsto_para, '2099-05-01');
  assert.equal(r[0].anterior, amanha());
  assert.ok(db.get(e.id).events.some((v) => v.tipo === 'renovacao'));
  rejeita(() => db.renovar([{ id: ids[0], ate: ontem() }]), 400); // data no passado
  db.renovar([{ id: ids[0], ate: ontem() }], { reverter: true }); // desfazer pode voltar a uma data passada
  assert.equal(db.listLoans()[0].previsto_para, ontem());
  rejeita(() => db.renovar([{ id: 999, ate: '2099-01-01' }]), 404);
  rejeita(() => db.renovar([]), 400);
});

test('renovar em grupo é tudo ou nada; empréstimo devolvido não renova', () => {
  const db = openDb(':memory:');
  const a = novo(db, 'A'), b = novo(db, 'B');
  const { ids } = db.lend({ equipment_ids: [a.id, b.id], pessoa: 'Ana', previsto_para: amanha() });
  db.giveBack(ids[1]);
  rejeita(() => db.renovar(ids.map((id) => ({ id, ate: '2099-01-01' }))), 409);
  assert.equal(db.listLoans().find((l) => l.id === ids[0]).previsto_para, amanha()); // o primeiro não foi alterado
});

test('relatórios e exportação de empréstimos', () => {
  const db = openDb(':memory:');
  const a = novo(db, 'A'), b = novo(db, 'B');
  const l1 = db.lend({ equipment_ids: [a.id], pessoa: 'Ana', setor: 'Sala 1', previsto_para: ontem() });
  db.giveBack(l1.ids[0]);
  db.lend({ equipment_ids: [a.id, b.id], pessoa: 'Ana', setor: 'Sala 1', previsto_para: ontem() });
  db.openTicket({ equipment_id: novo(db, 'C').id, descricao: 'tela' });
  const r = db.relatorios();
  assert.equal(r.totalEmprestimos, 3);
  assert.equal(r.emAtraso, 2);
  assert.equal(r.maisEmprestados[0].codigo, a.codigo);
  assert.equal(r.maisEmprestados[0].n, 2);
  assert.equal(r.porPessoa[0].pessoa, 'Ana');
  assert.equal(r.porSetor[0].setor, 'Sala 1');
  assert.equal(r.maisChamados.length, 1);
  assert.equal(r.porMes[0].n, 3);
  assert.equal(db.exportLoans().length, 3);
  assert.equal(openDb(':memory:').relatorios().diasMedio, null); // banco vazio não quebra
});
