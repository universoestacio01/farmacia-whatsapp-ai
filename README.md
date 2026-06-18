# farmacia-whatsapp-ai

API NestJS em TypeScript para atendimento de farmácia pelo WhatsApp Cloud API, com Prisma/MySQL, OpenAI, BulaAPI, ViaCEP e Pix via SigiloPay.

## Stack

- NestJS + TypeScript
- Prisma + MySQL
- WhatsApp Cloud API
- OpenAI
- BulaAPI
- ViaCEP
- Pix SigiloPay com fallback manual

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
- `POST /webhook/sigilopay` recebe eventos de pagamento da SigiloPay

## Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste:

- `DATABASE_URL`: conexao MySQL usada pelo Prisma.
- `WHATSAPP_VERIFY_TOKEN`: token livre definido por voce e usado tambem no painel da Meta.
- `WHATSAPP_ACCESS_TOKEN`: token de acesso da WhatsApp Cloud API.
- `WHATSAPP_PHONE_NUMBER_ID`: ID do numero do WhatsApp no painel da Meta.
- `WHATSAPP_APP_SECRET`: segredo do app da Meta, usado para validar o header `X-Hub-Signature-256` nos webhooks recebidos.
- `OPENAI_API_KEY`: chave da OpenAI.
- `BULA_API_BASE_URL`: URL base da Bulapi, por padrão `https://bulapi.com.br/api/v1`.
- `PIX_PROVIDER`: use `sigilopay` para Pix automático.
- `SIGILOPAY_ENABLED`: `true` para habilitar criação automática de Pix.
- `SIGILOPAY_API_BASE_URL`: por padrão `https://app.sigilopay.com.br/api/v1`.
- `SIGILOPAY_CALLBACK_URL`: URL enviada no `callbackUrl` da cobrança Pix. Para produção atual, use `https://io-web.link/webhook/sigilopay`.
- `SIGILOPAY_PUBLIC_KEY` e `SIGILOPAY_SECRET_KEY`: credenciais da API SigiloPay.
- `SIGILOPAY_WEBHOOK_TOKEN`: token usado para validar o campo `token` dos webhooks da SigiloPay.

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

Quando o cliente confirma o pedido no WhatsApp, o sistema cria ou reutiliza uma cobrança Pix pendente na SigiloPay e envia o Pix copia e cola. Se `SIGILOPAY_ENABLED=false`, as credenciais estiverem ausentes ou a API falhar, o pedido continua confirmado e o bot usa fallback manual:

```text
Pedido confirmado ✅

Não consegui gerar o Pix automaticamente agora.
Nossa equipe vai te enviar os dados de pagamento em instantes.
```

O sistema envia o callback na criação da cobrança Pix:

```text
https://io-web.link/webhook/sigilopay
```

O endpoint valida o `token` do payload com `SIGILOPAY_WEBHOOK_TOKEN` quando a variável estiver configurada. Se o token não estiver configurado, o webhook é aceito e o sistema registra um aviso nos logs.
