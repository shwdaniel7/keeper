import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './db.js';

const KEEP = 14;
export const PADRAO_NOME = /^keeper-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.db$/;

const p2 = (n) => String(n).padStart(2, '0');
function carimbo() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

// Cópia consistente com o app em uso (VACUUM INTO). Mantém só as últimas KEEP.
export function criarBackup(conn, dir) {
  mkdirSync(dir, { recursive: true });
  const base = `keeper-${carimbo()}`;
  let nome = `${base}.db`;
  for (let n = 2; existsSync(join(dir, nome)); n++) nome = `${base}-${n}.db`;
  conn.prepare('VACUUM INTO ?').run(join(dir, nome));
  for (const antigo of listarBackups(dir).slice(KEEP)) unlinkSync(join(dir, antigo.nome));
  return nome;
}

// Mais recentes primeiro (o nome começa com a data e hora).
export function listarBackups(dir) {
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .filter((n) => PADRAO_NOME.test(n))
    .sort()
    .reverse()
    .map((nome) => ({ nome, tamanho: statSync(join(dir, nome)).size }));
}

export function caminhoBackup(dir, nome) {
  if (!PADRAO_NOME.test(nome)) throw new HttpError(400, 'Nome de backup inválido');
  return join(dir, nome);
}

// Um backup por dia: se já existe algum com a data de hoje, não cria outro.
export function backupDoDia(conn, dir) {
  const hoje = new Date().toLocaleDateString('sv');
  if (listarBackups(dir).some((b) => b.nome.startsWith(`keeper-${hoje}`))) return null;
  return criarBackup(conn, dir);
}

export function iniciarBackupAutomatico(conn, dir, intervaloMs = 6 * 3600e3) {
  const roda = () => {
    try {
      backupDoDia(conn, dir);
    } catch (e) {
      console.error('Backup automático falhou:', e.message);
    }
  };
  roda();
  return setInterval(roda, intervaloMs).unref();
}
