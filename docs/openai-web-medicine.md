# Reserva web de medicamentos

## Fluxo e regra comercial

Preco Popular continua principal, sem desconto adicional. Apenas sem oferta correspondente ou com falha da principal entra OpenAI Web Search (Responses API, gpt-5-mini). Nao ha chamadas PharmaDB, BulAPI ou Cosmos. Adaptadores antigos nao sao registrados no modulo e a habilitacao/autenticacao antiga permanece bloqueada. Cancelamento de assinatura externa nao e realizado pelo codigo.

A IA descobre ate quatro URLs de produtos; nao fornece o preco cobrado. As URLs precisam constar entre as fontes efetivamente consultadas, usar HTTPS e pertencer a Preco Popular, Droga Raia, Drogasil, Drogaria Sao Paulo ou Drogarias Pacheco. Apenas paginas /p ou .html sao aceitas. Nao ha contorno de captcha/bloqueio nem execucao do JavaScript dessas paginas.

O parser HTML parse5 extrai dados Product/Offer JSON-LD. Regra de venda: 100% do preco publico BRL de uma embalagem, em centavos, sem margem ou desconto adicional. Sem PF/PMC estimado. Exige nome correspondente, marca explicita preservada, dosagem equivalente quando pedida, forma, quantidade/volume, disponibilidade InStock e oferta nao vencida. Oferta agregada so vale quando contem oferta concreta verificavel; lowPrice sozinho nao vale. Precos divergentes, condicionais (CPF/cupom/clube/convenio/quantidade), parcelados ou incompletos sao rejeitados.

Uma fonte externa nao comprova estoque da propria farmacia, custo de compra, margem ou autorizacao para dispensacao. Os bloqueios existentes de apresentacoes hospitalares/injetaveis/quarentena continuam. Nenhuma inferencia de tratamento ou dose e feita pela reserva. Os tres resultados passam pelo seletor existente.

## Checkout e rastreabilidade

Cada opcao guarda URL, produto, EAN quando valido, valor e horario. O link aparece na mensagem do WhatsApp. A cotacao vale por ate dez minutos para selecao, com cache de busca de cinco minutos. Antes de novo Pix, todos os itens web sao relidos na fonte e precisam manter a mesma identidade. Alteracao de preco pede nova confirmacao; falha preserva o carrinho e impede cobranca. Pix ja emitido nao tem valor alterado.

Logs openai_web registram operacao web_search/verify_offer, termo de produto, endpoint, HTTP, duracao, quantidade de resultados e motivo da rejeicao. Nao registram chave, corpo completo da OpenAI, conteudo da conversa, telefone ou dados de pagamento. Somente atributos do produto vao para a pesquisa, com store=false.

## Configuracao

```
OPENAI_WEB_SEARCH_ENABLED=true
OPENAI_WEB_SEARCH_MODEL=gpt-5-mini
OPENAI_WEB_SEARCH_DAILY_LIMIT=40
```

Reutiliza OPENAI_API_KEY. OPENAI_MODEL e OPENAI_VISION_MODEL nao mudam. As novas configuracoes possuem os valores acima por padrao; nao alterar nem publicar arquivos com segredos. Desativar a reserva: OPENAI_WEB_SEARCH_ENABLED=false. As flags PHARMADB_ENABLED/BULAPI_ENABLED antigas sao ignoradas.

Limite local de 40 descobertas por processo/dia UTC, ate duas chamadas de ferramenta em cada descoberta. Cache negativo de um minuto, no maximo duas descobertas simultaneas, timeout OpenAI de 35 segundos e 6 segundos por pagina. Pausa de cinco minutos em 401/403/429. Sem retentativa automatica. Limite em memoria nao sobrevive a reinicios e se multiplica com replicas; usar tambem limites/alertas da conta OpenAI. Revalidacao de pagina no checkout nao usa OpenAI.

## Validacao e limites conhecidos

Teste offline: npm run build; npm run test:web-medicine; npm run test:medicine-backups (alias da mesma suite atual).
Teste real opt-in: node scripts/diagnose-web-medicine.js --live (ate duas descobertas, sem banco/WhatsApp/pedidos).

Em 23/09/2026, validacao real final encontrou:
- Dipirona 1g / 10 comprimidos: ofertas de R$ 10,34 e R$ 10,59.
- Paracetamol 750mg / 20 comprimidos: ofertas de R$ 9,45 e R$ 41,99, marcas diferentes.

Valores observados naquele instante, nao fixtures usadas para vender. A busca levou aproximadamente 18-20 segundos por termo. Houve duas solicitacoes rejeitadas antes das buscas por incompatibilidade de filtros com gpt-4.1-mini; o modelo padrao foi corrigido para gpt-5-mini. Foram quatro descobertas bem-sucedidas em HTTP 200 durante desenvolvimento (duas antes de corrigir formatos de ofertas, duas depois), alem das duas rejeitadas.

Nem toda pagina publica dados estruturados suficientes; nesses casos nao existe oferta utilizavel mesmo com HTTP 200. A reserva nao promete cobertura total nem disponibilidade local. Higiene e produtos encaminhados ao fluxo de varejo continuam somente no Preco Popular. Nao houve publicacao em producao.

## Publicacao

Publicar src, public/admin, package.json e package-lock.json juntos, executar npm ci e npm run build, reiniciar o backend. parse5 e a nova dependencia. Nao exige migracao de banco. O painel Integracoes e /health/providers mostram configuracao, nao uma promessa de conectividade.

Documentacao OpenAI consultada: https://developers.openai.com/api/docs/guides/tools-web-search e https://developers.openai.com/api/docs/models/gpt-5-mini.
