# API de busca de produtos

API PHP extraída do projeto original, independente de layout, login, carrinho,
checkout, pagamentos e banco de dados. Retorna JSON e pode ser consumida por
qualquer site. Nenhuma busca grava arquivos ou altera um catálogo local.

**Fonte padrão: Preço Popular.** O código consulta a API pública de busca VTEX
da loja configurada. Não é um mecanismo de busca de toda a internet. Outras
lojas VTEX podem funcionar após configurar e testar seu domínio; lojas de outras
plataformas precisam de uma integração própria.

Referência do provedor: [VTEX Legacy Search API](https://developers.vtex.com/docs/api-reference/search-api).

## Instalação

1. Use uma hospedagem com PHP 8.1 ou superior, extensão **cURL** e extensão
   **DOM/libxml** (para a alternativa HTML), saída HTTPS e certificados CA válidos.
2. Publique somente `api-busca.php` e `config.php` na mesma pasta do servidor.
3. Acesse `/api-busca.php?produto=fralda&limite=10` no seu domínio.

Não precisa de Composer, Node.js, banco de dados ou chave na fonte atual.
Hospedagem apenas estática não executa PHP. Nesse caso, hospede a API em um
servidor PHP separado e use sua URL HTTPS no site.

Para desenvolvimento local, com PHP instalado e as extensões habilitadas:

```sh
php -S 127.0.0.1:8080
```

Abra `http://127.0.0.1:8080/api-busca.php?produto=fralda&limite=10`.
O servidor embutido é destinado ao desenvolvimento.

## Configuração

Edite `config.php`:

```php
return [
    'loja_url' => 'https://www.precopopular.com.br',
    'origens_permitidas' => ['*'],
    'fallback_html' => true,
];
```

`loja_url` é a origem HTTPS da loja, sem caminho, parâmetros ou credenciais.
Ela é definida no servidor; o visitante não pode enviar outra URL pela consulta.
A integração preserva a moeda BRL do projeto original.

`origens_permitidas` controla o CORS no navegador. `['*']` permite consumo por
qualquer domínio, sem cookies. Para limitar, use por exemplo
`['https://meusite.com.br', 'https://www.meusite.com.br']`. CORS não é autenticação:
clientes de servidor continuam podendo chamar um endpoint público.

`fallback_html` tenta ler os cards da página de busca quando a API VTEX falha.
Só funciona se o HTML entregue já contiver cards com as classes esperadas.
Não executa JavaScript e pode retornar menos resultados. HTML não reconhecido
gera erro, em vez de aparentar uma busca vazia bem-sucedida.

## Requisição e resposta

Métodos: `GET` e `OPTIONS` (preflight CORS).

| Parâmetro | Uso |
| --- | --- |
| `produto` | Texto de busca UTF-8, de 2 a 200 caracteres. Ausente, vazio ou curto retorna lista vazia. |
| `limite` | Inteiro de 1 a 100; padrão 50. Chamadas à VTEX são divididas em lotes de até 50. |

Exemplo ilustrativo de resposta, sem representar uma oferta real:

```json
{
  "total": 1,
  "produtos": [{
    "id": "123",
    "nome": "Produto de exemplo",
    "link": "https://www.precopopular.com.br/produto/p",
    "imagem": "https://cdn.example.com/foto.jpg",
    "preco_de": "R$ 100,00",
    "preco_por": "R$ 80,00",
    "valor": "R$ 80,00",
    "preco_original": "R$ 100,00",
    "desconto_percentual": 20,
    "preco": 80,
    "preco_lista": 100,
    "moeda": "BRL",
    "parcelamento": "2x de R$ 40,00 sem juros"
  }]
}
```

`total` conta apenas os itens desta resposta, não todos os resultados da loja.
`preco` e `preco_lista` são números ou `null` se ausentes. Campos monetários
formatados usam `N/A` quando indisponíveis. `valor` é igual a `preco_por`.
O desconto é calculado entre os preços de lista e venda da fonte. O desconto
artificial de 40% do projeto original foi removido.

A seleção usa o vendedor padrão do primeiro SKU que tiver essa indicação,
ou o primeiro vendedor encontrado. A resposta não garante estoque, frete ou
condições de compra; esses dados não fazem parte deste contrato de busca.
No fallback HTML, `id` pode ser vazio.

Erros retornam `{ "erro": true, "mensagem": "...", "total": 0, "produtos": [] }`:

- `400`: parâmetros inválidos.
- `403`: origem de navegador não permitida pela configuração.
- `405`: método diferente de GET/OPTIONS.
- `502`: falha ao consultar ou interpretar a fonte, ou configuração/dependência indisponível.

Detalhes técnicos vão para o log de erros do PHP. Verifique esse log em caso
de falha, incluindo eventuais erros de certificado. Não desative a verificação TLS.

## Usar em qualquer site com JavaScript

Troque `https://api.seudominio.com/api-busca.php` pela URL onde publicou a API:

```javascript
async function buscarProdutos(termo, limite = 10) {
  const url = new URL('https://api.seudominio.com/api-busca.php');
  url.searchParams.set('produto', termo);
  url.searchParams.set('limite', String(limite));
  const resposta = await fetch(url, { credentials: 'omit' });
  const dados = await resposta.json();
  if (!resposta.ok || dados.erro) {
    throw new Error(dados.mensagem || 'Falha na busca');
  }
  return dados.produtos;
}

buscarProdutos('fralda').then(console.log).catch(console.error);
```

Ao exibir os nomes dos produtos no HTML, use `textContent` para inserir texto.
Não é necessário copiar CSS, imagens ou scripts da loja original.

Também é possível incluir a biblioteca em outro código PHP:

```php
require_once __DIR__ . '/api-busca.php';
$produtos = buscarProdutos('fralda', 10);
```

## Verificação

```sh
php tests/test-api.php
php tests/test-api.php --live
```

O primeiro comando verifica normalização, preços, duplicatas, entradas e
extração HTML sem acessar a rede. O segundo também consulta a fonte real.
A disponibilidade externa e alterações no catálogo/HTML dependem da loja.

## Limpeza do projeto

Foram removidos layout, arquivos de clientes e compras, pagamentos, carrinho,
relatórios, imagens, estilos, JavaScript da loja e catálogo estático.
Também foram removidas a gravação automática em `produtos.json` e a opção
`salvar=1`, que não são necessárias à consulta independente.
Restam a API, sua configuração, este guia e os testes.
