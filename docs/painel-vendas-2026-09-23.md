# Vendas e comprovantes no painel

## Regra comercial

- Uma venda corresponde a um pedido com comprovante recebido OU com pelo menos um pagamento PAID.
- Comprovante sem confirmacao = venda aguardando compensacao. Nao altera OrderStatus, PaymentStatus, entrega ou mensagens do WhatsApp.
- O botao Compensou continua sendo a confirmacao bancaria manual.
- Pedidos CANCELLED e DRAFT nao entram nas vendas. Comprovantes e pagamentos repetidos nao multiplicam o valor do pedido.
- Comprovante recebido significa imagem/documento recebido durante a espera do Pix; nao significa autenticidade ou compensacao comprovada.

## Historico e associacao

O relatorio usa os registros existentes, sem migracao nem atualizacao em massa. O marcador de comprovante deve ser uma mensagem INBOUND/CUSTOMER com o conteudo exato `[comprovante de pagamento recebido]`.

Cada comprovante e associado ao ultimo pedido criado naquela conversa antes da mensagem, desde que ja existisse um pagamento. Um pedido posterior delimita a janela do anterior, inclusive se estiver cancelado. Pedidos simultaneos ambiguos nao recebem associacao automatica. Mensagens enviadas fora desse fluxo e comprovantes cujo historico foi removido nao podem ser recuperados por inferencia.

## Vendas

- Aba Vendas: valor vendido, compensado, aguardando compensacao, ticket medio e grafico diario.
- Periodos de 7, 30, 90 dias ou todo o historico.
- Datas agrupadas pela criacao do pedido em America/Sao_Paulo. Nao e um extrato por data de credito bancario.
- Filtros de cliente/produto/pedido, situacao e comprovante afetam indicadores, grafico e exportacao.
- Clique em um dia restringe a lista e exportacao; indicadores permanecem referentes ao periodo.
- Lista com carregamento incremental de 50 registros; totais usam todo o periodo, nao somente os registros exibidos.
- Exportacao CSV protegida contra formulas inseridas em nomes de clientes.
- Dados atualizados pela mesma atualizacao automatica do painel; falhas de leitura sao exibidas como erro, nao vendas zeradas.

## Ordenacao

Pedidos e compensacoes sao ordenados por createdAt desc, com id desc como desempate, antes de aplicar limite. Comprovantes nao deslocam pedidos antigos para o topo. A fila operacional continua limitada aos 100 pedidos mais recentes; a aba Vendas permite consultar todos os comprovantes reconhecidos no historico.

## Publicacao e testes

Arquivos principais: src/admin/admin-sales.ts, admin.service.ts, admin.controller.ts; public/admin/index.html, app.js, sales.js, styles.css.

Nao exige migracao de banco ou novas variaveis. Publicar backend e arquivos public/admin juntos, executar build e reiniciar a aplicacao. O projeto local nao publica automaticamente na Hostinger.

Validacao sem clientes reais: npm run build; npm run test:admin-sales; npm run test:admin-payment-flow; npm run test:admin-stability; npm run test:admin-ui. A demonstracao npm run preview:admin usa somente dados ficticios e nao conecta banco, WhatsApp, catalogo ou banco financeiro.
