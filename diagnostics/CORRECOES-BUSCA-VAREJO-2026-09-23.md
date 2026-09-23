# Correções de Busca e Conversa no Varejo

Data: 23/09/2026. Alterações na cópia local `farmacia-whatsapp-ai`.

## Causa do Erro do Print

A intenção de varejo era reconhecida, mas a grafia `gilete` chegava sem normalização ao catálogo e aos filtros. O filtro de marca também podia interpretar o texto restante da consulta como uma marca obrigatória. Assim, grafias diferentes do mesmo produto podiam gerar resultados diferentes.

Agora `gilete`, `gilette` e `Gillette` geram a mesma consulta canônica e compartilham o cache. Isso corrige a interpretação; não garante disponibilidade no catálogo externo.

## Correções Aplicadas

| Problema | Correção |
|---|---|
| Grafias populares e plurais não reconhecidos | Lista central de 78 variantes de nomes de varejo, como xampu, pasta de dente, camisinha, lenços umedecidos, Oral B e Mach 3. |
| Termos danificados pela limpeza | Remoção de saudações e prefixos de conversa, preservando palavras internas de nomes como aparelho de barbear. |
| Marca confundida com categoria | O tipo explícito tem precedência: escova Oral-B não vira creme dental; lenços Pampers não viram fraldas. |
| Volume, modelo ou tamanho tratado como marca | Marca extraída apenas de nomes conhecidos; os demais detalhes continuam como restrições da consulta. |
| Resultados que ignoravam detalhes pedidos | Filtros preservam marca, modelo, volume, tamanho e qualificadores explícitos, como sem álcool. |
| Volume confundido com FPS | 50ml não significa FPS 50. Quando necessário, o bot pergunta o FPS. |
| Resposta curta confundida com medicamento | Respostas contextuais como quero Seda, quero a G e pode ser 50 continuam a pergunta de varejo. |
| Contexto antigo de medicamento | Uma nova consulta de higiene não herda a dosagem do medicamento anterior. |
| Troca de produto enquanto aguarda quantidade | Um nome reconhecido, como Mach 3, pode iniciar outra busca sem adicionar o item anterior ao carrinho. |
| Nomes longos válidos descartados | Limite avaliado no nome individual, não na soma repetida de nome, descrição, marca e categoria. |
| Vários produtos na mesma mensagem | Para categorias reconhecidas, como shampoo e condicionador, pergunta por qual começar, preservando o carrinho. Kits explícitos continuam sendo pesquisados como kits. |
| Números soltos viravam código de barras | GTIN aceito apenas como identificador completo, não concatenando números de volumes e modelos. |
| Popularidade afirmada sem comprovação | Pergunta de marca passou a dizer marcas para consultar, sem afirmar demanda ou estoque. |

Equivalências de volume e peso também são normalizadas, por exemplo 0,4L para 400ml. Não foram adicionadas tentativas especulativas de API nem relaxamento automático dos detalhes pedidos.

## Validação

- 132 testes novos de linguagem de varejo, contrato do adaptador, filtros e conversa.
- 237 testes existentes de catálogo, dosagens, checkout, abertura, imagens e estabilidade administrativa.
- Total das sete suítes `node --test`: **369 aprovados, zero falhas**.
- `npm run test:conversation-flow`: 50 cenários aprovados.
- `npm run test:retail-flow`: aprovado.
- `npm run test:medicine-search`: aprovado.
- `npm run test:payment-flow`: aprovado.
- `npm run test:admin-payment-flow`: aprovado.
- `npm run lint`: aprovado.
- `npm run build`: aprovado.

A sequência do print foi reproduzida: cotonetes, gilete, Gillette, escolha, quantidade e carrinho. Os testes novos usam catálogo sintético e rede simulada. Parte dos testes anteriores reaproveita respostas reais capturadas na auditoria anterior. **Nenhuma nova chamada externa foi feita nesta rodada.**

## Arquivos

Novos:
- `src/config/retail-search-aliases.config.ts`
- `src/utils/retail-search-query.util.ts`
- `scripts/validate-retail-language.js`
- Este relatório.

Alterados:
- `src/config/retail-products.config.ts`
- `src/integrations/manual-retail-product.service.ts`
- `src/integrations/product-search-orchestrator.service.ts`
- `src/integrations/preco-popular.service.ts`
- `src/whatsapp/conversation-engine.service.ts`
- `src/whatsapp/whatsapp-copy.ts`
- `scripts/validate-conversation-flow.js` (adequação do serviço simulado ao contrato usado pela conversa).
- `package.json` (comando `test:retail-language`).

## Limites e Publicação

- Preço Popular continua sendo o único catálogo ativo, com preço integral. Nenhum preço foi inventado nem desconto reativado.
- Não há correção aproximada irrestrita de medicamentos: nomes parecidos não autorizam substituir medicamento, dosagem ou princípio ativo.
- A lista de grafias é curada; erros desconhecidos e disponibilidade real ainda dependem de análise e do catálogo.
- A pergunta sobre vários produtos não cria uma fila automática de todos os itens da mensagem.
- Site, painel, credenciais, esquema do banco e regras de pagamento não foram alterados nesta rodada. Nenhum pedido, pagamento ou WhatsApp real foi enviado.
- Não houve publicação na Hostinger nem cópia para a pasta do GitHub. As alterações precisam ser publicadas para aparecer no atendimento em produção.
