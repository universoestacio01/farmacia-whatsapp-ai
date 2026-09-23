# Busca de Soro e Primeiros Socorros

Data: 23/09/2026. Diagnóstico com HTTP real e correções na cópia local do projeto. Sem publicação na Hostinger, acesso ao banco de produção, envio de WhatsApp ou criação de pedidos.

## Causa Comprovada

`Tem soro fisiológico?` era interpretado como busca de medicamento porque o roteamento local não conhecia essa categoria. A API devolveu 7 produtos com preço, classificados em `/Primeiros Socorros/Soro Fisiológico/`, sem princípio ativo cadastrado. O adaptador os classificou corretamente como produtos não medicamentosos, mas o fluxo de medicamentos eliminou todos. A conversa confundiu esse descarte com ausência no catálogo.

O mesmo problema apareceu nas seis consultas reais abaixo. Antes da correção, nenhuma era reconhecida pelo roteador de varejo.

| Consulta | HTTP | Produtos brutos | Ofertas válidas | Medicamentos classificados |
|---|---|---|---|---|
| soro fisiologico | 200 | 7 | 7 | 0 |
| gaze | 200 | 8 | 8 | 0 |
| esparadrapo | 200 | 13 | 13 | 0 |
| alcool 70 | 200 | 6 | 5 | 0 |
| termometro | 200 | 16 | 16 | 0 |
| agua oxigenada | 200 | 8 | 8 | 0 |

Uma oferta de álcool foi descartada por indisponibilidade informada pelo fornecedor. A disponibilidade da fonte não comprova estoque próprio da farmácia.

## Divergência de Catálogo

- O NestJS usa `https://www.precopopular.com.br`, definido em `src/config/preco-popular.config.ts`.
- `api-busca/config.php` aponta para `https://www.drogaraia.com.br/`, mas esse PHP não é executado nem lido pela integração NestJS.
- Teste real de `/api/catalog_system/pub/products/search?ft=soro%20fisiologico&_from=0&_to=49` na Droga Raia: **HTTP 404, HTML, sem lista JSON**.
- Isso demonstra que esse endpoint não é compatível naquele domínio nesta consulta; não demonstra ausência de outras integrações possíveis da Droga Raia.
- O [site da Droga Raia](https://www.drogaraia.com.br/) possui seu próprio catálogo. Ter um produto lá não garante a mesma oferta no fornecedor consultado pelo bot.
- Não troquei silenciosamente o fornecedor nem alterei o PHP enviado pelo usuário. Para usar o catálogo da Droga Raia, é necessário validar uma integração própria compatível e autorizada.

## Correções

1. Roteamento explícito de soro fisiológico, gaze, esparadrapo, álcool, termômetro e água oxigenada. Sem ofertas ou preços manuais e sem perguntar marcas vazias.
2. Busca inicialmente interpretada como medicamento pode passar ao varejo quando o catálogo contém apenas produtos não medicamentosos. Esse caminho reaproveita a resposta em cache e preserva o texto completo do pedido como filtro.
3. Rejeições por dosagem, forma ou apresentação de medicamentos não autorizam esse desvio. Produtos explicitamente injetáveis ou hospitalares também são bloqueados no filtro de varejo.
4. Volume e concentração explícitos continuam obrigatórios. `0,9%` e `0.9%` são normalizados; não são equivalentes a `9%`, e concentração ausente não é presumida.
5. Sem preço ou sem disponibilidade gera mensagem de oferta indisponível. Falha HTTP não vira produto inexistente.
6. Logs `CATALOG_CLASSIFICATION` e `CATALOG_ROUTING_FALLBACK` mostram contagens e motivo do redirecionamento. Os logs de consulta e filtros existentes foram preservados.
7. Rótulos de primeiros socorros recebem acentuação correta. Preços integrais, Pix direto e demais regras comerciais permanecem.

## Validação Real Após a Correção

O script `scripts/verify-first-aid-conversation.js` executou a classe de conversa e os serviços reais, com persistência somente em memória:

- `Tem soro fisiológico?`: HTTP 200, três opções exibidas, todas com preço.
- `Tem soro fisiologico 500ml?`: HTTP 200, duas opções que correspondem a 500ml: ADV por R$ 9,90 e L.B.S por R$ 6,70, no instante do teste.

Respostas completas e requisições: `diagnostics/first-aid-conversation-2026-09-23T04-08-45-892Z.json`. O ajuste final de acentuação foi validado offline depois dessa captura, sem repetir chamadas de rede.

Nesta rodada houve **10 requisições HTTP diretas**: 9 para Preço Popular e 1 para verificar o endpoint da Droga Raia. Consultas de navegação web não estão incluídas nesse contador. Não houve uso de PharmaDB, Cosmos ou BulAPI externa.

## Testes e Arquivos

Validação final: **398 testes aprovados** nas oito suítes `node --test`, mais **50 cenários de conversa**. Build, lint, fluxo de varejo, busca de medicamentos, Pix direto e confirmação administrativa de pagamento também passaram.

Os testes de `scripts/validate-catalog-routing.js` reproduzem as seis respostas reais, escolha e carrinho, variantes do print, volumes, concentrações, tipos ainda não cadastrados, falhas HTTP, indisponibilidade e bloqueio de apresentações incompatíveis. Variações de atributos usam as respostas capturadas como fixtures para testar filtros; apenas as duas conversas acima foram novamente consultadas ao vivo após a correção.

A captura pública para regressão está em `scripts/fixtures/first-aid-catalog-2026-09-23.json`. `scripts/diagnose-first-aid-catalog.js` tem consultas fixas e orçamento limitado; não é executado no bootstrap.

Código alterado: configuração de categorias e aliases de varejo; normalização de consulta; adaptador Preço Popular; orquestradores de medicamentos e produtos; contrato de busca em `bula-api.service.ts`; motor de conversa e formatação de mensagens. `package.json` ganhou `test:catalog-routing`.

As alterações devem ser publicadas na Hostinger para afetar o atendimento real. Não há migração de banco nem mudança de variáveis de ambiente nesta correção.
