import { createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Formato gerado pelo workflow: salt(16) + iv(12) + tag(16) + dados (AES-256-GCM, chave via scrypt).
export function descriptografar(buf, frase) {
  const decifra = createDecipheriv('aes-256-gcm', scryptSync(frase, buf.subarray(0, 16), 32), buf.subarray(16, 28));
  decifra.setAuthTag(buf.subarray(28, 44));
  return Buffer.concat([decifra.update(buf.subarray(44)), decifra.final()]); // final() lança se a frase estiver errada
}

if (import.meta.filename === process.argv[1]) {
  const [entrada, frase = process.env.KEEPER_FRASE] = process.argv.slice(2);
  if (!entrada?.endsWith('.enc') || !frase) {
    console.error('Uso: node descriptografar.js keeper-AAAA-MM-DD-HHMMSS.db.enc "frase"   (ou defina KEEPER_FRASE)');
    process.exit(1);
  }
  const saida = entrada.slice(0, -4);
  writeFileSync(saida, descriptografar(readFileSync(entrada), frase));
  console.log('Gerado:', saida);
}
