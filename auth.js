import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SENHA_MIN = 10;

// Senha do administrador: scrypt com sal próprio. Formato: scrypt$<sal b64>$<hash b64>
export function hashSenha(senha) {
  const sal = randomBytes(16);
  return `scrypt$${sal.toString('base64')}$${scryptSync(senha, sal, 64).toString('base64')}`;
}

export function confereSenha(senha, guardado) {
  const [alg, salB64, hashB64] = String(guardado ?? '').split('$');
  if (alg !== 'scrypt' || !salB64 || !hashB64) return false;
  const esperado = Buffer.from(hashB64, 'base64');
  const obtido = scryptSync(String(senha ?? ''), Buffer.from(salB64, 'base64'), esperado.length);
  return timingSafeEqual(obtido, esperado);
}

export const senhaValida = (s) => typeof s === 'string' && s.length >= SENHA_MIN;

// Token de sessão: só o hash SHA-256 vai para o banco; o cookie leva o token.
export const tokenNovo = () => randomBytes(32).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(t).digest('hex');

// Comparação de textos em tempo constante (código de configuração).
export function iguais(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Código de uso único para o primeiro acesso (aparece só no console do servidor).
export const codigoNovo = () => randomBytes(5).toString('hex').toUpperCase();

// Limita tentativas por chave (IP). Após `max` falhas na janela, bloqueia por `janelaMs`.
export function limitador({ max = 5, janelaMs = 15 * 60e3 } = {}) {
  const tentativas = new Map();
  return {
    bloqueadoPor(chave, agora = Date.now()) {
      const r = tentativas.get(chave);
      return r && r.ate > agora ? Math.ceil((r.ate - agora) / 1000) : 0;
    },
    falhou(chave, agora = Date.now()) {
      let r = tentativas.get(chave);
      if (!r || agora - r.inicio > janelaMs) r = { n: 0, inicio: agora, ate: 0 };
      r.n++;
      if (r.n >= max) r.ate = agora + janelaMs;
      tentativas.set(chave, r);
    },
    ok(chave) {
      tentativas.delete(chave);
    },
  };
}
