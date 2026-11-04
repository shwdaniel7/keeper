# Backup do KEEPER na nuvem (n8n)

Todo dia às 03:00, o n8n faz login no KEEPER, pede um backup novo, **criptografa** o arquivo e envia para um chat privado do Telegram. Se qualquer etapa falhar, você recebe um aviso no mesmo chat.

```
Agenda → Config → Login → Criar backup → Baixar → Criptografar → Telegram → Logout
                                  (qualquer erro) → aviso no Telegram
```

O KEEPER não muda: continua local, em `127.0.0.1`. O n8n roda na mesma máquina e só o arquivo criptografado sai dela.

**Por que criptografar:** o backup contém o hash da senha do administrador e os nomes de quem pegou equipamentos. A frase de criptografia fica só com você; sem ela o arquivo no Telegram não abre.

**Por que Telegram:** é de graça, sem OAuth (o Google Drive exige criar um projeto no Google Cloud) e guarda o histórico sem precisar de rotina de limpeza. Limite: 50 MB por arquivo, e o banco do KEEPER é bem menor que isso. Para usar Google Drive ou S3, troque só o nó "Enviar ao Telegram".

**Por que um Debian ligado 24 h:** num computador que desliga ou dorme, o backup das 03:00 não roda. KEEPER e n8n precisam ficar na mesma máquina, porque o KEEPER só escuta em `127.0.0.1`.

## Passo a passo (tudo no Debian, do zero)

Faça tudo no notebook Debian, em um terminal e no navegador dele. Os comandos com `sudo` pedem a sua senha.

### 1. Instalar os programas

```bash
sudo apt update
sudo apt install -y git curl docker.io
sudo systemctl enable --now docker
```

O KEEPER exige **Node 22.13 ou superior**, e o Debian costuma trazer um mais antigo. Instale o Node 22 pela NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # precisa mostrar v22.13 ou maior
```

### 2. Baixar o KEEPER

Troque `NOME_DA_BRANCH` pela branch que você criou:

```bash
cd ~
git clone -b NOME_DA_BRANCH https://github.com/shwdaniel7/keeper.git
cd keeper
node --test      # opcional: confirma que tudo funciona nesta máquina (uns 12 s)
```

Se já usava o KEEPER em outro computador e quer manter os dados, copie o `keeper.db` e a pasta `backups/` dele para dentro de `~/keeper` agora (pendrive, `scp`, etc.).

### 3. Deixar o KEEPER rodando sozinho

Este bloco cria o serviço com o seu usuário e as pastas atuais (rode dentro de `~/keeper`) e o liga:

```bash
sudo tee /etc/systemd/system/keeper.service >/dev/null <<EOF
[Unit]
Description=KEEPER
After=network.target

[Service]
User=$USER
WorkingDirectory=$PWD
ExecStart=$(command -v node) server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now keeper
sudo systemctl status keeper      # deve mostrar "active (running)"; saia com q
```

A partir de agora ele sobe junto com o notebook.

**Primeiro acesso (só se não copiou um `keeper.db`):** veja o código de configuração e use-o em <http://localhost:3000> para criar a senha do administrador (mínimo 10 caracteres):

```bash
sudo journalctl -u keeper | grep Código
```

### 4. Subir o n8n

Com `--network host` ele enxerga o KEEPER em `127.0.0.1:3000`, então nada precisa ser configurado entre os dois. `N8N_LISTEN_ADDRESS` o deixa acessível só pelo próprio notebook, `NODE_FUNCTION_ALLOW_BUILTIN` libera o `crypto` para o nó de criptografia, e o fuso evita que o "03:00" rode em UTC:

```bash
sudo docker run -d --name n8n --restart unless-stopped --network host \
  -v n8n_data:/home/node/.n8n \
  -e NODE_FUNCTION_ALLOW_BUILTIN=crypto \
  -e N8N_LISTEN_ADDRESS=127.0.0.1 \
  -e GENERIC_TIMEZONE=America/Sao_Paulo -e TZ=America/Sao_Paulo \
  docker.n8n.io/n8nio/n8n
```

Espere uns 20 segundos e abra <http://localhost:5678> no navegador. Na primeira vez, crie a conta de dono (e-mail e senha locais, só valem para o seu n8n). Se a página não abrir, veja `sudo docker logs n8n`.

Seus workflows e credenciais ficam no volume `n8n_data` e sobrevivem a reinícios e atualizações.

### 5. Não suspender ao fechar a tampa

Sem isso, o notebook dorme com a tampa fechada e o backup não roda. Edite o arquivo, deixe a linha `HandleLidSwitch=ignore` sem `#` e reinicie o serviço:

```bash
sudo nano /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
```

### 6. Criar o bot do Telegram

1. No Telegram (aplicativo ou <https://web.telegram.org>), abra o contato **@BotFather** e envie `/newbot`. Escolha um nome e um usuário que termine em `bot`.
2. Ele devolve um **token** (`123456:ABC...`). Guarde.
3. Abra o seu bot novo e envie qualquer mensagem (ex.: "oi"). O bot só pode escrever para quem falou com ele primeiro.
4. No navegador, abra `https://api.telegram.org/botSEU_TOKEN/getUpdates`, trocando `SEU_TOKEN` pelo token do passo 2. A palavra `bot` fica **colada** no token, e não leve `<` nem `>` para a URL (com eles dá `404 Not Found`). Procure `"chat":{"id":123456789`: esse número é o seu **chat ID**. Se `result` vier vazio (`[]`), mande outra mensagem ao bot e recarregue.

> O token dá controle total do bot. Não o mostre em prints nem o commite. Se vazar, use `/revoke` no @BotFather para gerar outro.

### 7. Criar as credenciais no n8n

Em <http://localhost:5678>: menu lateral → **Credentials** → **Create credential**.

- **Telegram API**: cole o token. Nome: `Telegram KEEPER`.
- **Custom Auth**: no campo JSON, escreva (com a senha real do KEEPER):

  ```json
  { "body": { "senha": "SUA_SENHA_DO_KEEPER" } }
  ```

  Nome: `KEEPER login`. Assim a senha fica no cofre do n8n, não dentro do workflow.

### 8. Importar o workflow

**Workflows** → **Create workflow** → menu `⋯` (canto superior direito) → **Import from file** → escolha `~/keeper/automacoes/n8n/backup-nuvem.json` (o arquivo [backup-nuvem.json](backup-nuvem.json)).

### 9. Ajustar 4 coisas

Clique duas vezes em cada nó:

1. **Config**: troque `frase` por uma frase longa só sua. **Anote em um lugar seguro**: sem ela não há como restaurar. Deixe `keeperUrl` como está (`http://127.0.0.1:3000`).
2. **Login**: deixe *Authentication* e *Generic Auth Type* como estão (`Generic Credential Type` e `Custom Auth`). No campo **Custom Auth**, logo abaixo, escolha `KEEPER login` na lista. Se ela não existir, *Create new credential* abre o JSON do passo 7.
3. **Enviar ao Telegram**: escolha a credencial `Telegram KEEPER` e cole o *Chat ID*.
4. **Avisar falha no Telegram**: mesma credencial e mesmo *Chat ID*.

Salve (Ctrl+S).

### 10. Testar na mão

Clique em **Execute workflow**. Cada nó fica verde conforme termina. No Telegram deve chegar um arquivo `keeper-AAAA-MM-DD-HHMMSS.db.enc`.

Teste também o aviso de falha: pare o KEEPER (`sudo systemctl stop keeper`), execute de novo e confira que a mensagem "FALHOU" chega. Depois religue com `sudo systemctl start keeper`.

### 11. Ativar

Ative o interruptor **Active** (ou *Publish*, conforme a versão) no topo. A partir daí roda todo dia às 03:00, com o notebook ligado.

> Depois de preencher a frase, não exporte nem commite o workflow: ela fica dentro dele.

## Mudar o horário do backup

Abra o primeiro nó ("Todo dia às 03:00"), que é um *Schedule Trigger*, e edite a expressão cron. Alguns exemplos:

| Quando | Expressão |
|---|---|
| Todo dia às 03:00 | `0 3 * * *` |
| Dias úteis às 17:30 | `30 17 * * 1-5` |
| Dias úteis às 18:00 | `0 18 * * 1-5` |

O formato é `minuto hora * * dias-da-semana` (1 = segunda, 5 = sexta). O horário segue o fuso definido no `docker run` (`GENERIC_TIMEZONE`). O notebook precisa estar ligado nesse horário. Salve e deixe o workflow ativo.

## Registrar retirada por foto (IA)

Há um segundo workflow que registra empréstimos a partir da foto da folha de retirada: veja [registrar-retirada.md](registrar-retirada.md).

## Usar de outro computador (opcional)

O n8n e o KEEPER só atendem o próprio notebook. Para abrir os dois do seu PC sem expor nada na rede, use um túnel SSH. No notebook, instale o servidor SSH e descubra o IP:

```bash
sudo apt install -y openssh-server
hostname -I
```

No PC (o Windows 11 já tem `ssh`), deixe esta janela aberta:

```powershell
ssh -L 5678:localhost:5678 -L 3000:localhost:3000 SEU_USUARIO@IP_DO_NOTEBOOK
```

Enquanto ela estiver aberta, <http://localhost:5678> (n8n) e <http://localhost:3000> (KEEPER) abrem no PC. O túnel só serve para você mexer: o backup roda sem ele. Se o IP do notebook mudar, reserve-o no roteador (reserva DHCP).

Por que túnel e não abrir a porta 5678 na rede: sem HTTPS, o n8n recusa o login pelo IP da rede (cookie seguro). Contornar com `N8N_SECURE_COOKIE=false` funciona, mas só aceite isso numa rede totalmente confiável.

## Atualizar

```bash
# KEEPER
cd ~/keeper && git pull && sudo systemctl restart keeper

# n8n (os dados ficam no volume; depois repita o docker run do passo 4)
sudo docker pull docker.n8n.io/n8nio/n8n
sudo docker rm -f n8n
```

## Restaurar um backup

1. Baixe o `.db.enc` do Telegram (cai em `~/Downloads`).
2. Descriptografe (o nome sem `.enc` já é um nome de backup válido):

   ```bash
   cd ~/keeper
   KEEPER_FRASE="sua frase" node automacoes/n8n/descriptografar.js ~/Downloads/keeper-2026-11-04-030001.db.enc
   ```

3. Mova o `.db` gerado para a pasta `backups/` e use **Configurações → Backups → Restaurar** no KEEPER:

   ```bash
   mv ~/Downloads/keeper-2026-11-04-030001.db ~/keeper/backups/
   ```

Frase errada ou arquivo corrompido: o script falha em vez de gerar um banco quebrado.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `Module 'crypto' is disallowed` no nó Criptografar | n8n iniciado sem `NODE_FUNCTION_ALLOW_BUILTIN=crypto`; refaça o `docker run` do passo 4 |
| Login falha com 401 | Senha errada na credencial `KEEPER login` |
| Login falha com 403 `Host inválido` | `keeperUrl` mudou para um endereço que o KEEPER não aceita; volte para `http://127.0.0.1:3000` |
| Login falha com 429 | Muitas senhas erradas seguidas; espere o tempo indicado |
| Login falha com "connection refused" | KEEPER parado: `sudo systemctl status keeper` |
| Criar backup falha com 415 | O corpo precisa ser JSON (já está configurado; só ocorre se o nó for alterado) |
| Telegram `chat not found` | Você ainda não enviou mensagem ao bot (passo 6.3) |
| `getUpdates` responde `404 Not Found` | URL com `<` `>` em volta do token, ou token errado (passo 6.4) |
| `docker: permission denied` | Faltou o `sudo` antes do `docker` |
