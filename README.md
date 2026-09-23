# farmacia-whatsapp-ai

API NestJS em TypeScript para atendimento de farmácia pelo WhatsApp Cloud API, com Prisma/MySQL, OpenAI, catálogo Preço Popular, ViaCEP e Pix direto.

## Stack

- NestJS + TypeScript
- Prisma + MySQL
- WhatsApp Cloud API
- OpenAI
- Catálogo Preço Popular (VTEX)
- ViaCEP
- Pix direto com valor e identificador gerados para cada pedido

## Requisitos

- Node.js 20+
- MySQL 8+
- Conta Meta/WhatsApp Cloud API
- Chave da OpenAI

## Configuracao local

```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run prisma:migrate
npm run start:dev
```

Endpoints principais:

- `GET /health` retorna `{ "status": "ok" }`
- `GET /health/providers` mostra providers configurados sem chamar APIs externas
- `GET /webhooks/whatsapp` verifica o webhook da Meta
- `POST /webhooks/whatsapp` recebe mensagens do WhatsApp

## Variáveis de ambiente

### Catálogo Preço Popular

O catálogo VTEX do Preço Popular é a única fonte de medicamentos, preços e produtos
de higiene/perfumaria. A integração roda no próprio NestJS; não é necessário
publicar ou executar a pasta `api-busca` em PHP. Não precisa de chave de API.

```dotenv
PRECO_POPULAR_ENABLED=true
```

O catálogo fica habilitado por padrão. O valor de venda é o campo `Price` da oferta,
arredondado para centavos, sem desconto adicional. `ListPrice` não é usado como
preço de venda. A variável antiga `PRECO_POPULAR_PRICE_MULTIPLIER` é ignorada,
inclusive se ainda estiver com `0.9` na Hostinger. O preço integral é preservado
na seleção, no carrinho e no checkout.

O serviço preserva as variações/SKUs, EAN e imagem, ignora ofertas sem preço positivo
ou explicitamente indisponíveis e limita cada busca a duas páginas de 50 produtos,
com um timeout total HTTP de 8 segundos. Há cache de 5 minutos, compartilhamento
de consultas simultâneas iguais e pausa temporária após falhas. Nada é consultado
no bootstrap nem em `/health/providers`.

PharmaDB, BulAPI e Cosmos não são mais consultados. Não existe fallback de produto
ou preço para esses serviços nem para preços tabelados do catálogo manual.
As listas locais continuam apenas para reconhecer nomes, categorias, marcas e prioridades.
"Qualquer marca" também consulta a nova API. Se não houver oferta válida, o bot não
inventa produto, disponibilidade ou preço. Os adaptadores antigos foram mantidos
como código legado, fora do fluxo de consultas; BulAPI permanece apenas como
utilitário local de interpretação e formatação, com transporte HTTP bloqueado.

`GET /health/providers` mostra `primaryProvider: "preco_popular"` e
`providers.preco_popular.priceMultiplier: 1`; os provedores antigos aparecem
desativados. `PRECO_POPULAR_ENABLED=false` desliga as buscas, sem reativar os antigos.
O painel mostra somente o catálogo ativo. As variáveis `PHARMADB_*`, `BULA_API_BASE_URL`,
`COSMOS_*` e `MEDICINE_PRIMARY_PROVIDER` podem ser removidas da Hostinger.
Não há nova migração de banco.

Carrinhos iniciados na política anterior têm os itens conferidos por EAN/SKU na
nova fonte antes da confirmação. Se o valor mudar, o resumo é reapresentado.
Se não for possível identificar um item, o bot solicita removê-lo e consultá-lo
novamente, sem apagar o carrinho. Pedidos/Pix já emitidos preservam o valor acordado.

### CEP e endereço de entrega

CEP completo continua seguindo para número e complemento. CEP genérico, como
`23860-000`, solicita rua/estrada e bairro/localidade rural quando estiverem
ausentes. Se o ViaCEP não responder ou não localizar o CEP, o cliente pode
preencher rua, bairro, cidade, UF e número manualmente; `s/n` é aceito.
A consulta tem limite de 5 segundos. CEP digitado incorretamente precisa ser corrigido.

Não são exibidos campos vazios separados por vírgulas. O resumo e a criação do
pedido/Pix exigem endereço completo, inclusive para conversas antigas.
O preenchimento manual não comprova existência do endereço nem cobertura de entrega;
a equipe deve conferir os dados no resumo/painel. `voltar` permite corrigir o CEP.

Os preços e a disponibilidade consultados pertencem à loja de origem, não ao
estoque da farmácia. Não representam uma recomendação médica nem dispensam as
validações comerciais e de receita necessárias. Avalie a permissão de uso do
catálogo antes de depender exclusivamente dessa fonte externa.

Teste offline, sem consumir APIs:

```bash
npm run build
npm run test:preco-popular
npm run test:catalog-checkout
```

### Fotos de embalagens

O bot só oferece leitura de foto quando `OPENAI_API_KEY` está configurada.
`OPENAI_VISION_MODEL` é opcional; sem ele, usa `OPENAI_MODEL` e, na ausência
deste, o padrão `gpt-4o-mini`. O modelo selecionado precisa aceitar imagens
e saída JSON. A presença da chave não comprova acesso, saldo ou disponibilidade.

O fluxo é: foto recebida, leitura da embalagem, confirmação do nome/dosagem
pelo cliente e busca normal no Preço Popular. A imagem nunca adiciona itens ao
carrinho nem confirma pedidos sozinha. Não são feitas recomendações de dose,
reconhecimento de comprimidos soltos nem interpretação de receitas/exames.

Se a leitura falhar, o bot reconhece que recebeu a imagem e pede o nome e a
dosagem por escrito. Não informa que aceita apenas texto. Imagens/PDFs em
`WAITING_PIX` continuam como comprovantes para conferência humana, sem OCR
de produtos e sem confirmação automática do pagamento.

O download usa somente HTTPS em domínios de mídia da Meta, sem redirecionamentos,
até 5 MiB, e timeout compartilhado de 8 segundos. A leitura por IA tem timeout
de 15 segundos e não faz retentativas automáticas. Fotos são enviadas ao modelo
configurado para transcrição; não são gravadas em disco por esse fluxo.
Logs de falha mostram etapa/status, sem token, URL temporária ou conteúdo da imagem.

Referências: [imagens na API OpenAI](https://developers.openai.com/api/docs/guides/images-vision)
e [saída JSON](https://developers.openai.com/api/docs/guides/structured-outputs).
Teste sem APIs reais: `npm run test:package-images`.

### Demais variáveis

Copie `.env.example` para `.env` e ajuste:

- `DATABASE_URL`: conexao MySQL usada pelo Prisma.
- `WHATSAPP_VERIFY_TOKEN`: token livre definido por voce e usado tambem no painel da Meta.
- `WHATSAPP_ACCESS_TOKEN`: token de acesso da WhatsApp Cloud API.
- `WHATSAPP_PHONE_NUMBER_ID`: ID do numero do WhatsApp no painel da Meta.
- `WHATSAPP_APP_SECRET`: segredo do app da Meta, usado para validar o header `X-Hub-Signature-256` nos webhooks recebidos.
- `OPENAI_API_KEY`: chave da OpenAI.
- `PIX_PROVIDER`: use `pix_direct`.
- `PIX_KEY`: chave Pix aleatória da empresa.
- `PIX_MERCHANT_NAME`: nome do recebedor usado no código Pix.
- `PIX_MERCHANT_CITY`: cidade do recebedor usada no código Pix.

## Configuracao do webhook na Meta

No painel da Meta, configure a URL publica:

```text
https://seu-dominio.com/webhooks/whatsapp
```

Use o mesmo valor de `WHATSAPP_VERIFY_TOKEN` no campo de token de verificacao.

Assine pelo menos o evento `messages`.

## Deploy em hospedagem Node.js da Hostinger

1. Crie o banco MySQL na Hostinger e copie host, porta, usuario, senha e nome do banco.
2. Configure `DATABASE_URL` nas variaveis de ambiente da aplicacao.
3. Configure tambem as variaveis do WhatsApp e da OpenAI.
4. Envie o projeto para a hospedagem ou conecte o repositorio Git.
5. Configure `npm run deploy:hostinger` como comando de build/deploy, ou rode manualmente sempre que publicar uma nova versao:

```bash
npm install
npm run deploy:hostinger
```

Esse comando executa `prisma generate`, aplica as migrations com `prisma migrate deploy` e compila o NestJS.

6. Configure `npm run start:prod` apenas como comando de inicializacao:

```bash
npm run start:prod
```

7. Aponte o webhook da Meta para `https://seu-dominio.com/webhooks/whatsapp`.

Em hospedagem Node.js, garanta que a versão do Node esteja em 20 ou superior e que a porta usada pela Hostinger seja repassada via variável `PORT`.

## Docker

```bash
docker build -t farmacia-whatsapp-ai .
docker run --env-file .env -p 3000:3000 farmacia-whatsapp-ai
```

## Estrutura

```text
src/
  app.module.ts
  main.ts
  health/
  prisma/
  webhooks/
  whatsapp/
  ai/
  integrations/
  payments/
```

## Pix

Quando o cliente confirma o pedido no WhatsApp, o sistema registra um pagamento pendente e gera localmente um Pix Copia e Cola com o valor exato e um identificador único do pedido. Nenhuma API bancária ou gateway é chamada.

```text
Pedido confirmado.
Total: R$ XX,XX

Vou te enviar o Pix Copia e Cola na próxima mensagem.
```

Como não existe integração bancária para consulta do recebimento, a aprovação continua manual. Depois do pagamento, o cliente responde `paguei` e a equipe confere o recebimento. No painel administrativo, use **Compensou** e confirme somente depois da conferência no banco. O pagamento e o pedido serão atualizados pelo fluxo existente.

## Painel administrativo: operação e validação local

- Conversas mostram as 100 mensagens mais recentes em ordem cronológica. A atualização preserva rascunhos por cliente e a posição de leitura.
- Compensações têm filtros por cliente, comprovante e tempo de espera. A confirmação continua manual, com confirmação explícita e bloqueio de cliques repetidos.
- Pedidos exibem os 150 registros mais recentes. Os filtros desse recorte são locais; não constituem pesquisa no histórico completo.
- Integrações separa configuração local de atividade real: últimos 100 registros de APIs, filtros, HTTP, tempo, resultados e identificador de rastreio. Não faz chamadas às APIs externas para montar a tela.
- Prioridades não salvas não são sobrescritas pela atualização automática; o navegador avisa antes de sair com alterações pendentes.
- A atualização automática pode ser pausada. Falhas e expiração de acesso têm tratamento explícito; sair remove dados e rascunhos da tela.

Prévia isolada com dados fictícios, sem carregar `.env`, sem banco, sem envio de WhatsApp e sem movimentar pagamentos reais:

```bash
npm run preview:admin
```

Acesse `http://127.0.0.1:4190/admin/`. O servidor aceita apenas conexões locais e não deve ser usado como comando de produção. Para outra porta: `npm run preview:admin -- 4191`.

Testes após compilar:

```bash
npm run build
npm run test:admin-stability
npm run test:admin-payment-flow
npm run test:preco-popular
npm run test:admin-ui
```

O teste de interface exige Playwright disponível no ambiente (ou em `NODE_PATH`) e Chromium instalado. `PLAYWRIGHT_CHANNEL=chrome` permite usar Chrome já instalado. Usa a prévia local e bloqueia requisições externas. As capturas ficam na pasta temporária `raia-admin-qa`.

Esta rodada não exige novas variáveis ou migration. Publique `src`, `public/admin` (incluindo Lucide e sua licença) e os demais arquivos alterados; compile no servidor. O site institucional não foi alterado.

