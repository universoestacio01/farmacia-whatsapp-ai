# Reservas de medicamentos

## Regra restaurada em 23/09/2026

Ordem: Preco Popular -> PharmaDB -> BulAPI. Cosmos continua fora do fluxo.
Uma oferta valida da principal nao consulta reservas. Higiene, perfumaria e
primeiros socorros continuam na principal, inclusive o encaminhamento de soro.

Regra recuperada do historico (commit 759ebbd), conforme solicitado:

| Fonte | Preco de venda |
| --- | --- |
| Preco Popular | Campo Price integral, sem desconto adicional |
| PharmaDB | PF positivo; sem PF, (PMC com ICMS ou PMC) x 0.5 |
| BulAPI | Maior PF positivo da apresentacao exata |

O fator PharmaDB usa PHARMADB_PMC_PRICE_MULTIPLIER, padrao 0.5.
As colunas PharmaDB em centavos sao convertidas para reais antes do calculo.
Nao sao inventados precos para itens sem valor. A politica acompanha selecao,
carrinho e checkout; valores legados sem politica valida precisam de nova busca.
Pedidos e Pix ja emitidos preservam o valor acordado.

PF/PMC sao referencias, nao comprovacao de estoque, custo ou margem.
A regra comercial acima nao substitui a verificacao operacional da loja.

## Configuracao

```dotenv
PRECO_POPULAR_ENABLED=true
PHARMADB_ENABLED=true
PHARMADB_API_KEY=SUA_CHAVE_VALIDA
PHARMADB_API_BASE_URL=https://api.pharmadb.com.br/v1
PHARMADB_PMC_PRICE_MULTIPLIER=0.5
BULAPI_ENABLED=true
BULA_API_BASE_URL=https://bulapi.com.br/api/v1
```

Nao publicar arquivos de segredos no GitHub. O .env local nao foi modificado.
PharmaDB sem chave e ignorada. Para desativar as reservas, colocar suas flags em
false; desligar PRECO_POPULAR_ENABLED sozinho nao desativa as reservas.

## Protecoes

- Mesmos filtros estritos de medicamento, dosagem, forma e embalagem.
- Nao substitui 70mg por 30mg, nem mg/ml por mg; 1g equivale a 1000mg.
- Bloqueio de itens inativos, indisponiveis, injetaveis, hospitalares e EAN em quarentena.
- Ranking e diversidade de apresentacoes reutilizam o seletor existente.
- Cache por consulta, agrupamento de chamadas iguais e pausa apos erros.
- PharmaDB: ate 2 paginas e 3 detalhes, ate 6 chamadas protegidas incluindo
  uma retentativa de autenticacao; a emissao de token e separada.
- BulAPI: ate 9 chamadas, incluindo ate 3 consultas de preco.
- Orcamento de 6 segundos por reserva. Limite atingido significa busca incompleta,
  nao prova de inexistencia. Erro de API nao e resposta vazia de catalogo.
- Nenhuma consulta externa no bootstrap, no health ou ao abrir o painel.
- Health e painel mostram configuracao, nao um teste de conectividade.

## Validacao

Sondagens HTTP reais realizadas localmente nesta rodada, antes de ativar o fluxo:

| Sondagem | Resultado |
| --- | --- |
| PharmaDB POST /auth/token, com chave local | HTTP 401 |
| BulAPI GET /api/v1/search?q=novalgina | HTTP 502 |

Foram duas sondagens diretas. Nao foi consultado o catalogo PharmaDB apos a recusa
de autenticacao. Nao houve pedido real, Pix nem mensagem enviada ao WhatsApp.
Esses resultados nao validam as reservas em producao: e preciso corrigir a
credencial/acesso PharmaDB e aguardar ou resolver a indisponibilidade BulAPI.

Testes automatizados usam respostas simuladas, sem gastar cota dos provedores:

```text
npm run build
npm run lint
npm run test:medicine-backups
node --test scripts/validate-preco-popular.js scripts/validate-catalog-regressions.js scripts/validate-catalog-checkout.js scripts/validate-conversation-opening.js scripts/validate-package-images.js scripts/validate-admin-stability.js scripts/validate-retail-language.js scripts/validate-catalog-routing.js
npm run test:conversation-flow
npm run test:retail-flow
npm run test:medicine-search
npm run test:payment-flow
npm run test:admin-payment-flow
npx prisma validate
```

O teste das reservas sobe Nest em porta local temporaria e valida HTTP 200 de
GET /health/providers. O teste de modulo garante injecao dos adaptadores sem
chamada externa na inicializacao. QA do painel: 71 verificacoes em 1440, 768 e
390 pixels, com Playwright/Chrome local e dados ficticios.

Nao ha migracao de banco ou deploy automatico. Alteracoes apenas no projeto de
trabalho em Documents/apifarmacia/farmacia-whatsapp-ai, nao na pasta GitHub.
