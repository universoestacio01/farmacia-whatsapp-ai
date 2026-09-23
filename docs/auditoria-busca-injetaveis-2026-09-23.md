# Auditoria do catalogo e historico - 23/09/2026

## Escopo e privacidade

- Leitura autenticada da API do painel de producao, sem alterar conversas, pedidos ou pagamentos e sem enviar mensagens.
- 50 conversas recentes (limite efetivo do endpoint), com 1.246 mensagens. Tres conversas atingiram a janela de 100 mensagens; o historico mais antigo dessas conversas nao foi analisado.
- 200 registros tecnicos recentes, entre 12:31 e 13:54 de 23/09, horario de Brasilia. O historico de mensagens tambem contem versoes anteriores do sistema; nao se deve atribuir toda falha antiga ao codigo atual.
- Nomes de clientes, telefones, enderecos, comprovantes, tokens e transcricoes completas nao foram copiados para este relatorio.
- Nove requisicoes reais ao catalogo publico Preco Popular, somando a reproducao inicial e a verificacao final. Nenhuma chamada paga da OpenAI, PharmaDB ou BulAPI neste trabalho.

## Corrigido no projeto local

### Exclusao geral de injetaveis/hospitalares

Em producao, Ozempic retornou dois produtos e Mounjaro seis, ambos com HTTP 200. A selecao descartou todos como `restricted`. O erro nao era ausencia de produto no catalogo.

Removidas exclusoes e penalizacoes por essas categorias no orquestrador de medicamentos, seletor comercial, rota de varejo e validacao de ofertas web. A caracteristica injetavel/hospitalar continua identificada como metadado; deixou de significar automaticamente embalagem grande ou inelegivel.

Continuam os filtros de nome, apresentacao explicitamente pedida, dosagem, quarentena, preco valido e verificacao da oferta. Um pedido por comprimidos nao pode ser atendido com injetavel. A elegibilidade comercial nao comprova estoque proprio nem autorizacao de dispensacao; esta mudanca nao implementa validacao de receitas ou requisitos sanitarios.

### Apresentacoes injetaveis

- Volumes decimais como 0,5 ml e 1,5 ml sao preservados.
- O volume do denominador de uma concentracao nao e confundido com o tamanho do frasco.
- Quantidades de canetas, ampolas e seringas sao extraidas do rotulo.
- Uma dose literal em mg de uma apresentacao injetavel nao vira concentracao inventada em mg/ml.
- Mounjaro `5mg/0,5ml`, em embalagem explicitamente descrita como canetas de 0,5 ml, pode corresponder ao pedido `5mg`. A regra exige coincidencia exata do denominador com o volume explicitamente declarado por caneta. Nao multiplica concentracao pelo volume de frascos, nao equivale a `5mg/ml` e nao aceita rotulos marcados como multidose.
- A mesma correspondencia e aplicada na busca principal, reserva web, ranking e continuacao contextual `Tem de 5mg?`.

### Frases observadas nas conversas

- `uma pergunta forxiga`: o prefixo conversacional contaminava a consulta. Agora consulta `forxiga`.
- `comprar itraconazol 100 mg capsula dura`: o qualificador `dura` ficava no nome. Agora consulta `itraconazol`, preservando 100 mg e capsula como atributos.
- `Nao, obrigada`: a virgula impedia reconhecer a recusa apos uma busca sem oferta. Agora responde ao encerramento sem consultar catalogos, preservando o carrinho.

## Verificacao real final

| Consulta | Resultado local usando catalogo publico | Preco observado |
| --- | --- | --- |
| Ozempic | 2 apresentacoes elegiveis | R$ 1.275,44 e R$ 1.275,46 |
| Mounjaro | 6 encontrados; 3 apresentacoes selecionadas | R$ 1.905,60; R$ 2.382,23; R$ 2.766,26 |
| Mounjaro 5mg | Somente canetas 5mg/0,5ml | R$ 2.382,23 |
| Mounjaro comprimido | Nenhuma apresentacao correspondente | Sem preco inventado |
| uma pergunta forxiga | Forxiga 10mg, 30 comprimidos | R$ 89,90 |
| comprar itraconazol 100 mg capsula dura | Capsulas 100mg, embalagens com 4 ou 15 | R$ 26,46 e R$ 50,39 |

Precos pontuais publicados pela fonte no momento do teste, sem desconto adicional, sem garantia de estoque proprio. Nao sao recomendacoes de tratamento.

## Outros achados e pendencias

1. **Intencoes administrativas tratadas como produto.** `Gostaria de acompanhar um pedido`, `Reembolso` e perguntas genericas de preco chegaram ao catalogo. Necessitam roteamento dedicado para pedido existente e esclarecimento contextual, sem consultas web desnecessarias. Nao corrigidos neste escopo.
2. **Consulta por sintoma perdeu o contexto.** No historico, uma pergunta sobre refluxo gerou a busca `o que vc indica?`. Nao ha motivo para consultar essa frase como nome de produto. Necessita revisao da extracao de intencao; nao deve inventar indicacao, dose ou troca terapeutica. Nao corrigido neste escopo.
3. **Pedidos ambiguos e erros de digitacao.** Exemplos: `leite apitamil 0 a6`, `leite de magnesio eno`, `tadalafia de 20 g`. O ultimo inclui unidade que nao pode virar mg silenciosamente. Precisam de esclarecimento ou confirmacao de nome/unidade; nao foi comprovado que cada termo possua uma oferta correspondente.
4. **Fonte web bloqueada ou incompleta.** Nos 200 registros, houve 43 verificacoes de pagina com `page_unavailable_or_blocked` e 19 com `product_or_offer_not_verified`. As 22 descobertas com `no_verified_public_offer` sao etapas agregadas, nao falhas adicionais de clientes. Retornar algum numero sem uma oferta verificavel esconderia esses problemas. Nao se contornou bloqueio de acesso nem se alterou validacao de precos.
5. **Apresentacao especifica diferente da encontrada.** `itraconazol 100mg 15 comprimidos` retornou quatro produtos na principal, descartados por apresentacao. No teste atual, foram encontradas capsulas. O fluxo deveria esclarecer essa diferenca, nao trocar automaticamente comprimido por capsula.
6. **Rotulos com varias doses no mesmo dispositivo.** O titulo integral de Ozempic `0,25 e 0,5mg` e preservado, mas o extrator atual registra apenas a ultima dosagem com unidade explicita. A busca generica funciona; refinamento por `0,25mg` ainda precisa de tratamento especifico de apresentacoes multidose. Nao se presumiu equivalencia automatica para esses rotulos.
7. **Selecao numerica repetida.** Algumas conversas repetem `3` e recebem opcao nao identificada. Necessita auditoria da lista enviada, IDs e estado da conversa nesse instante. O historico sozinho nao prova se a opcao 3 ainda estava disponivel; nao alterado neste escopo.

## Validacao e publicacao

- Build NestJS e ESLint dos arquivos alterados: aprovados.
- 592 testes automatizados: aprovados, incluindo fontes principal/web, selecao, quantidades, mudanca contextual de dose, checkout, nomes, roteamento e painel.
- 50 cenarios adicionais de conversa e testes de Pix direto: aprovados.
- Testes de regressao usam dados sinteticos ou capturas publicas existentes, sem dados de clientes.
- Alteracoes somente locais. Publicar esta versao e reiniciar a aplicacao na Hostinger para que o WhatsApp use as novas regras. Nenhuma migracao de banco ou mudanca de variavel de ambiente necessaria.
