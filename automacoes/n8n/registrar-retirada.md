# Registrar retirada por foto (n8n + Gemini)

Você fotografa a folha de retirada, manda no Telegram e o n8n registra o empréstimo no KEEPER, sem digitar nada. A IA só **lê** a folha; escolher os equipamentos e gravar no banco é código comum, e **nada é gravado sem o seu "ok"**.

```
Professor preenche uma linha da planilha → você fotografa a planilha e manda para o bot
  → Gemini lê TODAS as linhas: professor, sala, tipo, quantidade, devolução, assinaturas
  → n8n compara cada linha com os empréstimos que o KEEPER já tem e fica só com as novas
  → n8n escolhe no KEEPER os equipamentos disponíveis para cada retirada nova
  → o bot responde:  Retiradas novas (1):
                     1) NB-0003, NB-0004 para Marcos (Sala 12), devolução em 12/11/2026
                     Já registradas no KEEPER (ignoradas): 14
                     Entregue esses equipamentos. Responda "ok" para registrar ou "cancelar".
  → você responde "ok" → empréstimos registrados no KEEPER
```

A folha não tem ID de equipamento, então o n8n sugere quais entregar. O bot diz os códigos, você pega esses equipamentos e entrega.

## Como ele separa o novo do que já foi registrado

A planilha acumula linhas, então a foto traz retiradas antigas junto com a nova. Cada linha é comparada com **todos** os empréstimos do KEEPER, abertos e já devolvidos, por três campos que não mudam depois de preenchidos:

**professor + tipo + data de devolução**

- O nome é comparado sem acento nem maiúscula e tolera um erro de leitura (1 letra a cada 6). Nomes curtos têm que ser idênticos.
- Se o KEEPER já tem tantos empréstimos desse grupo quanto a linha pede, ela é ignorada. Se tem menos (a folha pede 3 e só 1 foi registrado), só o que falta é proposto.
- Linhas da mesma pessoa, tipo e devolução são somadas.
- Linhas com devolução **já passada** são tratadas como histórico e ignoradas, para não emprestar equipamento por causa de uma retirada antiga.
- Isso vale também para retiradas que você digitou à mão no KEEPER antes de usar a foto: o que importa é o que está no KEEPER.

O resumo sempre diz quantas linhas foram ignoradas como "já registradas" ou "histórico". Confira esses números: se o bot disser "1 já registrada" e você esperava 14, algo foi lido errado, e você responde `cancelar`.

**Ponto fraco:** se a IA ler o nome de um professor muito diferente do que você digitou (por exemplo, abreviado), a linha parece nova e o bot propõe um empréstimo duplicado. Por isso o resumo e o "ok" existem. Não confirme sem olhar a lista de retiradas novas.

## Regras (para você saber o que ele decide sozinho)

| Situação | O que acontece |
|---|---|
| Escolha dos equipamentos | Disponíveis do tipo pedido, **menor código primeiro**, sem repetir entre retiradas da mesma foto. Pula os de condição "ruim" |
| "note" na folha | Vira `notebook`. Chromebook só entra se a folha disser "chromebook" |
| Pedido maior que o estoque | O bot avisa quantos há e **não registra nada** (nem as outras retiradas da foto) |
| Linha com campo ilegível (nome, tipo, quantidade, devolução) | O bot diz qual linha e qual campo; as demais linhas seguem normalmente |
| Menos de 2 assinaturas, retirada em outro dia, devolução no passado | Aparece como ⚠ no resumo, e você decide |
| Data de retirada | O KEEPER sempre grava **hoje**. Se a folha disser outro dia, vai para as observações do empréstimo |
| Sala | Vai para o campo *setor* do empréstimo |
| Mensagens de outros chats | Ignoradas. Só o seu chat ID é atendido |

Depois de 2 horas sem resposta, o pedido pendente expira.

## Como colocar para funcionar

Pré-requisito: o [backup na nuvem](README.md) funcionando, porque este usa o mesmo bot do Telegram e a mesma credencial `KEEPER login`.

**1. Chave do Gemini.** Em <https://aistudio.google.com/apikey>, crie uma chave de API. Veja na própria página os limites e os termos da faixa gratuita (ver "Privacidade" abaixo).

**2. Credencial no n8n.** *Credentials → Create credential → Header Auth*:
- *Name* (o nome do cabeçalho): `x-goog-api-key`
- *Value*: a chave
- Nome da credencial: `Gemini API key`

**3. Importar.** *Workflows → Create workflow → ⋯ → Import from file* → `~/keeper/automacoes/n8n/registrar-retirada.json`.

**4. Nó Config.** Preencha:
- `telegramToken`: o token do bot (o mesmo da credencial do Telegram)
- `chatId`: o seu chat ID
- `modelo`: deixe `gemini-2.5-flash` e, se der erro de modelo não encontrado, troque pelo nome atual na documentação do Gemini
- `keeperUrl`: `http://127.0.0.1:3000`

**5. Credenciais nos nós.** Escolha a credencial certa em cada um:
- **Login**: `KEEPER login`
- **Ler folha (Gemini)**: `Gemini API key`
- **Baixar foto**, **Avisar registro**, **Responder**, **Avisar falha no Telegram**: `Telegram KEEPER`
- **Avisar falha no Telegram**: cole também o *Chat ID*

Salve (Ctrl+S).

**6. Ativar.** Ative o interruptor *Active*. **Este passo é obrigatório para testar**, porque o n8n só guarda o ponto de leitura das mensagens e o pedido pendente quando o workflow está ativo. Em execução manual, o "ok" não encontraria nada.

**7. Testar.** Fotografe uma folha preenchida e mande para o bot. Em até 1 minuto ele responde com o resumo. Responda `ok` e confira no KEEPER (*Empréstimos*). Teste também uma foto borrada e um `cancelar`.

> Depois de preencher o Config, não exporte nem commite o workflow: ele guarda o token do bot.

## Limites e riscos conhecidos

- **Foto da planilha inteira.** Para o bot achar todas as linhas, enquadre a tabela toda. Se a planilha for longa, mande só a parte com as últimas linhas: o que ficar de fora não é lido, e o que for lido é comparado com o KEEPER.
- **Lote parcial.** Se a foto gerar várias retiradas novas e uma falhar no meio (por exemplo, equipamento emprestado entre a foto e o "ok"), as anteriores já foram gravadas. O aviso de falha chega, e você confere no KEEPER antes de reenviar.
- **Uma mensagem por minuto.** Se mandar várias fotos seguidas, são processadas uma por vez.
- **Se uma etapa falhar, a mensagem já foi consumida.** O bot avisa "FALHOU" e você reenvia a foto. É o preço de nunca registrar o mesmo empréstimo duas vezes.
- **Letra de mão pode ser lida errada.** Por isso o resumo e o "ok". Confira nome, quantidade e data antes de confirmar.
- **O n8n não encerra a sessão no KEEPER** (cada foto ou "ok" abre uma). As sessões vencem sozinhas em 7 dias e são limpas pelo próprio KEEPER.
- **Fotografe só a folha.** O que está na imagem vai para o provedor da IA.

## Privacidade

A foto da folha (nomes de professores, assinaturas) é enviada ao Google. Confira os termos da faixa que estiver usando: em algumas faixas gratuitas, os provedores podem usar o conteúdo para melhorar seus produtos. Como são dados pessoais de terceiros, vale confirmar na escola se isso é aceitável (LGPD). O backup do KEEPER **nunca** passa pela IA.

## Usar Claude em vez de Gemini

Não está pronto, mas a troca é isolada nos dois nós **Pedido à IA** e **Ler folha (Gemini)**: o primeiro monta o pedido e o segundo o envia, e o **Planejar** lê o texto da resposta. Seria preciso adaptar o formato do pedido (imagem em base64 e um esquema JSON) e o caminho do texto na resposta, para a API da Anthropic.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| O bot não responde à foto | Workflow inativo, `chatId` errado no Config ou `telegramToken` errado |
| "Não consegui ler a folha" | Foto escura ou cortada, ou erro da IA (veja a aba *Executions* do n8n) |
| Erro 404 no nó Gemini | Nome em `modelo` não existe mais; confira a documentação do Gemini |
| Erro 403 ou 429 no nó Gemini | Chave inválida ou limite da faixa gratuita atingido |
| `Indisponíveis` ao dar "ok" | Alguém emprestou o equipamento entre a foto e o "ok"; mande a foto de novo |
| Login falha com 401 | Senha errada na credencial `KEEPER login` |
| O bot propõe como nova uma retirada que já estava no KEEPER | Nome lido muito diferente do digitado, ou data de devolução lida errada. Responda `cancelar` e, se for recorrente, padronize como o nome é escrito na folha |
| O bot diz "Nenhuma retirada nova" mas há uma nova | A devolução na folha está no passado (ano lido errado?) ou o nome é parecido com o de outro professor que já tem empréstimo igual |
