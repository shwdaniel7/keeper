import { DatabaseSync } from 'node:sqlite';

export class HttpError extends Error {
  constructor(status, message, campo) {
    super(message);
    this.status = status;
    this.campo = campo;
  }
}

const FIELDS = ['tipo', 'marca', 'modelo', 'serial', 'condicao', 'notas'];
const CONDICOES = ['novo', 'bom', 'regular', 'ruim'];
const PREFIXOS = { notebook: 'NB', tablet: 'TB', chromebook: 'CB' };
const ESTADOS = ['disponivel', 'emprestado', 'manutencao', 'baixado'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT UNIQUE,
  tipo TEXT NOT NULL CHECK (tipo IN ('notebook','tablet','chromebook')), marca TEXT, modelo TEXT NOT NULL,
  serial TEXT NOT NULL UNIQUE COLLATE NOCASE,
  estado TEXT NOT NULL DEFAULT 'disponivel' CHECK (estado IN ('disponivel','emprestado','manutencao','baixado')),
  condicao TEXT NOT NULL DEFAULT 'bom' CHECK (condicao IN ('novo','bom','regular','ruim')),
  notas TEXT
);
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  pessoa TEXT NOT NULL, setor TEXT,
  retirado_em TEXT NOT NULL, previsto_para TEXT NOT NULL, devolvido_em TEXT, obs TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  descricao TEXT NOT NULL, aberto_em TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','em_reparo','resolvido')),
  resolvido_em TEXT, solucao TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  tipo TEXT NOT NULL, detalhe TEXT, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loans_eq ON loans(equipment_id);
CREATE INDEX IF NOT EXISTS idx_tickets_eq ON tickets(equipment_id);
CREATE INDEX IF NOT EXISTS idx_events_eq ON events(equipment_id);
CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK (id = 1), senha_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expira INTEGER NOT NULL);
`;

const today = () => new Date().toLocaleDateString('sv');
const strip = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const str = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

// Aceita AAAA-MM-DD ou DD/MM/AAAA (planilhas brasileiras).
function toDate(v, campo) {
  v = str(v);
  if (!v) return null;
  const br = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) v = `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) {
    throw new HttpError(400, 'Data inválida (use AAAA-MM-DD ou DD/MM/AAAA)', campo);
  }
  return v;
}

function clean(d) {
  const o = Object.fromEntries(FIELDS.map((f) => [f, str(d[f])]));
  for (const f of ['tipo', 'modelo', 'serial']) if (!o[f]) throw new HttpError(400, 'Obrigatório', f);
  o.tipo = strip(o.tipo);
  if (!PREFIXOS[o.tipo]) throw new HttpError(400, 'Use: notebook, tablet ou chromebook', 'tipo');
  o.condicao = o.condicao ? strip(o.condicao) : 'bom';
  if (!CONDICOES.includes(o.condicao)) throw new HttpError(400, 'Use: novo, bom, regular ou ruim', 'condicao');
  return o;
}

export function openDb(file = process.env.KEEPER_DB || 'keeper.db') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const run = (sql, ...p) => {
    try {
      return db.prepare(sql).run(...p);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Serial já cadastrado', 'serial');
      throw e;
    }
  };
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const event = (id, tipo, detalhe) => run('INSERT INTO events(equipment_id,tipo,detalhe,ts) VALUES(?,?,?,?)', id, tipo, detalhe, new Date().toISOString());
  const setEstado = (id, estado) => run('UPDATE equipment SET estado=? WHERE id=?', estado, id);
  const need = (id) => {
    const e = one('SELECT * FROM equipment WHERE id=?', Number(id));
    if (!e) throw new HttpError(404, 'Equipamento não encontrado');
    return e;
  };

  function list() {
    return all(
      `SELECT e.id, e.codigo, e.tipo, e.marca, e.modelo, e.serial, e.estado, e.condicao, e.notas, l.id AS loan_id, l.pessoa, l.setor, l.previsto_para, (l.previsto_para < ?) AS atrasado
       FROM equipment e LEFT JOIN loans l ON l.equipment_id = e.id AND l.devolvido_em IS NULL ORDER BY e.id`,
      today(),
    );
  }

  function get(id) {
    const e = need(id);
    return {
      ...e,
      events: all('SELECT * FROM events WHERE equipment_id=? ORDER BY id DESC', e.id),
      loans: all('SELECT * FROM loans WHERE equipment_id=? ORDER BY id DESC', e.id),
      tickets: all('SELECT * FROM tickets WHERE equipment_id=? ORDER BY id DESC', e.id),
    };
  }

  function create(data) {
    const o = clean(data);
    return tx(() => {
      const ult = one(`SELECT max(CAST(substr(codigo, 4) AS INTEGER)) n FROM equipment WHERE tipo=?`, o.tipo).n ?? 0;
      const codigo = `${PREFIXOS[o.tipo]}-${String(ult + 1).padStart(4, '0')}`;
      const r = run(`INSERT INTO equipment(codigo,${FIELDS}) VALUES(?,${FIELDS.map(() => '?')})`, codigo, ...FIELDS.map((f) => o[f]));
      const id = Number(r.lastInsertRowid);
      event(id, 'cadastro', 'Equipamento cadastrado');
      return get(id);
    });
  }

  function update(id, data) {
    const old = need(id);
    const o = clean(data);
    if (o.tipo !== old.tipo) throw new HttpError(400, 'O tipo não pode ser alterado (o ID depende dele)', 'tipo');
    return tx(() => {
      run(`UPDATE equipment SET ${FIELDS.map((f) => f + '=?')} WHERE id=?`, ...FIELDS.map((f) => o[f]), old.id);
      const mudou = FIELDS.filter((f) => o[f] !== old[f]);
      if (mudou.length) event(old.id, 'edicao', 'Alterado: ' + mudou.join(', '));
      return get(old.id);
    });
  }

  function setBaixa(id, baixar) {
    const e = need(id);
    return tx(() => {
      if (baixar) {
        if (e.estado === 'emprestado') throw new HttpError(409, 'Registre a devolução antes de baixar');
        if (e.estado === 'baixado') throw new HttpError(409, 'Já baixado');
        run(`UPDATE tickets SET status='resolvido', resolvido_em=?, solucao='Equipamento baixado' WHERE equipment_id=? AND status!='resolvido'`, today(), e.id);
        setEstado(e.id, 'baixado');
        event(e.id, 'baixa', 'Equipamento baixado');
      } else {
        if (e.estado !== 'baixado') throw new HttpError(409, 'Equipamento não está baixado');
        setEstado(e.id, 'disponivel');
        event(e.id, 'reativacao', 'Equipamento reativado');
      }
      return get(e.id);
    });
  }

  // Empréstimo de vários equipamentos de uma vez: tudo ou nada.
  function lend(d) {
    const ids = [...new Set((d.equipment_ids ?? [d.equipment_id]).map(Number))];
    if (!ids.length || ids.some((n) => !Number.isInteger(n))) throw new HttpError(400, 'Selecione ao menos um equipamento', 'ids');
    const pessoa = str(d.pessoa);
    if (!pessoa) throw new HttpError(400, 'Obrigatório', 'pessoa');
    const prev = toDate(d.previsto_para, 'previsto_para');
    if (!prev) throw new HttpError(400, 'Obrigatório', 'previsto_para');
    const itens = ids.map(need);
    const ocupados = itens.filter((e) => e.estado !== 'disponivel');
    if (ocupados.length) throw new HttpError(409, `Indisponíveis: ${ocupados.map((e) => e.codigo).join(', ')}`, 'ids');
    const setor = str(d.setor);
    return tx(() => {
      const loanIds = itens.map((e) => {
        const r = run('INSERT INTO loans(equipment_id,pessoa,setor,retirado_em,previsto_para,obs) VALUES(?,?,?,?,?,?)', e.id, pessoa, setor, today(), prev, str(d.obs));
        setEstado(e.id, 'emprestado');
        event(e.id, 'emprestimo', `Emprestado a ${pessoa}${setor ? ` (${setor})` : ''} até ${prev}`);
        return Number(r.lastInsertRowid);
      });
      return { ids: loanIds, equipment_ids: ids };
    });
  }

  const needLoan = (id) => {
    const l = one('SELECT * FROM loans WHERE id=?', Number(id));
    if (!l) throw new HttpError(404, 'Empréstimo não encontrado');
    return l;
  };

  function giveBack(loanId) {
    const l = needLoan(loanId);
    if (l.devolvido_em) throw new HttpError(409, 'Já devolvido');
    return tx(() => {
      run('UPDATE loans SET devolvido_em=? WHERE id=?', today(), l.id);
      if (need(l.equipment_id).estado === 'emprestado') setEstado(l.equipment_id, 'disponivel');
      event(l.equipment_id, 'devolucao', `Devolvido por ${l.pessoa}`);
      return { equipment_id: l.equipment_id };
    });
  }

  function undoReturn(loanId) {
    const l = needLoan(loanId);
    if (!l.devolvido_em) throw new HttpError(409, 'Empréstimo não foi devolvido');
    if (need(l.equipment_id).estado !== 'disponivel') throw new HttpError(409, 'Equipamento mudou de estado; não dá para desfazer');
    return tx(() => {
      run('UPDATE loans SET devolvido_em=NULL WHERE id=?', l.id);
      setEstado(l.equipment_id, 'emprestado');
      event(l.equipment_id, 'devolucao_desfeita', `Devolução desfeita (${l.pessoa})`);
      return { equipment_id: l.equipment_id };
    });
  }

  function openTicket(d) {
    const e = need(d.equipment_id);
    const descricao = str(d.descricao);
    if (!descricao) throw new HttpError(400, 'Obrigatório', 'descricao');
    if (e.estado === 'emprestado') throw new HttpError(409, 'Registre a devolução antes de abrir o chamado');
    if (e.estado === 'baixado') throw new HttpError(409, 'Equipamento baixado');
    return tx(() => {
      const r = run('INSERT INTO tickets(equipment_id,descricao,aberto_em) VALUES(?,?,?)', e.id, descricao, today());
      setEstado(e.id, 'manutencao');
      event(e.id, 'chamado', `Chamado aberto: ${descricao}`);
      return { id: Number(r.lastInsertRowid), equipment_id: e.id };
    });
  }

  function updateTicket(id, d) {
    const t = one('SELECT * FROM tickets WHERE id=?', Number(id));
    if (!t) throw new HttpError(404, 'Chamado não encontrado');
    if (t.status === 'resolvido') throw new HttpError(409, 'Chamado já resolvido');
    if (!['em_reparo', 'resolvido'].includes(d.status)) throw new HttpError(400, 'Status inválido', 'status');
    return tx(() => {
      if (d.status === 'em_reparo') {
        run(`UPDATE tickets SET status='em_reparo' WHERE id=?`, t.id);
        event(t.equipment_id, 'chamado', `Chamado em reparo: ${t.descricao}`);
      } else {
        run(`UPDATE tickets SET status='resolvido', resolvido_em=?, solucao=? WHERE id=?`, today(), str(d.solucao), t.id);
        event(t.equipment_id, 'chamado', `Chamado resolvido: ${t.descricao}${str(d.solucao) ? ` — ${str(d.solucao)}` : ''}`);
        const restam = one(`SELECT count(*) n FROM tickets WHERE equipment_id=? AND status!='resolvido'`, t.equipment_id).n;
        if (!restam && need(t.equipment_id).estado === 'manutencao') setEstado(t.equipment_id, 'disponivel');
      }
      return { equipment_id: t.equipment_id };
    });
  }

  const listLoans = () =>
    all(
      `SELECT l.*, e.codigo, e.marca, e.modelo, e.tipo, e.serial, (l.devolvido_em IS NULL AND l.previsto_para < ?) AS atrasado
       FROM loans l JOIN equipment e ON e.id = l.equipment_id
       ORDER BY (l.devolvido_em IS NULL) DESC, CASE WHEN l.devolvido_em IS NULL THEN l.previsto_para END ASC, l.id DESC`,
      today(),
    );

  const listTickets = () =>
    all(
      `SELECT t.*, e.codigo, e.marca, e.modelo FROM tickets t JOIN equipment e ON e.id = t.equipment_id
       ORDER BY (t.status = 'resolvido'), t.aberto_em, t.id DESC`,
    );

  function dashboard() {
    const t = today();
    const contagem = Object.fromEntries(ESTADOS.map((s) => [s, 0]));
    for (const r of all('SELECT estado, count(*) n FROM equipment GROUP BY estado')) contagem[r.estado] = r.n;
    return {
      contagem,
      atrasados: all(
        `SELECT l.id AS loan_id, l.pessoa, l.setor, l.previsto_para, e.id AS equipment_id, e.codigo, e.marca, e.modelo
         FROM loans l JOIN equipment e ON e.id = l.equipment_id
         WHERE l.devolvido_em IS NULL AND l.previsto_para < ? ORDER BY l.previsto_para`,
        t,
      ),
      chamados: all(
        `SELECT t.id, t.descricao, t.status, t.aberto_em, e.id AS equipment_id, e.codigo, e.marca, e.modelo
         FROM tickets t JOIN equipment e ON e.id = t.equipment_id WHERE t.status != 'resolvido' ORDER BY t.aberto_em`,
      ),
    };
  }

  function importRows(rows, primeiraLinha = 2) {
    if (!Array.isArray(rows) || rows.length > 5000) throw new HttpError(400, 'Envie até 5000 linhas');
    const rejeitadas = [];
    const codigos = [];
    rows.forEach((r, i) => {
      try {
        codigos.push(create(r).codigo);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        const campo = e.campo ? ` (${e.campo})` : '';
        rejeitadas.push({ linha: i + primeiraLinha, serial: str(r.serial), motivo: e.message + campo }); // CSV: linha 1 = cabeçalho
      }
    });
    return { importados: codigos.length, codigos, rejeitadas };
  }

  // Cadastro em lote: dados comuns uma vez, um serial por equipamento.
  function createMany({ seriais, ...comum }) {
    if (!Array.isArray(seriais) || !seriais.length) throw new HttpError(400, 'Informe ao menos um serial', 'seriais');
    clean({ ...comum, serial: 'x' }); // erros de tipo/modelo/condição aparecem uma vez só
    return importRows(seriais.map((serial) => ({ ...comum, serial })), 1);
  }

  // Renova o prazo de um ou mais empréstimos (tudo ou nada). Devolve as datas anteriores para desfazer.
  function renovar(itens, { reverter = false } = {}) {
    if (!Array.isArray(itens) || !itens.length) throw new HttpError(400, 'Selecione ao menos um empréstimo', 'ids');
    return tx(() =>
      itens.map(({ id, ate }) => {
        const l = one('SELECT * FROM loans WHERE id=?', Number(id));
        if (!l) throw new HttpError(404, 'Empréstimo não encontrado');
        if (l.devolvido_em) throw new HttpError(409, `${l.pessoa}: empréstimo já devolvido`);
        const nova = toDate(ate, 'ate');
        if (!nova) throw new HttpError(400, 'Obrigatório', 'ate');
        if (!reverter && nova < today()) throw new HttpError(400, 'A nova data já passou', 'ate');
        run('UPDATE loans SET previsto_para=? WHERE id=?', nova, l.id);
        event(l.equipment_id, reverter ? 'renovacao_desfeita' : 'renovacao', `${reverter ? 'Renovação desfeita' : 'Prazo renovado'} até ${nova} (${l.pessoa})`);
        return { id: l.id, anterior: l.previsto_para };
      }),
    );
  }

  function relatorios() {
    const t = today();
    return {
      totalEmprestimos: one('SELECT count(*) n FROM loans').n,
      diasMedio: one('SELECT avg(julianday(devolvido_em) - julianday(retirado_em)) d FROM loans WHERE devolvido_em IS NOT NULL').d,
      emAtraso: one('SELECT count(*) n FROM loans WHERE devolvido_em IS NULL AND previsto_para < ?', t).n,
      maisEmprestados: all(`SELECT e.codigo, e.marca, e.modelo, count(l.id) n FROM loans l JOIN equipment e ON e.id = l.equipment_id GROUP BY e.id ORDER BY n DESC, e.codigo LIMIT 10`),
      maisChamados: all(`SELECT e.codigo, e.marca, e.modelo, count(t.id) n FROM tickets t JOIN equipment e ON e.id = t.equipment_id GROUP BY e.id ORDER BY n DESC, e.codigo LIMIT 10`),
      porPessoa: all(`SELECT pessoa, count(*) n FROM loans GROUP BY pessoa ORDER BY n DESC, pessoa LIMIT 10`),
      porSetor: all(`SELECT setor, count(*) n FROM loans WHERE setor IS NOT NULL GROUP BY setor ORDER BY n DESC, setor LIMIT 10`),
      porMes: all(
        `SELECT substr(retirado_em, 1, 7) mes, count(*) n,
                sum(CASE WHEN (devolvido_em IS NULL AND previsto_para < ?) OR devolvido_em > previsto_para THEN 1 ELSE 0 END) atrasados
         FROM loans GROUP BY mes ORDER BY mes DESC LIMIT 12`,
        t,
      ),
    };
  }

  // Restaura os dados de um backup (arquivo SQLite). Sessões e senha do administrador não são trocadas.
  function restaurar(arquivo) {
    try {
      run('ATTACH DATABASE ? AS src', arquivo);
    } catch {
      throw new HttpError(400, 'Arquivo não é um backup válido');
    }
    try {
      const tabelas = all(`SELECT name FROM src.sqlite_master WHERE type='table'`).map((r) => r.name);
      if (!['equipment', 'loans', 'tickets', 'events'].every((t) => tabelas.includes(t))) throw new HttpError(400, 'Arquivo não é um backup do KEEPER');
      tx(() => {
        for (const t of ['events', 'tickets', 'loans', 'equipment']) db.exec(`DELETE FROM ${t}`);
        db.exec(`INSERT INTO equipment (id,codigo,tipo,marca,modelo,serial,estado,condicao,notas) SELECT id,codigo,tipo,marca,modelo,serial,estado,condicao,notas FROM src.equipment`);
        db.exec(`INSERT INTO loans (id,equipment_id,pessoa,setor,retirado_em,previsto_para,devolvido_em,obs) SELECT id,equipment_id,pessoa,setor,retirado_em,previsto_para,devolvido_em,obs FROM src.loans`);
        db.exec(`INSERT INTO tickets (id,equipment_id,descricao,aberto_em,status,resolvido_em,solucao) SELECT id,equipment_id,descricao,aberto_em,status,resolvido_em,solucao FROM src.tickets`);
        db.exec(`INSERT INTO events (id,equipment_id,tipo,detalhe,ts) SELECT id,equipment_id,tipo,detalhe,ts FROM src.events`);
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'Arquivo não é um backup válido');
    } finally {
      db.exec('DETACH DATABASE src');
    }
  }

  // Autenticação do administrador (única credencial).
  const senhaHash = () => one('SELECT senha_hash FROM admin WHERE id=1')?.senha_hash ?? null;
  const definirSenha = (hash) => run('INSERT INTO admin(id, senha_hash) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET senha_hash=excluded.senha_hash', hash);
  const criarSessao = (tokenHash, expira) => run('INSERT INTO sessions(token_hash, expira) VALUES(?, ?)', tokenHash, expira);
  // Renova a sessão (janela deslizante) se ainda estiver válida.
  const sessaoValida = (tokenHash, agora, novaExpira) => run('UPDATE sessions SET expira=? WHERE token_hash=? AND expira>?', novaExpira, tokenHash, agora).changes > 0;
  const apagarSessao = (tokenHash) => run('DELETE FROM sessions WHERE token_hash=?', tokenHash);
  const apagarSessoes = () => run('DELETE FROM sessions');
  const limparSessoes = (agora) => run('DELETE FROM sessions WHERE expira<=?', agora);

  const exportInventory = () => list().map(({ loan_id, setor, atrasado, ...e }) => e);
  const exportHistory = () =>
    all(`SELECT e.codigo, e.serial, ev.ts, ev.tipo, ev.detalhe FROM events ev JOIN equipment e ON e.id = ev.equipment_id ORDER BY ev.id`);
  const exportLoans = () =>
    all(`SELECT e.codigo, e.tipo, e.marca, e.modelo, e.serial, l.pessoa, l.setor, l.retirado_em, l.previsto_para, l.devolvido_em
         FROM loans l JOIN equipment e ON e.id = l.equipment_id ORDER BY l.id`);

  return {
    conn: db,
    close: () => db.close(),
    list, get, create, update, setBaixa, createMany, lend, giveBack, undoReturn, openTicket, updateTicket,
    listLoans, listTickets, dashboard, importRows, renovar, relatorios, restaurar,
    senhaHash, definirSenha, criarSessao, sessaoValida, apagarSessao, apagarSessoes, limparSessoes,
    exportInventory, exportHistory, exportLoans,
  };
}
