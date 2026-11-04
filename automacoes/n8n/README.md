# Backup do KEEPER na nuvem (n8n)

Todo dia às 03:00, o n8n faz login no KEEPER, pede um backup novo, **criptografa** o arquivo e envia para um chat privado do Telegram. Se qualquer etapa falhar, você recebe um aviso no mesmo chat.

```
Agenda → Config → Login → Criar backup → Baixar → Criptografar → Telegram → Logout
                                  (qualquer erro) → aviso no Telegram
```

O KEEPER não muda: continua local, em `127.0.0.1`. O n8n roda na mesma máquina e só o arquivo criptografado sai dela.

**Por que criptografar:** o backup contém o hash da senha do administrador e os nomes de quem pegou equipamentos. A frase de criptografia fica só com você; sem ela o arquivo no Telegram não abre.

**Por que Telegram:** é de graça, sem OAuth (o Google Drive exige criar um projeto no Google Cloud) e guarda o histórico sem precisar de rotina de limpeza. Limite: 50 MB por arquivo, e o banco do KEEPER é bem menor que isso. Para usar Google Drive ou S3, troque só o nó "Enviar ao Telegram".

## Passo a passo (nunca usou n8n)

### 1. Subir o n8n

Escolha **uma** das opções. As duas liberam o módulo `crypto` para o nó de criptografia.

**Opção A, com Node (mais simples).** No PowerShell:

```powershell
$env:NODE_FUNCTION_ALLOW_BUILTIN = "crypto"
npx n8n
```

Se o `npx` reclamar da versão do Node, use a opção B.

**Opção B, com Docker:**

```powershell
docker run -it --rm -p 5678:5678 -v n8n_data:/home/node/.n8n -e NODE_FUNCTION_ALLOW_BUILTIN=crypto docker.n8n.io/n8nio/n8n
```

Nesse caso o n8n enxerga o KEEPER por `host.docker.internal`, e o KEEPER precisa aceitar esse nome:

```powershell
$env:KEEPER_ORIGIN = "localhost,127.0.0.1,host.docker.internal"
node server.js
```

E no passo 5 você troca a `keeperUrl` por `http://host.docker.internal:3000`. Se mesmo assim não conectar, inicie o KEEPER com `HOST=0.0.0.0`, o que o expõe na rede local (só faça isso em rede confiável).

Abra <http://localhost:5678> e crie a conta de dono. Ela é local e só vale para o seu n8n.

### 2. Criar o bot do Telegram

1. No Telegram, abra o contato **@BotFather** e envie `/newbot`. Escolha um nome e um usuário que termine em `bot`.
2. Ele devolve um **token** (`123456:ABC...`). Guarde.
3. Abra o seu bot novo e envie qualquer mensagem (ex.: "oi"). O bot só pode escrever para quem falou com ele primeiro.
4. No navegador, abra `https://api.telegram.org/bot<SEU_TOKEN>/getUpdates` e procure `"chat":{"id":123456789`. Esse número é o seu **chat ID**.

### 3. Criar as credenciais no n8n

Menu lateral → **Credentials** → **Create credential**.

- **Telegram API**: cole o token. Nome: `Telegram KEEPER`.
- **Custom Auth**: no campo JSON, escreva (com a senha real do KEEPER):

  ```json
  { "body": { "senha": "SUA_SENHA_DO_KEEPER" } }
  ```

  Nome: `KEEPER login`. Assim a senha fica no cofre do n8n, não dentro do workflow.

### 4. Importar o workflow

**Workflows** → **Create workflow** → menu `⋯` (canto superior direito) → **Import from file** → escolha [backup-nuvem.json](backup-nuvem.json).

### 5. Ajustar 4 coisas

Clique duas vezes em cada nó:

1. **Config**: troque `frase` por uma frase longa só sua. **Anote em um lugar seguro**: sem ela não há como restaurar. Confira `keeperUrl`.
2. **Login**: em *Credential for Custom Auth*, escolha `KEEPER login`.
3. **Enviar ao Telegram**: escolha a credencial `Telegram KEEPER` e cole o *Chat ID*.
4. **Avisar falha no Telegram**: mesma credencial e mesmo *Chat ID*.

Salve (Ctrl+S).

### 6. Testar na mão

Com o KEEPER rodando, clique em **Execute workflow**. Cada nó fica verde conforme termina. No Telegram deve chegar um arquivo `keeper-AAAA-MM-DD-HHMMSS.db.enc`.

Teste também o aviso de falha: pare o KEEPER, execute de novo e confira que a mensagem "FALHOU" chega.

### 7. Ativar

Ative o interruptor **Active** (ou *Publish*, conforme a versão) no topo. A partir daí roda todo dia às 03:00, **desde que o n8n e o KEEPER estejam ligados nesse horário**. Se o computador dorme à noite, mude a hora no primeiro nó.

> Depois de preencher a frase, não exporte nem commite o workflow: ela fica dentro dele.

## Rodando num notebook Debian (ligado 24 h)

Num computador que desliga ou dorme, o backup das 03:00 não roda. Um notebook Debian sempre ligado resolve. **KEEPER e n8n precisam ficar na mesma máquina**, porque o KEEPER só escuta em `127.0.0.1`. Você usa os dois do seu PC por um túnel SSH, sem expor nada na rede.

Esta seção substitui o passo 1 acima; os passos 2 a 7 valem iguais.

### No notebook

**1. Pacotes básicos**

```bash
sudo apt update
sudo apt install -y git docker.io openssh-server
sudo systemctl enable --now docker ssh
```

**2. Node 22.13 ou superior.** O Debian estável costuma trazer um Node mais antigo. Instale pelo [nvm](https://github.com/nvm-sh/nvm) ou pela NodeSource e confira com `node -v`. Se usar nvm, o caminho do `node` no passo 4 muda (`which node`).

**3. Clonar o projeto** (na branch que você criou) e, se quiser manter os dados, copiar do PC o `keeper.db` e a pasta `backups/` para dentro da pasta do projeto:

```bash
git clone -b NOME_DA_BRANCH https://github.com/shwdaniel7/keeper.git
cd keeper
node --test        # opcional: confirma que tudo funciona nesta máquina
```

**4. KEEPER como serviço**, para subir sozinho no boot. Crie `/etc/systemd/system/keeper.service` (troque `SEU_USUARIO` e confira o caminho do `node` com `which node`):

```ini
[Unit]
Description=KEEPER
After=network.target

[Service]
User=SEU_USUARIO
WorkingDirectory=/home/SEU_USUARIO/keeper
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now keeper
sudo systemctl status keeper     # deve estar "active (running)"
```

Sem copiar um `keeper.db`, o primeiro acesso pede um código de configuração. Veja-o com `sudo journalctl -u keeper | grep Código`.

**5. n8n em Docker.** Com `--network host` ele enxerga o KEEPER em `127.0.0.1:3000` e o `keeperUrl` do workflow continua como está. `N8N_LISTEN_ADDRESS` mantém o n8n acessível só pelo próprio notebook, e o fuso evita que o "03:00" rode em UTC:

```bash
sudo docker run -d --name n8n --restart unless-stopped --network host \
  -v n8n_data:/home/node/.n8n \
  -e NODE_FUNCTION_ALLOW_BUILTIN=crypto \
  -e N8N_LISTEN_ADDRESS=127.0.0.1 \
  -e GENERIC_TIMEZONE=America/Sao_Paulo -e TZ=America/Sao_Paulo \
  docker.n8n.io/n8nio/n8n
```

Confira com `sudo docker logs n8n`. Os dados do n8n (workflows, credenciais) ficam no volume `n8n_data` e sobrevivem a reinícios e atualizações.

**6. Não suspender ao fechar a tampa.** Edite `/etc/systemd/logind.conf`, deixe a linha `HandleLidSwitch=ignore` sem `#` e rode `sudo systemctl restart systemd-logind`.

**7. Descobrir o IP do notebook:** `hostname -I`. Se o roteador permitir, reserve esse IP para o notebook (reserva DHCP), senão ele pode mudar.

### No seu PC

Abra o túnel no PowerShell (o Windows 11 já tem `ssh`) e deixe a janela aberta:

```powershell
ssh -L 5678:localhost:5678 -L 3000:localhost:3000 SEU_USUARIO@IP_DO_NOTEBOOK
```

Enquanto ela estiver aberta:

- <http://localhost:5678>: o n8n (crie a conta de dono no primeiro acesso)
- <http://localhost:3000>: o KEEPER

O túnel só é necessário para você mexer. O backup roda sem ele, porque tudo acontece dentro do notebook.

### Atualizar e manter

```bash
# atualizar o KEEPER
cd ~/keeper && git pull && sudo systemctl restart keeper

# atualizar o n8n
sudo docker pull docker.n8n.io/n8nio/n8n && sudo docker rm -f n8n   # depois repita o docker run do passo 5
```

Por que túnel e não abrir a porta 5678 na rede: sem HTTPS, o n8n recusa o login pelo IP da rede (cookie seguro). Contornar com `N8N_SECURE_COOKIE=false` funciona, mas só aceite isso numa rede totalmente confiável.

## Restaurar um backup

1. Baixe o `.db.enc` do Telegram para a pasta do projeto.
2. Descriptografe (o nome sem `.enc` já é um nome de backup válido):

   ```powershell
   $env:KEEPER_FRASE = "sua frase"
   node automacoes/n8n/descriptografar.js keeper-2026-11-04-030001.db.enc
   ```

3. Mova o `.db` gerado para a pasta `backups/` e use **Configurações → Backups → Restaurar** no KEEPER.

Frase errada ou arquivo corrompido: o script falha em vez de gerar um banco quebrado.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `Module 'crypto' is disallowed` no nó Criptografar | n8n iniciado sem `NODE_FUNCTION_ALLOW_BUILTIN=crypto` |
| Login falha com 401 | Senha errada na credencial `KEEPER login` |
| Login falha com 403 `Host inválido` | Usando Docker sem `host.docker.internal` em `KEEPER_ORIGIN` |
| Login falha com 429 | Muitas senhas erradas seguidas; espere o tempo indicado |
| Criar backup falha com 415 | O corpo precisa ser JSON (já está configurado; só ocorre se o nó for alterado) |
| Telegram `chat not found` | Você ainda não enviou mensagem ao bot (passo 2.3) |
