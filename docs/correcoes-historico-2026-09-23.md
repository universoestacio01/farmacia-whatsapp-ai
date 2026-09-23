# Correcoes do historico - 23/09/2026

## Implementado localmente

- Quantidade comercial separada do conteudo: "uma embalagem com 12 unidades" significa uma embalagem. Conteudo divergente da apresentacao selecionada pede conferencia. Entradas como "1 ou 2", quantidades fracionarias e dois numeros nao sao concatenadas.
- Resposta de quantidade tem precedencia sobre nova busca quando o bot aguarda quantidade.
- Perguntas operacionais, referencias vagas, alteracao de pedido e nomes genericos de forma nao disparam consultas de medicamento. Regras de entrega desconhecidas nao sao inventadas.
- Listas de produtos pedem o primeiro item e seguem um produto por vez, preservando o carrinho. Nao ha importacao automatica de todos os itens da lista. Associacoes com "com", concentracoes mg/ml e kits explicitos nao sao separados como compras distintas.
- Nome de medicamento explicito tem precedencia sobre sugestao por sintoma. Celestrat nao e substituido automaticamente por Loratadina/Allegra.
- Colirio/oftalmico, injetavel e pastilha sao separados do nome. Parenteses vazios sao removidos: `Metronidazol (pomada)` consulta `metronidazol`, conservando a restricao de forma.
- Volume em ml e preservado como restricao; Tadalafila 20ml nao vira comprimidos de 20mg. Chaves de cache distinguem volumes e preferencias de tamanho.
- Correcao de forma apos leitura de embalagem preserva o nome, sem transportar dosagem de comprimido para gotas.
- Varejo normaliza `com16 unidades` e `sempre livres`, sem remover quantidade nem qualificadores como "sem abas".
- Fralda sem publico definido pede infantil/adulto; os filtros nao misturam ambos.
- Apresentacoes conhecidas iguais nao se repetem so por terem marcas diferentes. Embalagem "grande" prioriza maior volume/tamanho conhecido, sem fabricar atributos ausentes.
- Reservas preservam status HTTP e classificacao segura de falha. O motivo final distingue consulta principal, apresentacao nao correspondente e reserva indisponivel. Resultados validos da principal continuam encerrando a busca antes das reservas.

## Verificacao real

Foram feitas 10 chamadas ao Preco Popular: oito consultas iniciais e duas de conferencia. Nenhum pedido ou mensagem foi enviado.

| Consulta | Resultado observado |
| --- | --- |
| Colirio maxidex | Maxidex Colirio 5ml, R$ 9,99 |
| Metronidazol (pomada) | API respondeu; apresentacao solicitada nao confirmada. Sem HTTP 400 e sem substituicao por gel |
| Ozivy 1mg solucao injetavel | Nome localizado, mas atributos insuficientes para confirmar apresentacao; conferencia necessaria |
| Amoxicilina com clavulanato 875mg | Apresentacao/dosagens completas nao confirmadas; nao se presumiu a segunda dosagem |
| Olina grande | Olina 100ml primeiro, R$ 35,90 |
| Tadalafila 20ml | Nenhuma apresentacao em ml confirmada; nenhum comprimido selecionado silenciosamente |
| Absorvente Sempre Livre com16 unidades | Opcoes de 16 unidades retornadas |
| Absorventes sempre livres | Opcoes retornadas |

Precos e disponibilidade sao retratos das consultas, nao garantias futuras. O catalogo inclui produtos internos O.b. com "Sempre Livre" no titulo; o sistema exibe os nomes completos recebidos. Nao foi afirmado que todas as opcoes sao equivalentes nem que representam popularidade de vendas.

Relatorios publicos de produto, sem dados de clientes:

- `diagnostics/history-fixes-2026-09-23T14-29-33-842Z.json`
- `diagnostics/history-fixes-2026-09-23T14-34-36-173Z.json`

## Reservas e limites externos

Antes da atualizacao de chave informada pelo usuario, uma autenticacao PharmaDB retornou HTTP 401; uma consulta BulAPI retornou HTTP 502.

O usuario atualizou a chave e pediu prioridade ao Preco Popular, mencionando possivel limite excedido. A nova chave NAO foi testada para evitar consumir quota. Nao e possivel afirmar que o problema atual da PharmaDB seja quota ou que a nova chave esteja validada. O HTTP 502 da BulAPI tambem nao foi reparado localmente.

O codigo foi corrigido para isolar e registrar essas falhas; isso nao elimina indisponibilidade de servicos externos.

## Testes

- Build e lint aprovados.
- Suite de historico com exemplos anonimizados: quantidade, carrinho, listas, contexto, forma, ml, marcas, varejo, fraldas, duplicatas, caches e falhas de reservas.
- Suites existentes de catalogo, pagamentos, conversas, imagens e painel preservadas.
- Testes usam fixtures sinteticas; os exemplos reais foram consultados separadamente, com limite de chamadas e sem bootstrap da aplicacao.

Comandos:

```text
npm run build
npm run lint
npm run test:history-regressions
npm run test:conversation-flow
npm run test:medicine-search
npm run test:retail-flow
npm run test:payment-flow
npm run test:admin-payment-flow
```

## Publicacao

As mudancas estao somente na pasta de trabalho `farmacia-whatsapp-ai`. Nao houve edicao da pasta GitHub, push ou deploy na Hostinger. O .env atualizado pelo usuario foi preservado.

Para valer no WhatsApp, publicar o codigo atualizado pelo fluxo habitual, executar o build e reiniciar a aplicacao. Esta rodada nao exige migracao do banco. Nao publicar .env, env.hostinger, tokens ou extratos privados de historico.

Mensagens e pedidos antigos nao foram reescritos. Pedidos potencialmente incorretos do historico precisam de revisao manual antes de pagamento/entrega; nao se deve recalcular ou cancelar pedidos antigos automaticamente.
