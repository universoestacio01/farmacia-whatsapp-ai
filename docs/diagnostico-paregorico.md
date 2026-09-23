# Diagnostico: Elexir paregorico

## Evidencias locais de 23/09/2026

Fonte mantida: Preco Popular. Nao houve troca para Droga Raia.

Antes da correcao, chamadas reais ao mesmo endpoint usado pelo bot mostraram:

| Termo enviado a API | HTTP | Produtos |
| --- | --- | --- |
| elexir paregorico | 200 | 0 |
| elixir paregorico | 200 | 1 |
| paregorico | 200 | 1 |

Produto: Paregorico Catarinense Elixir 30ml, SKU 3494, EAN 7896023701436.
Preco observado: R$ 24,12, campo Price da oferta, sem desconto adicional.

Mesmo com a grafia correta, executar o orquestrador antigo com "Elixir paregorico"
retornou not_found. "Paregorico" sozinho retornou found. O filtro exigia uma frase
continua: nao reconhecia as palavras em outra ordem ou separadas pelo fabricante.

O print do painel mostra uma falha de consulta, nao uma resposta de produto
inexistente. O codigo pode produzir essa mensagem quando a principal retorna
vazio e as reservas falham. Esse caminho foi reproduzido em teste isolado; os
logs da Hostinger daquele atendimento nao foram acessados. Portanto, isso nao
comprova a causa de todas as mensagens de erro em producao.

## Correcao

- Normalizar a grafia especifica elexir -> elixir, acentos, caixa e espacos.
- Aceitar todas as palavras completas do nome em outra ordem no titulo do produto.
- Nao juntar palavras dispersas entre fabricante, principio ativo e titulo.
- Preservar os bloqueios de formulacoes compostas, dosagem e forma solicitadas.
- Nao inferir concentracao a partir do volume de 30ml.
- Registrar termo recebido/consultado e separar resultado da principal, falha
  das reservas e resultado final no log MEDICINE_SEARCH_OUTCOME.
- Manter o motivo tecnico quando a propria fonte principal falha.

Nao foi introduzida correcao aproximada arbitraria entre nomes de medicamentos.
Esta regra corrige tambem outros titulos com palavras reordenadas, mas nao permite
afirmar que todos os demais erros do historico estejam resolvidos.

## Verificacao depois da correcao

Chamadas reais pelas classes do projeto encontraram o produto para:
Elexir paregorico, Elixir paregorico, Tem elexir paregorico? e Paregorico.
Dipirona e Novalgina tambem retornaram opcoes com preco e apresentacoes distintas.
As variantes normalizadas compartilharam cache. A rodada final gastou 5 chamadas
no Preco Popular; nenhuma na PharmaDB ou BulAPI.

Relatorio gerado:
`diagnostics/medicine-names-2026-09-23T14-02-41-321Z.json`

Testes offline adicionais verificam o fluxo de conversa ate o carrinho, preco
integral, uso de cache, rejeicao de nomes diferentes e preservacao de restricoes.

```text
npm run build
npm run lint
npm run test:medicine-names
node scripts/diagnose-medicine-names.js --live
```

O ultimo comando faz chamadas reais limitadas, sem carregar .env, criar pedido,
gerar Pix ou enviar WhatsApp. Nao deve rodar automaticamente no bootstrap.
As mudancas estao apenas na pasta de trabalho; nao foi feito deploy na Hostinger.
