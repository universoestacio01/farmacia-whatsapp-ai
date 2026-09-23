# Auditoria do historico do painel - 23/09/2026

## Alcance e metodo

- Consulta autenticada, somente GET, ao painel de producao.
- 50 conversas mais recentemente atualizadas; 1.014 mensagens retornadas.
- Limite do endpoint: 50 conversas e 100 mensagens por conversa, sem cursor.
- Uma conversa atingiu 100 mensagens: o inicio dela nao foi auditado.
- Nao e uma varredura integral do banco, nem uma amostra aleatoria dos clientes.
- Foram lidos os 200 registros mais recentes de provedores e o resumo de erros.
- 74 respostas foram sinalizadas por texto e revisadas. Isso NAO significa 74 bugs: ha repeticoes, respostas corretas a entradas invalidas e ocorrencias antigas.
- Destas, 54 dizem que nao foi possivel concluir a consulta, 12 dizem nao localizado, 4 recusam imagem e 4 pertencem a outras categorias.
- Os horarios abaixo estao em America/Sao_Paulo (UTC-3). Identidades, telefones, enderecos e pedidos foram omitidos.
- Sem chamadas novas ao Preco Popular, PharmaDB ou BulAPI. Sem WhatsApp enviado, reset, alteracao de pedido, pagamento ou deploy.
- Reproducoes locais usaram as classes compiladas atuais, sem rede e sem banco.
- Foram criados apenas este documento e um script de auditoria local. Nenhuma regra da aplicacao foi alterada nesta rodada.

## 1. Critico: quantidade de embalagens confundida com conteudo

Evidencia: 22/09, 22:31, cliente escreveu "Uma embalagem com 12 unidades". A resposta tratou 12 como dosagem (12mg). Mais adiante o atendimento chegou a um carrinho com 12 embalagens. Nao foi verificado pagamento ou entrega desse pedido.

Reproducao atual independente: `ConversationInputService.parseQuantity('Uma embalagem com 12 unidades')` retorna **12**. A funcao remove todos os caracteres nao numericos, sem separar quantidade pedida de unidades por embalagem. A resposta historica de 12mg pode ter vindo de uma versao anterior; nao foi reproduzida no motor completo atual.

Solucao: extrair quantidade comercial e conteudo separadamente; reconhecer "uma embalagem" como uma; pedir confirmacao quando ambiguo; nunca concatenar numeros de atributos. Testar frase completa no estado WAITING_QUANTITY e conferir carrinho e total.

Afetados: `src/whatsapp/conversation-input.service.ts:16`, `src/whatsapp/conversation-engine.service.ts:574`.

## 2. Alta: consulta enviada com parenteses vazios

Evidencia: 23/09, 10:27: "Metronidazol (pomada)" terminou em consulta inconclusiva. Log primario mostra **query `metronidazol ( )`, HTTP 400**.

Reproducao atual: `parseMedicineQuery` remove "pomada", mas deixa parenteses vazios dentro do nome.

Solucao: higienizar pontuacao residual depois da extracao de atributos, conservando a forma em campo proprio. Nao remover a restricao de forma para simplesmente mostrar qualquer produto.

Afetados: `src/integrations/commercial-medicine-selector.ts:167`, `src/integrations/preco-popular.service.ts:98`.

## 3. Alta: varios produtos viram uma unica busca

Exemplos reais:

- "1 Buscopan com / 1 Desloratadina": tres tentativas falharam; depois os nomes enviados separadamente encontraram produtos.
- "Cefalexina 500mg / Rifocina spray": query enviada `cefalexina rifocina`, HTTP 200 vazio.
- "um neosoro e uma caixa de glifage de 500": query enviada `neosoro e uma glifage`, HTTP 200 vazio.

Reproducao atual: o parser produz `buscopan desloratadina` como um unico nome.

Solucao: fila de itens solicitados e confirmacao individual. Distinguir lista de compra de principio ativo composto: nao dividir automaticamente "amoxicilina com clavulanato" como dois produtos.

Afetados: parser, reconhecimento de intencao e estados do `conversation-engine.service.ts`.

## 4. Alta: perguntas operacionais e respostas curtas viram produtos

Exemplos: "Entrega?" (10:56), "Voces fazem entrega a partir de qual valor do pedido" (11:06), "Vc tem esse remedio", "Serio", "Qual opcao", "2 desse". O retorno foi erro de catalogo, em vez de responder a duvida ou pedir o nome/confirmar contexto.

Reproducao atual: `parseMedicineQuery('Entrega?').medicineName` retorna `entrega`.

Solucao: classificar duvidas de entrega, alteracao de carrinho, confirmacoes e referencias ao produto antes de iniciar consulta. Mensagem sem identificacao suficiente deve pedir esclarecimento, sem acionar os provedores. Regras comerciais devem vir da configuracao real, sem inventar prazo ou pedido minimo.

Afetados: reconhecimento de intencao, `bula-api.service.ts`, `conversation-engine.service.ts:331`, `:370` e parser.

## 5. Alta: nome, forma e qualificadores ainda se misturam

Evidencias:

- "Colirio maxidex": HTTP 200, 1 produto normalizado; mesmo assim, resposta inconclusiva. Isso confirma descarte depois da resposta do catalogo, mas o registro persistido nao informa a regra final de rejeicao.
- "Ozivy 1mg solucao injetavel": query `ozivy injetavel`, HTTP 200 vazio. Posteriormente "Ozivy" retornou 3 produtos e o bot os mostrou.
- "Olina grande": HTTP 200 vazio. Nao houve teste novo de disponibilidade de Olina nesta auditoria.
- "Amoxicilina com clavulanato 875 mg": 23 resultados, 22 apos normalizacao do provedor, mas nenhuma opcao entregue. Exige investigar concentracao composta e comparacao de apresentacao; NAO concluir que se deve afrouxar a validacao.

Reproducao atual: o parser mantem `colirio maxidex`, `ozivy injetavel` e `olina grande` como nomes. A forma de Ozivy nao e identificada nessa expressao.

Solucao: separar nome, forma e tamanho; pesquisar o nome; validar atributos depois. Para formas, concentracoes ou associacoes nao confirmadas, pedir esclarecimento ou revisao humana. Produto encontrado nao implica apresentacao correta ou venda liberada.

Afetados: `commercial-medicine-selector.ts:167`, `medicine-search-orchestrator.service.ts:97`, `preco-popular.service.ts:98`.

## 6. Alta: filtros de varejo rejeitam variacoes simples

Evidencia: "Absorvente sempre livre com16 unidades" retornou 16 resultados normalizados; "Absorventes sempre livres" retornou 14. O cliente recebeu "Nao localizei esse produto" em ambas.

Reproducao isolada atual: `matchesRetailQuery` rejeita um titulo compativel, `Absorvente Sempre Livre com 16 Unidades`, para os dois textos. `com16` nao e separado e `livres` e cobrado como palavra literal. O titulo de teste e uma fixture sintetica; nao foi feito download novo dos produtos dessas consultas.

Solucao: normalizar separacao entre letras/numeros e plurais controlados de categorias/marcas, preservando restricoes como quantidade, modelo, tamanho e "sem abas". Nao aceitar qualquer absorvente para preencher a lista.

Afetados: `src/utils/retail-search-query.util.ts:70`, `src/integrations/product-search-orchestrator.service.ts:195`.

## 7. Alta: uma marca solicitada e substituida pelo fluxo de sintomas

Evidencia: "Antialergico Celestrat" gerou lista de Loratadina e Allegra. "Alivio rapido dor de garganta pastilhas strepsils" gerou outros nomes e formas.

O codigo atual verifica sintomas antes da busca nominal em `handleIdle` e `handleWaitingMedicineName`. Nao foi feita reproducao completa desses turnos nesta auditoria.

Solucao: pedido nominal explicito deve ter precedencia. Pedido generico por sintoma precisa de fluxo proprio e, quando aplicavel, orientacao da equipe, sem tratar produtos diferentes como substitutos intercambiaveis.

Afetados: `src/whatsapp/conversation-engine.service.ts:353`, `:375`, regras de sintomas e classificacao de intencao.

## 8. Alta: unidade invalida e diversidade comercial

Evidencia: "Tadalafila 20ml" gerou comprimidos de 20mg e 5mg sem esclarecer a unidade. A lista tinha duas marcas da mesma apresentacao de 20mg com 4 comprimidos.

Reproducao atual: o parser remove 20ml e produz nome `tadalafila`, sem preservar o volume como restricao nessa consulta.

Solucao: conservar unidades nao compreendidas e pedir confirmacao; nao converter ml em mg. Selecionar primeiro apresentacoes distintas por composicao, dosagem, forma e tamanho; mostrar marcas equivalentes como alternativas identificadas, nao repetir apresentacao quando houver diversidade valida.

Outro ponto: busca generica de fralda XG misturou modelos infantis e adulto. Deve esclarecer o publico antes da selecao.

Afetados: parser, ranking do `commercial-medicine-selector.ts`, busca de varejo e clarificacoes de estado.

## 9. Alta: reservas falhando mascaram o motivo original

Nos 200 registros examinados:

| Provedor / resultado | Registros |
| --- | ---: |
| Preco Popular, sucesso HTTP 200 | 36 |
| Preco Popular, sucesso HTTP 206 | 9 |
| Preco Popular, vazio HTTP 200 | 43 |
| Preco Popular, falha | 3 |
| PharmaDB, FAILED / backup_unavailable | 54 |
| BulAPI, FAILED / backup_unavailable | 55 |

Os 109 registros de reserva NAO sao 109 chamadas HTTP: alguns terminaram imediatamente por indisponibilidade/cooldown. O painel nao armazenou status HTTP nem causa detalhada dessas reservas, portanto nao permite afirmar aqui se foi credencial, quota ou falha remota.

As tres falhas primarias: HTTP 400 com parenteses vazios; timeout de 8 segundos em busca generica de dor de ouvido; HTTP 500 para cefalexina. Depois houve sucesso para cefalexina, indicando que ao menos esse episodio foi transitorio.

O orquestrador pode transformar busca primaria vazia/sem apresentacao + reserva indisponivel em `unavailable`. Assim, muitas mensagens de "consulta inconclusiva" nao significam queda do Preco Popular.

Solucao: preservar separadamente resultado primario, motivo de descarte e resultado das reservas; gravar motivo final com correlation ID. Manter informacao de busca parcial sem afirmar inexistencia. Corrigir conectividade das reservas separadamente, sem gerar preco ou disponibilidade presumidos.

Afetados: `medicine-search-orchestrator.service.ts`, provedores de reserva, `ProviderRequestLogService`, painel de erros.

## Historico antigo versus estado atual

- Quatro recusas de imagem sao de 22/09 a noite. Nas conversas de 23/09 de manha ha leitura de embalagem com confirmacao funcionando. Nao classificar todas as ocorrencias antigas como defeitos ativos.
- A confusao Lozartana/Losartana e a resposta 12mg precisam de replay completo com o codigo atual antes de afirmar que seus caminhos antigos continuam ativos.
- A correcao anterior de Elexir/Elixir e ordem de palavras existe localmente; esta auditoria nao publicou essa correcao nem confirmou a versao exata implantada na Hostinger.
- O resumo de erros informou 11 mensagens FAILED e nenhum pagamento FAILED. Isso nao prova saude de todos os pagamentos nem que as 11 falhas pertencem a esta amostra.
- A amostra inclui testes antigos e pode incluir clientes reais; nao estimar taxa global de erro ou conversao a partir destes numeros.

## Ordem recomendada

1. Quantidade comercial, unidades invalidas e precedencia de medicamento nominal.
2. Consultas com parenteses, qualificadores de forma e filtros de varejo.
3. Perguntas operacionais, referencias contextuais e multiplos itens.
4. Diagnostico das reservas, motivo final persistido e fila de revisao humana.
5. Diversidade de apresentacoes, publico das fraldas e correcoes ortograficas controladas com confirmacao quando ambiguas.
6. Replay automatizado dos exemplos anonimizados e verificacao da versao implantada.
7. Paginacao por cursor para auditar o historico completo sem acessar diretamente o banco.

## Reexecutar a leitura

`node scripts/audit-panel-history.js --live`

O script usa a credencial ADMIN_TOKEN do .env apenas no header do dominio do painel, nao imprime o token e faz no maximo 55 GETs. Extratos curtos ficam em arquivo temporario local fora do repositorio; ainda devem ser tratados como dados privados. Nao executa automaticamente no servidor e nao consulta provedores de medicamentos.
