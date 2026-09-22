# farmacia-whatsapp-ai

API NestJS em TypeScript para atendimento de farmácia pelo WhatsApp Cloud API, com Prisma/MySQL, OpenAI, BulaAPI, ViaCEP e Pix direto.

## Stack

- NestJS + TypeScript
- Prisma + MySQL
- WhatsApp Cloud API
- OpenAI
- BulaAPI
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

O catálogo VTEX do Preço Popular é consultado primeiro para medicamentos e produtos
de higiene/perfumaria. A integração roda no próprio NestJS; não é necessário
publicar ou executar a pasta `api-busca` em PHP. Não precisa de chave de API.

```dotenv
PRECO_POPULAR_ENABLED=true
PRECO_POPULAR_PRICE_MULTIPLIER=0.9
```

Esses são os padrões mesmo quando as variáveis não estão cadastradas. O valor de
venda é `Price * 0.9`, arredondado para centavos (10% de desconto). `ListPrice` não
é usado como preço de venda, e a regra de 50% do PMC da PharmaDB não se aplica a
essa fonte. O preço final é preservado na seleção, no carrinho e no checkout.

O serviço preserva as variações/SKUs, EAN e imagem, ignora ofertas sem preço positivo
ou explicitamente indisponíveis e limita cada busca a duas páginas de 50 produtos,
com um timeout total HTTP de 8 segundos. Há cache de 5 minutos, compartilhamento
de consultas simultâneas iguais e pausa temporária após falhas. Nada é consultado
no bootstrap nem em `/health/providers`.

Se não houver resultado comercial válido, são usados os fluxos anteriores:
`MEDICINE_PRIMARY_PROVIDER` define a preferência PharmaDB/BulAPI antes do catálogo
manual; produtos de higiene usam Cosmos e depois catálogo manual. Os preços dos
fallbacks seguem suas próprias regras. A resposta genérica "qualquer marca" mantém
o catálogo manual curado já existente.

`GET /health/providers` mostra `primaryProvider: "preco_popular"` e
`providers.preco_popular.priceMultiplier: 0.9`; o painel também identifica a fonte.
Para reverter ao fluxo anterior, configure `PRECO_POPULAR_ENABLED=false` e reinicie.
Não há migração de banco específica para essa integração.

Os preços e a disponibilidade consultados pertencem à loja de origem, não ao
estoque da farmácia. Não representam uma recomendação médica nem dispensam as
validações comerciais e de receita necessárias. Avalie a permissão de uso do
catálogo antes de depender exclusivamente dessa fonte externa.

Teste offline, sem consumir APIs:

```bash
npm run build
npm run test:preco-popular
```

### Demais variáveis

Copie `.env.example` para `.env` e ajuste:

- `DATABASE_URL`: conexao MySQL usada pelo Prisma.
- `WHATSAPP_VERIFY_TOKEN`: token livre definido por voce e usado tambem no painel da Meta.
- `WHATSAPP_ACCESS_TOKEN`: token de acesso da WhatsApp Cloud API.
- `WHATSAPP_PHONE_NUMBER_ID`: ID do numero do WhatsApp no painel da Meta.
- `WHATSAPP_APP_SECRET`: segredo do app da Meta, usado para validar o header `X-Hub-Signature-256` nos webhooks recebidos.
- `OPENAI_API_KEY`: chave da OpenAI.
- `BULA_API_BASE_URL`: URL base da Bulapi, por padrão `https://bulapi.com.br/api/v1`.
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

Como não existe integração bancária para consulta do recebimento, a aprovação continua manual. Depois do pagamento, o cliente responde `paguei` e a equipe confere o recebimento. No painel administrativo, altere o status do pedido para `PAID`; o pagamento pendente será atualizado junto.

