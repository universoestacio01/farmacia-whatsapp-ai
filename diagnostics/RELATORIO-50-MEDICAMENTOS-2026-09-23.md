# Auditoria Real: 50 Medicamentos
Data: 23/09/2026. Execução aproximada: 00:10 a 00:14 (Brasília).

## Conclusão

**A API funciona, mas o tratamento dos produtos ainda não está confiável para um atendimento automático sem essas correções.** Foram encontrados erros críticos de dosagem, nome, princípio ativo associado e seleção de apresentação.

Não confundir “retornou três produtos” com “passou no teste”. Algumas respostas continham preço e imagem, mas eram inadequadas à consulta.

## Escopo e Consumo

- 50 nomes distintos consultados em HTTP real, mais 12 variações de dosagem/apresentação. Variações reaproveitaram o cache quando possível.
- **64 chamadas reais de catálogo:** 54 respostas HTTP 200, 9 respostas HTTP 206 e 1 resposta HTTP 500.
- **4 verificações HEAD de imagem**, todas HTTP 200. Total desta rodada: 68 requisições externas.
- Uma falha HTTP 500 em Atenolol interrompeu a bateria. Após pausa e redução do ritmo, uma única repetição teve sucesso e os demais testes continuaram.
- Cada um dos 50 nomes teve retorno bruto de produtos após essa repetição.
- 47 nomes produziram opções no seletor de medicamentos. Coristina D e Resfenol tiveram falso negativo. Minancora é classificada como retail: o seletor de medicamentos vazio, isoladamente, não é erro.
- Também foram reproduzidas **62 mensagens no motor real de conversa, sem rede**, usando exatamente os JSONs capturados, para verificar o texto que seria enviado.
- Regras de prioridade padrão do código, sem consultar prioridades personalizadas no banco de produção.
- Nenhuma chamada a PharmaDB, Cosmos, BulAPI, OpenAI, WhatsApp ou pagamentos. Nenhum pedido, mensagem ou alteração no banco.
- O fluxo de produção não foi alterado. Foram criados/atualizados scripts e relatórios de diagnóstico.

## O Que Funcionou

- Todos os 138 produtos selecionados nas consultas básicas de medicamentos tinham preço positivo, EAN e URL de imagem; o preço foi preservado, sem o desconto antigo.
- Venvanse sem dose retornou 30, 50 e 70mg. As buscas específicas de 50mg e 70mg retornaram somente a dose pedida.
- Dipirona retornou 500mg, 1g e gotas. A equivalência 1000mg/1g funcionou.
- A segunda página foi lida quando necessária, respeitando o limite atual de duas páginas.
- Tempo de resposta HTTP com leitura do corpo: mediana aproximada de 663ms e percentil 95 de 1.693ms, entre as chamadas bem-sucedidas desta amostra. Não inclui as pausas do diagnóstico.
- Nenhum novo token ou dado de cliente foi colocado nos relatórios.

## Problemas Críticos

### 1. Dose em microgramas não é respeitada
**Evidência:** `euthyrox 50mcg` retornou 25, 50 e 88mcg. `puran t4 25mcg` retornou 12,5mg, 37,5mcg e 100mcg, embora o JSON da API contenha Puran T4 25mcg.

**Causa:** `extractRequestedDosage` reconhece o texto “mcg”, mas não calcula `dosageMg`. Tanto o filtro quanto a chave do cache dependem desse campo; consultas específicas acabam tratadas como “qualquer dosagem”. A falha também foi reproduzida com instância nova, portanto não é apenas cache antigo.

**Impacto:** exibição de apresentações diferentes da solicitação explícita.

**Correção:** preservar unidade e converter microgramas para comparação exata; incluir a concentração completa na chave do cache; impedir substituição silenciosa.

**Partes afetadas:** `src/integrations/commercial-medicine-selector.ts`, `src/integrations/medicine-search-orchestrator.service.ts`.

### 2. Formatação inventa um sufixo incorreto de dosagem
**Evidência real:**
- A API trouxe Buscopan Composto com `6,67mg/ml + ... 333,4mg/ml ... 20ml`; o título do sistema terminou em **“Dipirona 67mg”**.
- Polaramine `0,4mg/ml ... 120ml` passou a terminar em **“Sabo 4mg”**.
- Allegra `6mg/ml ... 60ml Com Seringa` ficou com **“Framboesa 6mg”**, ocultando volume e apresentação.

**Causa:** `limitDisplayName` corta o nome por comprimento e acrescenta um sufixo capturado por regex que não protege decimais nem concentrações.

**Impacto:** o texto visível contradiz a apresentação original, mesmo quando o campo interno de dosagem está correto.

**Correção:** gerar o título a partir de atributos estruturados; nunca cortar ou reconstruir unidades por fragmento.

**Parte afetada:** `src/whatsapp/whatsapp-copy.ts`.

### 3. Plenance associado a outro princípio ativo
**Evidência:** a API identifica os produtos Plenance com rosuvastatina; `knownSynonyms` e `brandByMedicine` associam Plenance a tadalafila.

O motor de conversa reproduziu literalmente o título **“Tenho estas opções de Tadalafila para você”** seguido de produtos Plenance Rosuvastatina.

**Impacto:** título, agrupamento, prioridades e possíveis alternativas usam um medicamento diferente do produto retornado.

**Correção:** corrigir e auditar associações manuais com fonte confiável; validar conflitos entre o catálogo e o mapeamento, sem inferir equivalência pela marca.

**Parte afetada:** `src/integrations/commercial-medicine-selector.ts`.

### 4. Injetável entra como alternativa em busca genérica
**Evidência:** `furosemida` selecionou **“Lasix com 5x2ml Solução Injetável 10mg/ml”**, como “dosagem alternativa”, junto de comprimidos.

A conferência offline encontrou `isInjectable: true` ao ler a descrição original e `isInjectable: false` no item enviado ao ranking.

**Causa:** o orquestrador reconstrói `packageInfo` a partir de um texto resumido como “outro”, perdendo os indicadores detectados pelo adaptador.

**Correção:** preservar os indicadores estruturados; definir restrição explícita de apresentação/via para buscas genéricas de varejo, sem depender apenas de pontuação.

**Partes afetadas:** `preco-popular.service.ts`, `medicine-search-orchestrator.service.ts` e seletor, em `src/integrations`.

### 5. Dado suspeito de unidade já vem da API
**Evidência:** o próprio JSON contém **“Puran T4 12,5mg”**, SKU 6291, EAN 7891058003555, enquanto as demais apresentações dessa linha vêm majoritariamente em mcg. Essa opção virou a primeira do ranking.

**Distinção importante:** esse “mg” não foi inventado pelo formatador. É uma inconsistência suspeita no cadastro de origem, que exige conferência; o teste não validou clinicamente a unidade correta.

**Correção:** sinalizar/bloquear registros com unidade inconsistente até validação por EAN e fonte confiável. Não “corrigir” uma dose por suposição.

## Problemas de Alta Prioridade

### 6. Coristina D e Resfenol existem, mas o bot diz que não encontrou
- Coristina D: 6 produtos recebidos com preço; todos descartados.
- Resfenol: 6 produtos recebidos com preço; todos descartados.
- O motor de conversa reproduziu “Não localizei esse medicamento agora” para ambos.

**Causa:** `isSameMedicine` elimina fórmulas com “;” no princípio ativo ou “+” no nome, exceto para uma lista fixa de marcas. Esses nomes não estão na exceção, mesmo quando a marca pesquisada corresponde ao produto.

**Correção:** separar busca exata de produto composto de substituição por princípio ativo. Um produto composto explicitamente pedido não deve ser rejeitado apenas por ser composto.

### 7. Quantidade da embalagem é ignorada
**Evidência:** `dorflex 30 comprimidos` retornou embalagens com 8, 10 e 20 unidades.

**Causa:** `extractPackageQuantity` depende de prefixos como “caixa”, “cx”, “cartela”; não reconhece o formato natural “30 comprimidos”.

**Correção:** separar quantidade de caixas e quantidade contida na embalagem; tratar a quantidade explícita como restrição, não como preferência.

### 8. Concentração com denominador numérico perde informação
**Evidência:** `amoxicilina 250mg/5ml` gerou termo `amoxicilina /` e dosagem `250mg`. A chamada real respondeu HTTP 200 com 41 produtos, mas a seleção privilegiou dois rótulos apenas “250mg” e descartou candidatos explicitamente “250mg/5ml”.

**Correção:** extrair numerador, unidade, denominador e volume separadamente. Não tratar dados incompletos como equivalência confirmada.

### 9. Marca não pode substituir a validação de composição
**Evidência:** `plenance` selecionou Plenance Eze, com princípio ativo adicional, junto do Plenance simples. `cimegripe` selecionou C+zinco como “forma alternativa”, sem princípio ativo preenchido para esse item.

**Impacto:** ranking por marca/forma pode agrupar linhas de composição diferente como se fossem alternativas diretas.

**Correção:** preservar a identidade e composição da linha; pedir confirmação da variante quando houver ambiguidade. Dados ausentes não devem autorizar equivalência.

### 10. Falha de API vira “produto não localizado”
**Evidência real:** Atenolol retornou HTTP 500 e depois HTTP 200 na repetição após pausa.

**Reprodução offline adicional:** após uma falha simulada, a busca por outro medicamento retornou zero sem nova chamada, devido ao cooldown global de 30 segundos. O orquestrador representa falha e busca vazia da mesma forma.

**Correção:** devolver estados distintos de indisponibilidade, resultado vazio e limitação temporária; retentativa limitada para falhas transitórias, sem ciclos de requisições.

## Outros Problemas

- **Formas não reconhecidas:** Allegra pediátrico é marcado “outro”; “Allegra suspensão oral” fica vazio. A regra de “oral” também captura suspensão antes da regra específica. Drágeas no plural e abreviações como “C/14 Cp” ficam incompletas.
- **Peso da embalagem vira dose:** Tamarine geleia de 150g é normalizado como dosagem de 150g; Polaramine creme incorpora o peso de 30g à concentração como `10mg/g+30g`.
- **Paginação incompleta:** Anlodipino informou 120 resultados, mas o código carregou 100; Hidroclorotiazida informou 119 e carregou 100. O limite de duas páginas pode esconder opções. O teste não buscou as páginas restantes deliberadamente.
- **Apresentações parecidas:** 9 das 50 consultas básicas tiveram pares com a mesma combinação de dosagem, forma e embalagem. Isso é um alerta, não prova automática de duplicidade: marcas, formulações e apresentações como efervescentes podem ser diferentes.
- **Nomes realmente iguais após truncamento:** na consulta Allegra 6mg/ml, dois EANs distintos ficaram com o mesmo título, prejudicando a escolha.
- **Minancora:** o catálogo retorna 6 produtos, 5 com oferta disponível, classificados como retail. O bot pergunta “qual marca?” e oferece “Minancora”, embora o cliente já a tenha informado. Não contar como falso negativo de medicamento.
- **Imagem genérica:** várias URLs são de rótulos de tarja, não fotos específicas da embalagem. Ter URL não comprova qualidade visual; só quatro imagens tiveram disponibilidade HTTP verificada nesta rodada.
- **Dados faltantes:** 6 consultas básicas tiveram alguma opção selecionada sem dosagem estruturada; 7 tiveram forma “outro”. Ausência de dado não deve ser resolvida inventando a informação.

## Ordem Recomendada de Correção

1. Dosagens/unidades, preservação de concentrações e nomes sem alterações numéricas.
2. Associação Plenance/princípio ativo, preservação de flags e restrições de via/apresentação.
3. Falsos negativos de compostos e respeito à embalagem solicitada.
4. Identidade da composição, formas, deduplicação e tratamento de cadastro incompleto.
5. Falha de API distinta de produto ausente; paginação e observabilidade.
6. Revisão de apresentação comercial e da qualidade de fotos.

Não recomendo aprovar o atendimento automático com base apenas em HTTP 200 ou na presença de preço. A prioridade é impedir opção incompatível com uma solicitação explícita.

## Resultado dos 50 Nomes

“Opções selecionadas” abaixo reproduz o código atual; não constitui indicação de medicamento ou dosagem. Preços são um retrato do instante da consulta.

| # | Busca | HTTP final | Brutos / medicamentos normalizados | Seleção atual | Observação |
|---|---|---|---|---|---|
| 1 | dipirona | 206 + 200 | 74 / 74 | Novalgina Dipirona 500mg 10 comprimidos (R$ 15,75); Novalgina Dipirona 1g 10 comprimidos (R$ 21,90); Novalgina Infantil Dipirona 500mg/ml Gotas 10ml (R$ 15,75) | Retornou opções; não equivale a aprovação clínica. |
| 2 | novalgina | 200 | 13 / 13 | Novalgina Dipirona 500mg 10 comprimidos (R$ 15,75); Novalgina Dipirona 1g 10 comprimidos (R$ 21,90); Novalgina Infantil Dipirona 500mg/ml Gotas 10ml (R$ 15,75) | Retornou opções; não equivale a aprovação clínica. |
| 3 | dorflex | 200 | 12 / 12 | Dorflex Max Analgésico e Relaxante Muscular 8 comprimidos (R$ 15,31); Dorflex Uno Dipirona 1g Enxaqueca 10 comprimidos (R$ 16,40); Analgésico e Relaxante Muscular Dorflex Gotas 20ml (R$ 21,80) | Alguma dosagem ausente no título. |
| 4 | neosoro | 200 | 6 / 5 | Descongestionante Nasal Neosoro Adulto Frasco 30ml (R$ 5,99); Neosoro Infantil Gotas 30ml (R$ 9,45); Neosoro Fluid Spray 50ml Solução Nasal 0,9% (R$ 18,74) | Dosagens ausentes; consulta de concentração não encontra. |
| 5 | ibuprofeno | 200 | 42 / 40 | Ibuprofeno Neo Química 400mg com 10 comprimidos (R$ 11,82); Alivium Ibuprofeno 600mg 10 cápsulas (R$ 47,99); Alivium Ibuprofeno 100mg/ml Suspensão Gotas 20ml (R$ 41,90) | Retornou opções; não equivale a aprovação clínica. |
| 6 | alivium | 200 | 8 / 8 | Alivium 600mg com 10 comprimidos (R$ 43,99); Alivium Ibuprofeno 400mg 10 cápsulas Líquidas (R$ 30,25); Alivium Ibuprofeno 100mg/ml Suspensão Gotas 20ml (R$ 41,90) | Retornou opções; não equivale a aprovação clínica. |
| 7 | advil | 200 | 10 / 10 | Advil Ibuprofeno 400mg com 12 cápsulas (R$ 23,90); Advil 12h Analgésico com Ibuprofeno 600mg Alívio da Dor Muscular 2 comprimidos (R$ 8,29); Advil Mulher Ibuprofeno 400mg, Analgésico Para Cólicas Menstruais, 10 cápsulas (R$ 27,99) | Retornou opções; não equivale a aprovação clínica. |
| 8 | paracetamol | 206 + 200 | 84 / 80 | Tylenol Dor e Febre Paracetamol 500mg 10 comprimidos (R$ 18,58); Tylenol Múltiplas Dores Paracetamol 750mg 10 comprimidos (R$ 21,10); Tylenol Gotas Paracetamol 200mg/ml 15ml (R$ 33,43) | Retornou opções; não equivale a aprovação clínica. |
| 9 | tylenol | 200 | 16 / 15 | Tylenol Dor e Febre Paracetamol 500mg 10 comprimidos (R$ 18,58); Tylenol Múltiplas Dores Paracetamol 750mg 10 comprimidos (R$ 21,10); Tylenol Gotas Paracetamol 200mg/ml 15ml (R$ 33,43) | Retornou opções; não equivale a aprovação clínica. |
| 10 | buscopan | 200 | 6 / 5 | Buscopan Composto com 20 comprimidos Revestidos (R$ 24,99); Analgésico Buscopan Butilbrometo de Escopolamina 10mg 20 Drágeas (R$ 25,67); Analgésico Buscopan Composto 4 comprimidos (R$ 6,40) | Alguma forma não reconhecida. |
| 11 | buscopan composto | 200 | 3 / 3 | Buscopan Composto com 20 comprimidos Revestidos (R$ 24,99); Buscopan Composto Butilbrometo de Escopolamina 6,67mg/ml + Dipirona 67mg (R$ 25,90); Analgésico Buscopan Composto 4 comprimidos (R$ 6,40) | Nome truncado passa a terminar em Dipirona 67mg. |
| 12 | luftal | 200 | 10 / 10 | Antigases Luftal Gotas Simeticona 75mg/ml - 15ml (R$ 28,59); Antigases Luftal Gel Caps Simeticona 125mg - 10 cápsulas Gelatinosas (R$ 27,67); Antigases Luftal Infantil Gotas Simeticona 75mg/ml - 15ml (R$ 37,59) | Apresentações parecidas; conferir identidade. |
| 13 | simeticona | 200 | 22 / 22 | Antigases Luftal Gotas Simeticona 75mg/ml - 15ml (R$ 28,59); Simeticona Medley 125mg com 10 cápsulas (R$ 7,49); Antigases Luftal Infantil Gotas Simeticona 75mg/ml - 15ml (R$ 37,59) | Apresentações parecidas; conferir identidade. |
| 14 | allegra | 200 | 10 / 10 | Antialergico Allegra Fexofenadina 120mg 10 comprimidos (R$ 55,10); Antialergico Allegra Fexofenadina 180mg 10 comprimidos (R$ 88,83); Antialergico Allegra Pediátrico Fexofenadina 6mg/ml Sabor Framboesa 6mg (R$ 34,90) | Nome truncado e forma desconhecida em apresentação pediátrica. |
| 15 | loratadina | 200 | 38 / 35 | Loratadina Cimed com 12 comprimidos 10mg (R$ 6,96); Loratadina Cimed 100ml Xarope 1mg/ml (R$ 13,37); Loratamed Loratadina 10mg com 12 comprimidos (R$ 8,99) | Apresentações parecidas; conferir identidade. |
| 16 | desloratadina | 200 | 31 / 29 | Deconlerg Desloratadina 5mg com 10 comprimidos Revestidos Ache (R$ 20,95); Deconlerg Desloratadina 1,25mg/ml 20ml Solução Gotas Tutti-Frutti Ache (R$ 16,85); Desloratadina Eurofarma Xarope 0,5mg/ml 60ml (R$ 19,11) | Retornou opções; não equivale a aprovação clínica. |
| 17 | cetirizina | 200 | 8 / 8 | Reactine Dicloridrato de Cetirizina 10mg com 10 cápsulas (R$ 36,98); Reactine Dicloridrato de Cetirizina 10mg com 20 cápsulas (R$ 66,53) | Retornou opções; não equivale a aprovação clínica. |
| 18 | polaramine | 200 | 5 / 5 | Antialérgico Polaramine Dexclorfeniramina 2mg 20 comprimidos (R$ 26,90); Antialérgico Polaramine Dexclorfeniramina 6mg 12 Drágeas (R$ 32,99); Antialérgico Polaramine Dexclorfeniramina 0,4mg/ml Solução Oral Sabo 4mg (R$ 32,99) | Nome de 0,4mg/ml termina indevidamente em 4mg. |
| 19 | benegrip | 200 | 14 / 11 | Antigripal Benegrip Multi Noite 12 comprimidos (R$ 24,99); Antigripal Antitérmico Benegrip Febre e Dor Pediátrico Suspensão Oral 15ml (R$ 21,99); Antigripal Benegrip 12 comprimidos (R$ 25,92) | Apresentações parecidas; conferir identidade. |
| 20 | cimegripe | 200 | 6 / 4 | Cimegripe 400mg com 20 cápsulas (R$ 12,90); Cimegripe C+zinco com 10 comprimidos Efervescentes Laranja (R$ 13,90); Cimegripe com 4 comprimidos (R$ 3,99) | C+zinco aparece como alternativa de forma. |
| 21 | coristina d | 200 | 6 / 6 | Nenhuma opção no seletor de medicamentos. | Falso negativo: 6 produtos da API eliminados. |
| 22 | resfenol | 200 | 6 / 6 | Nenhuma opção no seletor de medicamentos. | Falso negativo: 6 produtos da API eliminados. |
| 23 | amoxicilina | 200 | 41 / 39 | Amoxicilina Cimed com 21 cápsulas 500mg (R$ 22,47); Amoxicilina Ems 875mg com 14 comprimidos (R$ 38,60); Amoxicilina Cimed 150ml Pó Para Suspensão Oral 250mg/5ml (R$ 20,66) | Retornou opções; não equivale a aprovação clínica. |
| 24 | azitromicina | 200 | 23 / 22 | Azitromicina Ems 500mg com 3 comprimidos (R$ 18,35); Azitromicina Pharlab 15ml Po Suspensão Oral 600mg (R$ 29,23); Azitromicina Ems 37,5ml Suspensão Oral 1500mg (R$ 35,64) | Retornou opções; não equivale a aprovação clínica. |
| 25 | cefalexina | 200 | 13 / 12 | Cefalexina Ems 500mg com 10 comprimidos (R$ 18,15); Cefalexina Ems 1g com 8 comprimidos (R$ 69,05); Cefalexina Teuto 250mg/5ml 100ml Suspensão (R$ 34,95) | Alguma forma não reconhecida. |
| 26 | ciprofloxacino | 200 | 7 / 7 | Ciprofloxacino Medley 500mg com 14 comprimidos (R$ 24,48); Ciprofloxacino Euro C/14 Cp 500mg Gen (R$ 43,99); Ciprofloxacino Novartis com 14 comprimidos Revestidos 500mg (R$ 24,90) | Apresentações parecidas; abreviação C/14 Cp mal estruturada. |
| 27 | omeprazol | 200 | 24 / 22 | Omeprazol Medley 20mg com 14 cápsulas (R$ 17,90); Omeprazol Cimed com 28 cápsulas Liberacao Retardada 20mg (R$ 14,62); Omeprazol 20mg Teuto com 56 cápsulas (R$ 17,25) | Retornou opções; não equivale a aprovação clínica. |
| 28 | pantoprazol | 200 | 3 / 1 | Pantoprazol 40mg com 42 comprimidos Revestidos de Liberacao Retardada Medley (R$ 49,90) | Retornou opções; não equivale a aprovação clínica. |
| 29 | losartana | 200 | 42 / 40 | Losartana Ems 50mg com 30 comprimidos (R$ 5,49); Losartana Ems 100mg com 30 comprimidos (R$ 28,90); Aradois 25mg com 30 comprimidos (R$ 48,90) | Retornou opções; não equivale a aprovação clínica. |
| 30 | enalapril | 200 | 26 / 26 | Enalapril Cimed com 30 comprimidos 10mg (R$ 3,41); Enalapril Cimed com 30 comprimidos 20mg (R$ 8,56); Enalapril Ems 5mg com 30 comprimidos (R$ 10,94) | Retornou opções; não equivale a aprovação clínica. |
| 31 | atenolol | 200 | 29 / 28 | Atenolol Sandoz com 30 comprimidos 25mg (R$ 3,46); Atenolol Prati 50mg com 30 comprimidos (R$ 9,45); Atenolol Medley 100mg com 30 comprimidos (R$ 28,50) | HTTP 500 inicial; HTTP 200 na repetição após pausa. |
| 32 | anlodipino | 206 + 206 | 100 / 100 | Anlodipino 5mg 30 comprimidos Geolab (R$ 4,73); Anlodipino Cimed com 30 comprimidos 10mg Genericos (R$ 8,69); Cordarex 2,5mg com 30 comprimidos (R$ 31,99) | Somente 100 de 120 produtos foram carregados. |
| 33 | hidroclorotiazida | 206 + 206 | 100 / 99 | Hidroclorotiazida Ems 25mg com 30 comprimidos (R$ 4,20); Hidroclorotiazida 25mg com 30 comprimidos Neo Quimica (R$ 4,29); Hidroclorot Medley com 20 comprimidos 50mg Genericos (R$ 4,70) | Somente 100 de 119 produtos; apresentações parecidas. |
| 34 | furosemida | 200 | 11 / 11 | Diuremida Furosemida 40mg 20 comprimidos Geolab (R$ 7,25); Lasix com 5x2ml Solução Injetavel 10mg/ml (R$ 14,45); Neosemid 40mg com 20 comprimidos (R$ 9,20) | Selecionou Lasix injetável entre opções genéricas. |
| 35 | metformina | 206 + 200 | 52 / 49 | Metformina Teuto 500mg com 30 comprimidos (R$ 7,25); Metformina Prati 850mg com 30 comprimidos (R$ 8,40); Metformina Prati 750mg com 30 comprimidos (R$ 20,50) | Retornou opções; não equivale a aprovação clínica. |
| 36 | glifage | 200 | 7 / 7 | Glifage Xr 500mg com 30 comprimidos (R$ 11,20); Glifage 850mg com 30 comprimidos (R$ 37,37); Glifage Xr 750mg com 30 comprimidos (R$ 37,74) | Retornou opções; não equivale a aprovação clínica. |
| 37 | sinvastatina | 200 | 14 / 14 | Sinvastatina Ems 10mg com 30 comprimidos (R$ 7,63); Sinvastatina Novartis 20mg com 30 comprimidos (R$ 8,90); Sinvastatina Novartis 40mg com 30 comprimidos (R$ 13,57) | Retornou opções; não equivale a aprovação clínica. |
| 38 | rosuvastatina | 206 + 200 | 54 / 53 | Rosuvastatina Cálcica Ems 5mg com 30 comprimidos (R$ 21,17); Rosuvastatina Cimed com 30 comprimidos Revestidos 10mg (R$ 28,48); Rosuvastatina Althaia com 30 comprimidos 20mg (R$ 32,90) | Retornou opções; não equivale a aprovação clínica. |
| 39 | plenance | 200 | 9 / 9 | Plenance Rosuvastatina Cálcica 5mg 30 comprimidos (R$ 42,99); Plenance Eze Rosuvastatina Cálcica 20mg + Ezetimiba 10mg 30 cápsulas (R$ 119,90); Plenance Eze Rosuvastatina Cálcica 5mg + Ezetimiba 10mg 30 cápsulas (R$ 78,90) | Título incorreto: Tadalafila; mistura Plenance e Plenance Eze. |
| 40 | levotiroxina | 200 | 10 / 10 | Levotiroxina Merck 100mcg com 30 comprimidos (R$ 10,25); Levotiroxina Merck 25mcg com 30 comprimidos (R$ 10,85); Levotiroxina Merck 50mcg com 30 comprimidos (R$ 11,89) | Retornou opções; não equivale a aprovação clínica. |
| 41 | euthyrox | 200 | 11 / 11 | Euthyrox 25mcg com 50 comprimidos (R$ 36,59); Euthyrox 50mcg com 50 comprimidos (R$ 41,90); Euthyrox 88mcg com 50 cápsulas (R$ 42,97) | Ver falha na consulta específica de 50mcg. |
| 42 | puran t4 | 200 | 14 / 13 | Puran T4 12,5mg com 30 comprimidos (R$ 3,40); Puran T4 37,5mcg com 30 comprimidos (R$ 10,25); Puran T4 100mcg com 30 comprimidos (R$ 15,40) | API inclui 12,5mg; cadastro suspeito, requer conferência. |
| 43 | venvanse | 200 | 3 / 3 | Venvanse 30mg com 28 cápsulas (R$ 429,90); Venvanse 50mg com 28 cápsulas (R$ 504,90); Venvanse 70mg com 28 cápsulas (R$ 529,90) | Retornou opções; não equivale a aprovação clínica. |
| 44 | clonazepam | 200 | 13 / 11 | Rivotril Clonazepam 2mg 30 comprimidos Roche (R$ 32,59); Rivotril Clonazepam 2,5mg Gotas 20ml Roche (R$ 27,99); Clonazepam 2mg 30 comprimidos Medley (R$ 9,52) | Repetiu 2mg/30 comprimidos; título das gotas sem /ml. |
| 45 | sertralina | 200 | 32 / 31 | Sertralina Medley 50mg com 30 comprimidos (R$ 18,52); Sertralina Eurofarma 25mg com 30 comprimidos (R$ 39,44); Sertralina Ems com 30 comprimidos Revestidos 100mg (R$ 50,95) | Retornou opções; não equivale a aprovação clínica. |
| 46 | fluoxetina | 200 | 12 / 12 | Cloridrato de Fluoxetina 20mg 30 cápsulas Teuto (R$ 7,68); Daforin Fluoxetina 10mg 20 cápsulas (R$ 40,90); Fluoxetina 20mg Germed 30 comprimidos (R$ 15,39) | Retornou opções; não equivale a aprovação clínica. |
| 47 | tadalafila | 200 | 13 / 12 | Tadalafila Ems 20mg com 4 comprimidos (R$ 13,01); Tadalafila Cimed com 30 comprimidos Revestidos 5mg (R$ 14,87); Tadalafila Eurofarma 20mg com 4 comprimidos (R$ 14,20) | Apresentações parecidas; conferir identidade. |
| 48 | viagra | 200 | 4 / 4 | Viagra Citrato de Sildenafila 50mg 4 comprimidos (R$ 135,90); Viagra Citrato de Sildenafila 100mg 4 comprimidos (R$ 204,90); Viagra Citrato de Sildenafila 50mg 1 Comprimido (R$ 34,50) | Retornou opções; não equivale a aprovação clínica. |
| 49 | tamarine | 200 | 16 / 6 | Tamarine 6mg Caixa 20 cápsulas Laxante Fitoterápico (R$ 86,90); Laxante Fitoterápico Tamarine 12mg 20 cápsulas (R$ 89,90); Laxante Fitoterápico Tamarine Geléia Zero Açúcar 150g (R$ 89,62) | 150g da embalagem interpretado como dosagem. |
| 50 | minancora | 200 | 6 / 0 | Nenhuma opção no seletor de medicamentos. | Fluxo retail: pergunta a marca mesmo quando já informada. |

## Resultado das 12 Variações

Os casos marcados “cache” usam respostas reais recebidas nesta bateria, sem nova chamada para cada variação.

| Consulta | Origem nesta execução | Seleção atual | Avaliação |
|---|---|---|---|
| dipirona 1g | 206 + 200 | Novalgina Dipirona 1g 10 comprimidos (R$ 21,90); Novalgina Dipirona 1g 10 comprimidos Efervescentes (R$ 31,90); Novalgina Dipirona 1g 20 comprimidos (R$ 41,42) | Respeitou 1g; convencional e efervescente são distintos. |
| dipirona 1000mg | cache | Novalgina Dipirona 1g 10 comprimidos (R$ 21,90); Novalgina Dipirona 1g 10 comprimidos Efervescentes (R$ 31,90); Novalgina Dipirona 1g 20 comprimidos (R$ 41,42) | Equivalência 1000mg/1g funcionou. |
| venvanse 50mg | cache | Venvanse 50mg com 28 cápsulas (R$ 504,90) | Somente 50mg. |
| venvanse 70mg | cache | Venvanse 70mg com 28 cápsulas (R$ 529,90) | Somente 70mg. |
| dorflex 30 comprimidos | 200 | Dorflex Max Analgésico e Relaxante Muscular 8 comprimidos (R$ 15,31); Dorflex Uno Dipirona 1g Enxaqueca 10 comprimidos (R$ 16,40); Dorflex Uno Dipirona 1g Enxaqueca 20 comprimidos (R$ 26,79) | Quantidade ignorada: 8, 10 e 20 comprimidos. |
| allegra 6mg/ml | 200 | Antialergico Allegra Pediátrico Fexofenadina 6mg/ml Sabor Framboesa 6mg (R$ 34,90); Antialergico Allegra Pediátrico Fexofenadina 6mg/ml Sabor Framboesa 6mg (R$ 34,99); Antialergico Allegra Pediátrico Fexofenadina 6mg/ml 150ml com Copinho (R$ 76,12) | Dois títulos iguais para EANs diferentes; nomes truncados. |
| allegra suspensao oral | cache | Nenhuma opção no seletor de medicamentos. | Sem opções apesar de existirem produtos pediátricos no catálogo. |
| amoxicilina 250mg/5ml | 200 | Amoxicilina Ems 250mg 150ml Suspensão (R$ 21,70); Amoxicilina Eurofarma 150ml 250mg (R$ 27,89) | Perde /5ml; seleciona rótulos apenas com 250mg. |
| amoxicilina suspensao oral | 200 | Amoxicilina Cimed 150ml Pó Para Suspensão Oral 250mg/5ml (R$ 20,66); Amoxicilina Ems 150ml Suspensão Oral 500mg (R$ 42,14); Amoxicilina Prati 150ml Suspensão Oral 250mg/5ml (R$ 26,99) | Retorna produtos, mas normaliza suspensão como solução oral. |
| neosoro 0,5mg/ml | 200 | Nenhuma opção no seletor de medicamentos. | Sem opções: concentração não informada/extraída dos títulos. |
| euthyrox 50mcg | cache | Euthyrox 25mcg com 50 comprimidos (R$ 36,59); Euthyrox 50mcg com 50 comprimidos (R$ 41,90); Euthyrox 88mcg com 50 cápsulas (R$ 42,97) | Falha: retornou 25, 50 e 88mcg. |
| puran t4 25mcg | cache | Puran T4 12,5mg com 30 comprimidos (R$ 3,40); Puran T4 37,5mcg com 30 comprimidos (R$ 10,25); Puran T4 100mcg com 30 comprimidos (R$ 15,40) | Falha: retornou 12,5mg, 37,5mcg e 100mcg, sem os 25mcg solicitados. |

## Evidências e Limites

- `live-catalog-50-2026-09-23T03-10-43-155Z.json`: primeira parte, 33 chamadas e interrupção no HTTP 500.
- `live-catalog-50-2026-09-23T03-12-18-934Z.json`: continuação, 31 chamadas, restante dos nomes e variações.
- `conversation-replay-2026-09-23T03-15-49-345Z.json`: 62 respostas do motor de conversa reproduzidas offline com os JSONs reais; nenhuma URL sem captura, nenhuma dependência externa acionada.
- `catalog-additional-checks-2026-09-23.json`: perda do indicador de injetável e reprodução offline do cooldown.
- Scripts: `scripts/diagnose-live-catalog.js --suite50`, `scripts/catalog-diagnostic-cases.js` e `scripts/replay-catalog-conversations.js`.

O script de chamadas reais possui limite por execução e interrompe em falha. Rodá-lo novamente consome novas consultas. O replay não usa rede.

Não foram testados estoque próprio, entrega por CEP, receita, indicação clínica, checkout ou mensagens reais na Meta. As regras personalizadas no banco do painel e o código efetivamente publicado na Hostinger podem diferir desta cópia local. A API não comprovou popularidade por vendas; a classificação observada vem das regras atuais do projeto.

