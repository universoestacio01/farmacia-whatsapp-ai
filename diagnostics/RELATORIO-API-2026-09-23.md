# Teste real do catalogo - 23/09/2026

## Conclusao

A API Preco Popular respondeu corretamente nas oito buscas reais por nome. Retornou produtos, precos positivos, EANs e URLs de imagem. O codigo preservou o preco retornado, sem o desconto antigo de 10%.

Isso nao significa que o fluxo inteiro esteja correto: foram reproduzidos problemas de interpretacao de quantidade, concentracao, forma farmaceutica e nomes exibidos, descritos abaixo. Nao foram alteradas regras do atendimento neste diagnostico.

## Escopo e consumo

- Execucao: 23/09/2026, aproximadamente 00:05, horario de Brasilia.
- Provider: `preco_popular`, endpoint `https://www.precopopular.com.br/api/catalog_system/pub/products/search`.
- 8 medicamentos distintos, 9 requisicoes HTTP de catalogo: Dipirona precisou de duas paginas.
- 4 variacoes adicionais atendidas pelo cache: Dipirona 1g, Dipirona 1000mg, Venvanse 50mg e Venvanse 70mg.
- 2 requisicoes HEAD para imagens; ambas HTTP 200 e `image/jpeg`.
- Uma tentativa anterior foi bloqueada localmente com EACCES, sem receber status HTTP. Nao foi uma rejeicao do fornecedor. A execucao autorizada seguinte teve sucesso.
- Nenhuma chamada a PharmaDB, Cosmos, BulAPI, OpenAI, WhatsApp ou pagamentos. Nenhum pedido criado.
- Classes compiladas do projeto foram usadas para consultar, normalizar e selecionar resultados; build aprovado.
- Regras de prioridade padrao do codigo. Nao foi acessado o banco de producao, portanto prioridades personalizadas no painel nao foram verificadas.
- A disponibilidade observada pertence ao catalogo consultado, nao ao estoque proprio nem a uma promessa de entrega por CEP.

## Resultados reais

| Busca | HTTP | Produtos brutos | Apos filtros iniciais | Opcoes selecionadas e precos |
|---|---|---:|---:|---|
| Dipirona | 206 + 200 | 74 | 74 | Novalgina 500mg, 10 comprimidos: R$ 15,75; Novalgina 1g, 10 comprimidos: R$ 21,90; Novalgina gotas 500mg/ml, 10ml: R$ 15,75 |
| Novalgina | 200 | 13 | 13 | As mesmas tres apresentacoes acima |
| Dorflex | 200 | 12 | 12 | Max, 8 comprimidos: R$ 15,31; Uno 1g, 10 comprimidos: R$ 16,40; gotas 20ml: R$ 21,80 |
| Neosoro | 200 | 6 | 5 | Adulto 30ml: R$ 5,99; Infantil gotas 30ml: R$ 9,45; Fluid 0,9%, 50ml: R$ 18,74 |
| Ibuprofeno | 200 | 42 | 40 | Neo Quimica 400mg, 10 comprimidos: R$ 11,82; Alivium 600mg, 10 capsulas: R$ 47,99; Alivium 100mg/ml, 20ml: R$ 41,90 |
| Venvanse | 200 | 3 | 3 | 30mg, 28 capsulas: R$ 429,90; 50mg, 28 capsulas: R$ 504,90; 70mg, 28 capsulas: R$ 529,90 |
| Allegra | 200 | 10 | 10 | 120mg, 10 comprimidos: R$ 55,10; 180mg, 10 comprimidos: R$ 88,83; pediatrico 6mg/ml, 60ml: R$ 34,90 |
| Amoxicilina | 200 | 41 | 39 | Cimed 500mg, 21 capsulas: R$ 22,47; EMS 875mg, 14 comprimidos: R$ 38,60; Cimed 250mg/5ml, 150ml: R$ 20,66 |

Valores e disponibilidade sao um retrato do instante do teste, nao uma tabela fixa nem recomendacao de medicamento/dosagem.

Os filtros descartaram 1 oferta indisponivel em Neosoro, 2 em Ibuprofeno e 2 em Amoxicilina. Nenhum item foi descartado por JSON invalido ou ausencia de preco nesta amostra. Resultados brutos podem conter combinacoes e variacoes de uma mesma marca; a contagem nao representa apresentacoes clinicamente equivalentes.

Tempo total por busca inicial, incluindo resposta e processamento local: aproximadamente 0,20 a 2,49 segundos. HTTP 206 em Dipirona significou uma pagina parcial normal; a segunda pagina foi consultada e os 74 resultados foram carregados.

## Variacoes que funcionaram

- `dipirona 1g` e `dipirona 1000mg`: as mesmas opcoes de 1g. Nenhuma opcao de 500mg foi selecionada.
- `venvanse 50mg`: somente 50mg, por R$ 504,90.
- `venvanse 70mg`: somente 70mg, por R$ 529,90.
- `venvanse` sem dosagem: 30, 50 e 70mg, sem repeticao.
- `dipirona` sem dosagem: 500mg, 1g e gotas; nao ficou restrita a tres comprimidos de 500mg.

Em Dipirona 1g, o verificador simples marcou duas linhas como parecidas (1g, 10 comprimidos), mas os produtos sao convencional e efervescente, com EANs diferentes. Nao se deve excluir essa diferenca como se fosse uma duplicacao identica.

## Problemas reproduzidos

Os testes abaixo nao gastaram novas chamadas: usaram respostas normalizadas capturadas da API e instancias independentes do seletor. Isolam o processamento local; nao equivalem a novas consultas HTTP com esses termos completos.

### 1. Quantidade solicitada pode ser ignorada - alta prioridade

- Entrada: `dorflex 30 comprimidos`.
- O parser reconhece o nome e a forma, mas nao preenche `packageQuantity`.
- O seletor retorna embalagens de 8, 10 e 20 comprimidos.
- Afeta `src/integrations/commercial-medicine-selector.ts` e a filtragem do orquestrador.
- Correcao recomendada: distinguir quantidade da embalagem de quantidade de caixas solicitadas e respeitar a embalagem explicita. Nunca apresentar outra quantidade como correspondencia exata.

### 2. Concentracoes com denominador numerico sao interpretadas incorretamente - alta prioridade

- Entrada: `amoxicilina 250mg/5ml`.
- Parser gerou nome `amoxicilina /` e dosagem `250mg`, perdendo `/5ml`.
- Alimentado com os produtos reais da busca por Amoxicilina, o filtro eliminou apresentacoes explicitamente `250mg/5ml` e selecionou rotulos que informavam apenas `250mg`.
- Afeta parser em `commercial-medicine-selector.ts` e comparacao de dosagem em `medicine-search-orchestrator.service.ts`.
- Correcao recomendada: representar concentracao com numerador e denominador; preservar a unidade integral e exigir confirmacao quando os dados forem insuficientes.
- Nao foi feita consulta HTTP adicional para o termo incorreto `amoxicilina /`; o defeito demonstrado aqui e de parsing/filtragem.

### 3. Forma farmaceutica faltante pode produzir falso negativo - alta prioridade

- `allegra 6mg/ml` encontra produtos pediatricos de 60 e 150ml.
- `allegra suspensao oral` retorna zero no processamento local desses mesmos resultados.
- Os itens foram normalizados com forma `outro`; a consulta com `suspensao oral` e classificada como `solucao oral`, expondo tambem uma confusao entre formas.
- `neosoro 0,5mg/ml` igualmente retorna zero porque nenhum item capturado tem dosagem normalizada: os titulos nao informam essa concentracao, e `0,9%` nao e extraido pelo padrao atual.
- Nao e possivel afirmar que Neosoro corresponde a concentracao solicitada sem obter essa informacao de outro campo confiavel do proprio catalogo. Nao preencher por suposicao.
- Correcao recomendada: enriquecer atributos estruturados e distinguir dado ausente de incompatibilidade real, mantendo a confirmacao do cliente quando necessario.

### 4. Encurtamento do nome apaga detalhes e aparenta duplicacao - alta prioridade

- A API retorna Allegra pediatrico `6mg/ml ... 60ml Com Seringa`.
- O nome exibido termina em `... Framboesa 6mg`, perdendo `60ml` e repetindo parte da concentracao.
- Em `allegra 6mg/ml`, dois EANs distintos ficaram com o mesmo titulo visivel, embora tenham precos R$ 34,90 e R$ 34,99.
- Causa localizada em `src/whatsapp/whatsapp-copy.ts`, funcao `limitDisplayName`: corte por comprimento e sufixo extraido do primeiro numero/unidade.
- Correcao recomendada: montar nome curto com campos confiaveis de produto, concentracao, volume e apresentacao. Nunca cortar no meio de unidade ou inventar um sufixo de dose.

### 5. Imagem presente nao garante foto da embalagem

- Todos os selecionados tinham URL de imagem. Duas URLs de Novalgina foram verificadas por HEAD com HTTP 200.
- Venvanse e outros medicamentos retornam URLs com nomes como `rotulo_pp_tarja_preta.jpg` e `rotulo_pp_generico_retencao_receita.jpg`, indicativos de imagens genericas de rotulo, nao fotos especificas verificadas da embalagem.
- As demais imagens nao foram baixadas ou verificadas visualmente neste teste.
- Correcao recomendada: diferenciar imagem generica de foto do produto e nao usar imagem generica como evidencia de identificacao.

## Limites do resultado

Nao foram testados o webhook em producao, mensagens reais, filas, carrinho persistido, pedidos ou pagamentos. O catalogo nao fornece prova de popularidade por vendas: as tres opcoes refletem as regras comerciais atuais. Linhas diferentes de uma marca, como Dorflex Max e Uno, nao devem ser apresentadas como equivalentes automaticamente.

## Evidencias

- `live-catalog-2026-09-23T03-05-16-027Z.json`: URLs, status, tempos, JSON bruto recebido, descartes e selecao.
- `captured-catalog-replay-2026-09-23.json`: seis variacoes com zero chamadas externas, isolando parsing e filtros.
- `live-catalog-2026-09-23T03-05-00-785Z.json`: tentativa anterior bloqueada pelo ambiente local, nao usar como evidencia de falha da API.
- Script reutilizavel: `node scripts/diagnose-live-catalog.js`. Executar novamente consome novas consultas reais; limite de 16 requisicoes de catalogo por execucao.

Nenhum token ou dado de cliente foi incluido nos relatorios.
