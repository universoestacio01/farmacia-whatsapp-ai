# Correções da Auditoria de Medicamentos

Data: 23/09/2026. Aplicadas na cópia local `farmacia-whatsapp-ai`.

## Resultado

As falhas de código reproduzidas na auditoria foram corrigidas e receberam testes de regressão. Nesta rodada não houve novas chamadas aos catálogos, envio de WhatsApp, geração de cobrança real ou alterações no banco de produção.

O único catálogo ativo continua sendo Preço Popular, com o preço integral retornado. PharmaDB, Cosmos e BulAPI não foram reativados. Pix direto e confirmação manual de pagamento foram preservados.

## Correções Aplicadas

| Problema | Tratamento |
|---|---|
| Microgramas ignorados | Comparação centralizada entre mg, g e mcg. Euthyrox 50mcg e Puran T4 25mcg retornam apenas a dosagem solicitada. |
| Concentração incompleta | Preservação do denominador. 250mg/5ml equivale numericamente a 50mg/ml, mas não a 250mg nem a 250mg/ml. Composições com múltiplos componentes não correspondem apenas ao primeiro componente. |
| Cache mistura dosagens | Chave inclui a concentração completa, forma e quantidade da embalagem. O cache de consulta por nome é reaproveitado sem misturar as seleções. |
| Nomes cortados e números alterados | Removido o truncamento que acrescentava sufixos numéricos incorretos. Mantidos decimais, volumes e acessórios, como copinho e seringa. |
| Plenance associado a tadalafila | Associação corrigida para rosuvastatina. Busca por Plenance simples não oferece Plenance Eze; variante explicitamente pedida pode ser pesquisada. |
| Coristina D e Resfenol eliminados | Busca explícita por marca composta é aceita. Busca por um princípio ativo isolado não autoriza substituição por uma associação. |
| Injetáveis no ranking de varejo | Indicadores preservados e exclusão explícita antes da seleção. Não se depende apenas de uma pontuação negativa. |
| Puran com cadastro suspeito | SKU 6291 / EAN 7891058003555 em quarentena local, sem inventar a unidade correta. Bloqueio também na consulta por EAN/SKU e antes de confirmar carrinho ainda sem pedido emitido. |
| Embalagem pedida ignorada | Reconhecimento de “30 comprimidos”, além de caixa/cartela. Quantidade explícita é uma restrição. Não substitui por 8, 10 ou 20. |
| Formas e abreviações | Suspensão reconhecida antes de “oral”; suporte a drágeas no plural e CP. Peso de creme, geleia e sachê não vira dosagem. |
| Líquido sem denominador | Não usa um título líquido incompleto como confirmação de concentração ou dosagem de comprimido. Não acrescenta “/ml” por suposição. |
| Troca de dosagem no contexto | Mantém medicamento, forma e embalagem. Uma busca com outro medicamento escrito não herda o anterior. Busca malsucedida limpa a seleção anterior. Em continuação curta sem unidade, pede esclarecimento. |
| Falha da API parece produto ausente | Estados separados para falha, resultado parcial, apresentação ausente, atributos não confirmados, restrição e oferta indisponível. Erro/cooldown não é gravado como busca vazia bem-sucedida. |
| Paginação limitada a 100 itens | Até quatro páginas de 50, com orçamento único de oito segundos, sem chamadas de detalhe por SKU. Detecta página repetida e marca resultado incompleto no limite ou em falha posterior. |
| Minancora pergunta a própria marca | Consulta diretamente o catálogo. |
| Imagem genérica de tarja | URLs reconhecidas de rótulos genéricos deixam de ser apresentadas como foto da embalagem. Não foram inventadas imagens substitutas. |

## Verificação com Respostas Reais Gravadas

Foram reproduzidas 62 consultas no motor de conversa: os 50 nomes originais e 12 variações. As respostas HTTP usadas são as mesmas da auditoria real, reduzidas a campos públicos necessários para os testes.

- Os 50 nomes retornaram opções no fluxo apropriado, incluindo Minancora como produto de farmácia.
- 59 das 62 consultas apresentaram opções. Os testes continuaram pela seleção e inclusão de uma unidade no carrinho, verificando preço e dosagem.
- `Dorflex 30 comprimidos`: essa embalagem não estava na amostra. Agora informa que a apresentação não foi encontrada, sem substituir por outra quantidade.
- `Allegra suspensão oral`: os títulos capturados não confirmam a forma. Não é inferida a partir de “pediátrico” ou do volume.
- `Neosoro 0,5mg/ml`: a concentração não consta nos títulos capturados. Agora informa a necessidade de conferência em vez de afirmar que o medicamento não existe.
- As terceiras páginas de Anlodipino e Hidroclorotiazida não foram capturadas na auditoria anterior. O replay trata isso como consulta parcial. A paginação completa foi validada separadamente com respostas simuladas de 120 produtos, não com novas chamadas reais.

## Testes Executados

Todos aprovados:

- 237 testes automatizados com `node --test`, sendo 91 da nova bateria de regressão de catálogo.
- 50 cenários de `npm run test:conversation-flow`.
- `npm run test:medicine-search`.
- `npm run test:payment-flow`.
- `npm run test:admin-payment-flow`.
- `npm run build`.
- `npm run lint`.
- `npx prisma generate`.
- `npx prisma validate`.

A nova bateria é repetível com `npm run test:catalog-regressions`. Não carrega credenciais, não acessa a rede, nem utiliza banco ou serviços reais. Fixtures: `scripts/fixtures/catalog-2026-09-23.json`.

## Arquivos Principais

- `src/utils/medicine-strength.util.ts` (novo): leitura e comparação de dosagem.
- `src/config/catalog-quality.config.ts` (novo): quarentena de cadastro.
- `src/integrations/commercial-medicine-selector.ts`: extração, identidade e ranking.
- `src/integrations/preco-popular.service.ts`: adaptação, qualidade, paginação, cache e estados.
- `src/integrations/medicine-search-orchestrator.service.ts`: restrições e motivos de descarte.
- `src/integrations/product-search-orchestrator.service.ts`: indisponibilidade no fluxo retail.
- `src/integrations/bula-api.service.ts`: contrato do resultado, sem reativar transporte externo.
- `src/whatsapp/conversation-engine.service.ts`: contexto, estados e proteção do carrinho.
- `src/whatsapp/whatsapp-copy.ts`: nomes íntegros e mensagens de diagnóstico apropriadas ao cliente.
- `scripts/validate-catalog-regressions.js` (novo), fixtures, gerador de fixture e ajustes nos testes existentes.
- `package.json`: comando da nova bateria.

## Publicação e Limites

- Não houve deploy, commit, envio ao GitHub ou alteração de `.env`.
- Não é necessária nova variável de ambiente nem migração do banco para estas correções.
- O build local em `dist` foi atualizado; o código-fonte completo está em `src`.
- Após publicar, reinicie a aplicação para substituir o código e os caches em memória. Em conversas que conservem listas antigas no banco, faça uma nova busca antes de validar o resultado da correção.
- A quarentena deve permanecer até revisão confiável do cadastro. Não foi corrigida a dose na origem.
- A API não comprova popularidade por vendas. Ranking comercial não é recomendação médica, e os testes não validam indicação clínica, receita, estoque próprio ou entrega.
- Dados incompletos continuam incompletos: o sistema agora evita equivalências não confirmadas. A equipe precisa conferir esses casos; a mensagem não representa abertura automática de uma tarefa de atendimento humano.
