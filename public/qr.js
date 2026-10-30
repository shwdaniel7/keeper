// Gerador de QR Code: modo byte, correção M, versões 1 a 10. Sem dependências.
// Segue a especificação ISO/IEC 18004 (mesma estrutura do gerador de referência de Nayuki).

const EC_CW = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // codewords de correção por bloco (M)
const BLOCOS = [0, 1, 1, 1, 2, 2, 4, 4, 2, 3, 4]; // blocos por versão (M)
const ALINHAMENTO = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const FORMATO_M = 0; // bits do nível M no campo de formato

const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

const tamanho = (v) => v * 4 + 17;
const codewordsBrutos = (v) => {
  const s = tamanho(v);
  let m = (16 * v + 128) * v + 64; // módulos de dados (inclui padrões de alinhamento e temporização)
  if (v >= 2) {
    const alinhamentos = Math.floor(v / 7) + 2;
    m -= (25 * alinhamentos - 10) * alinhamentos - 55;
    if (v >= 7) m -= 36;
  }
  return Math.floor(m / 8);
};
const codewordsDados = (v) => codewordsBrutos(v) - EC_CW[v] * BLOCOS[v];
const capacidadeBytes = (v) => Math.floor((codewordsDados(v) * 8 - 4 - (v <= 9 ? 8 : 16)) / 8);

// Código BCH do campo de formato (5 bits de dados + 10 de correção, máscara 0x5412).
export function formatoBits(mascara) {
  const dados = (FORMATO_M << 3) | mascara;
  let rem = dados;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((dados << 10) | rem) ^ 0x5412;
}

// Posições [x, y, escuro] dos 15 bits de formato (duas cópias) e do módulo escuro fixo.
function modulosFormato(n, mascara) {
  const b = formatoBits(mascara);
  const bit = (i) => ((b >>> i) & 1) === 1;
  const m = [];
  for (let i = 0; i <= 5; i++) m.push([8, i, bit(i)]);
  m.push([8, 7, bit(6)], [8, 8, bit(7)], [7, 8, bit(8)]);
  for (let i = 9; i < 15; i++) m.push([14 - i, 8, bit(i)]);
  for (let i = 0; i < 8; i++) m.push([n - 1 - i, 8, bit(i)]);
  for (let i = 8; i < 15; i++) m.push([8, n - 15 + i, bit(i)]);
  m.push([8, n - 8, true]);
  return m;
}

function versaoBits(v) {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (v << 12) | rem;
}

// Polinômio gerador de Reed-Solomon (grau n), coeficientes em ordem crescente.
function geradorRS(n) {
  let c = [1];
  for (let i = 0; i < n; i++) {
    const r = EXP[i];
    const prox = new Array(c.length + 1).fill(0);
    for (let k = 0; k < c.length; k++) {
      prox[k + 1] ^= c[k];
      prox[k] ^= gmul(c[k], r);
    }
    c = prox;
  }
  return c;
}

function correcaoRS(dados, n) {
  const g = geradorRS(n);
  const resto = new Array(n).fill(0);
  for (const b of dados) {
    const fator = b ^ resto.shift();
    resto.push(0);
    for (let i = 0; i < n; i++) resto[i] ^= gmul(g[n - 1 - i], fator);
  }
  return resto;
}

function codificarBytes(bytes, v) {
  const bits = [];
  const empurra = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  empurra(0b0100, 4); // modo byte
  empurra(bytes.length, v <= 9 ? 8 : 16);
  for (const b of bytes) empurra(b, 8);
  const cap = codewordsDados(v) * 8;
  empurra(0, Math.min(4, cap - bits.length)); // terminador
  empurra(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) empurra(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  return out;
}

// Divide os dados em blocos, calcula a correção e intercala tudo.
function intercalar(dados, v) {
  const nb = BLOCOS[v];
  const ec = EC_CW[v];
  const total = codewordsBrutos(v);
  const curtos = nb - (total % nb);
  const tamCurto = Math.floor(total / nb);
  const blocos = [];
  let k = 0;
  for (let i = 0; i < nb; i++) {
    const len = tamCurto - ec + (i < curtos ? 0 : 1);
    const d = dados.slice(k, k + len);
    k += len;
    blocos.push({ d, e: correcaoRS(d, ec) });
  }
  const out = [];
  const maxD = Math.max(...blocos.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocos) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocos) out.push(b.e[i]);
  return out;
}

const MASCARAS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalidade(g) {
  const n = g.length;
  let p = 0;
  // Sequências de 5+ módulos iguais, em linhas e colunas
  for (let a = 0; a < n; a++) {
    for (const lin of [true, false]) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const atual = lin ? g[a][b] : g[b][a];
        const anterior = lin ? g[a][b - 1] : g[b - 1][a];
        if (atual === anterior) run++;
        else {
          if (run >= 5) p += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) p += 3 + (run - 5);
    }
  }
  // Blocos 2x2 iguais
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const c = g[y][x];
      if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) p += 3;
    }
  // Padrões parecidos com marcador (1011101 cercado de claros)
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const casa = (seq, pad) => pad.every((v, i) => (seq[i] ? 1 : 0) === v);
  for (let a = 0; a < n; a++)
    for (let b = 0; b + 11 <= n; b++) {
      const linha = g[a].slice(b, b + 11);
      const coluna = g.slice(b, b + 11).map((r) => r[a]);
      if (casa(linha, A) || casa(linha, B)) p += 40;
      if (casa(coluna, A) || casa(coluna, B)) p += 40;
    }
  // Proporção de escuros
  const escuros = g.reduce((s, r) => s + r.filter(Boolean).length, 0);
  const total = n * n;
  p += (Math.ceil(Math.abs(escuros * 20 - total * 10) / total) - 1) * 10;
  return p;
}

function montar(v, codewords) {
  const n = tamanho(v);
  const g = Array.from({ length: n }, () => new Array(n).fill(null));
  const fixo = Array.from({ length: n }, () => new Array(n).fill(false));
  const grava = (x, y, escuro) => {
    g[y][x] = escuro;
    fixo[y][x] = true;
  };

  // Temporização
  for (let i = 0; i < n; i++) {
    grava(6, i, i % 2 === 0);
    grava(i, 6, i % 2 === 0);
  }
  // Marcadores de canto (desenhados depois da temporização, por cima dela)
  const marcador = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        grava(x, y, d !== 2 && d !== 4);
      }
  };
  marcador(3, 3);
  marcador(n - 4, 3);
  marcador(3, n - 4);
  // Alinhamento
  const pos = ALINHAMENTO[v];
  for (let i = 0; i < pos.length; i++)
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) grava(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  // Reserva as áreas de formato e versão (valores finais do formato são escritos depois)
  for (const [x, y, e] of modulosFormato(n, 0)) grava(x, y, e);
  if (v >= 7) {
    const b = versaoBits(v);
    for (let i = 0; i < 18; i++) {
      const bit = ((b >>> i) & 1) === 1;
      const a = n - 11 + (i % 3), c = Math.floor(i / 3);
      grava(a, c, bit);
      grava(c, a, bit);
    }
  }
  // Dados em ziguezague a partir do canto inferior direito
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  let k = 0;
  for (let direita = n - 1; direita >= 1; direita -= 2) {
    if (direita === 6) direita = 5;
    for (let vert = 0; vert < n; vert++)
      for (let j = 0; j < 2; j++) {
        const x = direita - j;
        const subindo = ((direita + 1) & 2) === 0;
        const y = subindo ? n - 1 - vert : vert;
        if (!fixo[y][x] && k < bits.length) g[y][x] = bits[k++] === 1;
      }
  }
  // Escolhe a máscara de menor penalidade
  let melhor = null;
  for (let m = 0; m < 8; m++) {
    const grade = g.map((linha, y) => linha.map((c, x) => (!fixo[y][x] && MASCARAS[m](x, y) ? !c : c)));
    for (const [x, y, e] of modulosFormato(n, m)) grade[y][x] = e;
    const pen = penalidade(grade);
    if (!melhor || pen < melhor.pen) melhor = { pen, grade };
  }
  return melhor.grade;
}

export const _teste = { correcaoRS, gmul, EXP, codewordsBrutos, intercalar, codificarBytes };

// Matriz booleana (true = escuro) do QR que codifica `texto`.
export function qrMatriz(texto) {
  const bytes = [...new TextEncoder().encode(texto)];
  let v = 1;
  while (v <= 10 && bytes.length > capacidadeBytes(v)) v++;
  if (v > 10) throw new Error('Texto longo demais para o QR');
  const dados = codificarBytes(bytes, v);
  return montar(v, intercalar(dados, v));
}

export function qrSvg(texto, borda = 2) {
  const m = qrMatriz(texto);
  const n = m.length + borda * 2;
  let d = '';
  m.forEach((linha, y) => linha.forEach((escuro, x) => {
    if (escuro) d += `M${x + borda} ${y + borda}h1v1h-1z`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR Code"><path fill="#000" d="${d}"/></svg>`;
}
