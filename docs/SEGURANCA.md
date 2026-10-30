# Segurança do KEEPER

## Modelo
Uma única pessoa (o administrador) usa o sistema. Quem pega equipamento emprestado não tem conta nem acesso; recebe só o termo impresso. Por isso há uma única credencial e nenhum cadastro de usuários. O que protege os dados é a senha e as defesas abaixo.

## O que está protegido, e como
| Ameaça | Defesa |
|---|---|
| Acesso aos dados sem login | Toda rota `/api/*` exige sessão, exceto `status`, `login`, `setup` e `logout` (e `/healthz`, que não devolve dados). Os arquivos estáticos do app são públicos; eles não contêm dados |
| Senha vazada do banco | Senha guardada com `scrypt` (sal próprio por senha), nunca em texto |
| Roubo de sessão pelo banco | O banco guarda só o hash SHA-256 do token; o token real fica só no cookie |
| Roubo do cookie por script | Cookie `HttpOnly`; `SameSite=Strict`; `Secure` quando `KEEPER_HTTPS=1`; validade de 7 dias, renovada a cada uso |
| Adivinhar a senha | 5 erros por IP bloqueiam por 15 minutos (resposta 429), inclusive a senha certa durante o bloqueio |
| Tomar o servidor no primeiro acesso | Criar a senha exige um código de uso único impresso só no console do servidor |
| CSRF (outro site mandando comandos) | `SameSite=Strict` + escritas só aceitam `application/json` (formulários de outros sites não conseguem) |
| DNS rebinding | Só aceita os `Host` listados em `KEEPER_ORIGIN` |
| Script injetado (XSS) | Todo texto é escapado ao montar o HTML; Content-Security-Policy (`script-src 'self'`), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` |
| Downgrade para HTTP | `Strict-Transport-Security` quando `KEEPER_HTTPS=1` |
| Ler arquivos do servidor pela URL | Caminho estático confinado a `public/`; nomes de backup só aceitos no padrão `keeper-AAAA-MM-DD-HHMMSS.db` |
| Planilha maliciosa no CSV exportado | Células iniciadas por `=`, `+`, `-` ou `@` recebem apóstrofo |
| Perder tudo | Backup diário automático, restauração com cópia de segurança prévia |
| Trocar a senha e continuar exposto | Trocar a senha encerra todas as sessões |

## O que NÃO está protegido (limites conhecidos)
- **Sem segundo fator.** A segurança depende da senha. Use uma frase longa e única.
- **Limite de tentativas é por IP e fica em memória:** reinicia quando o servidor reinicia, e um atacante com muitos IPs contorna. É defesa contra tentativa simples, não contra ataque distribuído.
- **Sem registro de auditoria** de logins ou de quem mudou o quê (o histórico de cada equipamento registra as ações, mas não registra login).
- **`KEEPER_ADMIN_PASSWORD`** fica visível no ambiente enquanto estiver no `.env`. Use só para o primeiro start e apague.
- **O código de configuração aparece no log.** Quem lê os logs do servidor antes de você criar a senha consegue criá-la. Crie a senha logo após subir.
- **Backups não são criptografados.** Eles contêm os dados e, na tabela `admin`, o hash da senha. Guarde as cópias em lugar protegido.
- **O QR só carrega um endereço.** Quem escaneia sem estar logado vê a tela de login; os dados continuam protegidos. O QR revela o endereço do sistema para quem o ler.
- **`style-src 'unsafe-inline'`** na CSP, porque a interface usa atributos `style`. Scripts continuam restritos a `'self'`.
- **Sessões não têm "sair de todos os aparelhos"** além de trocar a senha.

## Recomendações
1. Mantenha `HOST=127.0.0.1` (padrão): o app não deve ficar exposto na rede.
2. Copie `backups/` periodicamente para outro disco ou nuvem.
3. Não compartilhe a senha; para dar acesso a mais alguém, o sistema precisaria ganhar contas separadas (fora do escopo atual).
