# KEEPER

Sistema de controle de equipamentos de TI (notebooks, tablets e chromebooks): inventário, empréstimos, manutenção, etiquetas com QR, termo de empréstimo impresso e relatórios.

Projeto de portfólio feito sem nenhuma dependência npm: backend em Node.js puro com `node:sqlite` embutido, e frontend em HTML, CSS e JavaScript puros (incluindo o gerador de QR Code, escrito do zero).

![Node](https://img.shields.io/badge/Node%20js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![SQLite](https://img.shields.io/badge/Sqlite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![HTML](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)
![CSS](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-323330?style=for-the-badge&logo=javascript&logoColor=F7DF1E)

## Por que existe

Planilhas não dizem quem está com qual notebook, o que está atrasado nem o histórico de cada máquina. O KEEPER responde isso em poucos cliques. Foi feito para um único administrador de TI: quem pega o equipamento emprestado não tem conta, recebe só o termo impresso.

## Destaques técnicos

- **Zero dependências:** só a biblioteca padrão do Node, sem `npm install`.
- **Segurança:** senha com `scrypt`, sessão guardada como hash SHA-256, cookie `HttpOnly` + `SameSite=Strict`, limite de tentativas de login, proteção contra CSRF, DNS rebinding e XSS, Content-Security-Policy, exportação CSV protegida contra injeção de fórmulas. Detalhes e limites conhecidos em [docs/SEGURANCA.md](docs/SEGURANCA.md).
- **Regras de negócio no banco:** máquina de estados do equipamento (disponível, emprestado, manutenção…), empréstimos em lote com semântica "tudo ou nada" e histórico completo por item.
- **Backup e restauração:** cópia diária automática (`VACUUM INTO`), rotação das últimas 14, e restauração que salva o estado atual antes de sobrescrever.
- **Gerador de QR Code próprio** ([public/qr.js](public/qr.js)), com testes, usado nas etiquetas imprimíveis.
- **Interface sem framework:** SPA com roteamento por hash, templates com escape automático, atalhos de teclado, animações com molas ([public/spring.js](public/spring.js)) e respeito a `prefers-reduced-motion`.
- **37 testes** com `node --test`, incluindo um servidor HTTP real.

## Funcionalidades

| Tela | Para quê |
|---|---|
| Visão geral | Contagem por estado, empréstimos atrasados (*Copiar cobrança*, *Renovar*, *Devolver*) e chamados abertos |
| Inventário | Busca instantânea (ID, serial, modelo, pessoa), filtros por estado e tipo, seleção múltipla, *Emprestar* e *Devolver* direto na linha |
| Empréstimos | Em andamento (itens emprestados juntos ficam agrupados), renovação, termo imprimível, *Devolver todos* |
| Manutenção | Abrir, pôr em reparo e resolver chamados |
| Etiquetas | Folha A4 com o QR de cada equipamento, pronta para imprimir |
| Relatórios | Mais emprestados, mais chamados, por pessoa, por setor, por mês, tempo médio de empréstimo |
| Importar CSV | Pré-visualização, mapeamento de colunas e relatório de linhas rejeitadas (há um [exemplo](public/exemplo.csv)) |
| Configurações | Backups (criar, baixar, restaurar) e troca de senha |

**IDs:** três tipos, com contagem separada: Notebook (`NB-0001`), Tablet (`TB-0001`) e Chromebook (`CB-0001`). O tipo não muda depois do cadastro, porque o ID depende dele.

**Em lote:** cadastre dezenas de equipamentos colando uma coluna de seriais do Excel; empréstimo de vários itens de uma vez.

**Atalhos:** `/` buscar · `N` novo equipamento · `Esc` fechar o painel · `↑ ↓` navegar pela lista · `Enter` na busca abre o primeiro resultado.

## Como rodar

Requer Node 22.13 ou superior (testado no Node 26).

```bash
git clone https://github.com/shwdaniel7/keeper.git
cd keeper
node server.js        # http://127.0.0.1:3000
node --test           # roda os testes
```

**Primeiro acesso:** enquanto não existe senha, o servidor imprime no console um código de configuração (`Código de configuração: XXXXXXXXXX`). Abra o endereço, informe o código e crie a senha do administrador (mínimo 10 caracteres). O código vale uma única vez. Alternativa: defina `KEEPER_ADMIN_PASSWORD` antes de iniciar.

### Variáveis de ambiente (todas opcionais)

| Variável | Padrão | Função |
|---|---|---|
| `HOST` | `127.0.0.1` | Endereço de escuta |
| `PORT` | `3000` | Porta |
| `KEEPER_DATA` | pasta do projeto | Onde ficam `keeper.db` e `backups/` |
| `KEEPER_DB` | `$KEEPER_DATA/keeper.db` | Caminho do banco (os testes usam `:memory:`) |
| `KEEPER_ORIGIN` | `localhost,127.0.0.1` | Hosts aceitos, separados por vírgula |
| `KEEPER_HTTPS` | desligado | `1` atrás de HTTPS: cookie `Secure` e HSTS |
| `TRUST_PROXY` | desligado | `1` atrás de proxy reverso: usa o IP de `X-Forwarded-For` |
| `KEEPER_ADMIN_PASSWORD` | vazio | Define a senha do administrador no primeiro start |
| `KEEPER_SEM_BACKUP` | vazio | Qualquer valor desliga o backup automático |

## Backup

- Uma cópia automática por dia em `backups/` (ao iniciar e a cada 6 h, se ainda não houver a de hoje); ficam as últimas 14.
- Em *Configurações* dá para criar, baixar e restaurar. Antes de restaurar, o estado atual é salvo; a senha e as sessões não mudam.
- O app roda só localmente. Copie `backups/` e `keeper.db` periodicamente para outro disco ou nuvem: os backups automáticos ficam na mesma máquina do banco.

## Estrutura

```
server.js     HTTP, rotas /api, sessão, cabeçalhos de segurança
db.js         schema, regras de estado, relatórios, restauração
auth.js       senha (scrypt), token de sessão, limite de tentativas
backup.js     backup (VACUUM INTO), rotação, backup diário
public/       index.html, app.css, app.js, spring.js (molas), qr.js (gerador de QR)
test/         node --test: api, auth, backup, qr, http
docs/         PLANO.md (decisões), SEGURANCA.md (modelo de ameaças)
```

## Documentação

- [Modelo de segurança e limitações](docs/SEGURANCA.md)

## Limites conhecidos

Projeto pensado para um único administrador em uso local: não há contas múltiplas, segundo fator nem log de auditoria de logins. A lista completa está em [docs/SEGURANCA.md](docs/SEGURANCA.md).

## Licença

[MIT](LICENSE)
