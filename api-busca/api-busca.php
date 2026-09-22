<?php

declare(strict_types=1);

const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 100;

function configuracaoBusca(): array
{
    static $config = null;
    if ($config === null) {
        $novo = require __DIR__ . '/config.php';
        $url = rtrim((string) ($novo['loja_url'] ?? ''), '/');
        $partes = parse_url($url);
        if (!is_array($partes) || ($partes['scheme'] ?? '') !== 'https'
            || empty($partes['host']) || isset($partes['user']) || isset($partes['pass'])
            || isset($partes['query']) || isset($partes['fragment']) || !empty($partes['path'])) {
            throw new RuntimeException('Configure loja_url com a origem HTTPS da loja, sem caminho.');
        }
        $novo['loja_url'] = $url;
        $config = $novo;
    }
    return $config;
}

function responder(array $dados, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function baixar(string $url): string
{
    if (!extension_loaded('curl')) {
        throw new RuntimeException('A extensão PHP cURL é necessária.');
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_ENCODING => '',
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; CatalogoProdutos/1.0)',
        CURLOPT_HTTPHEADER => [
            'Accept: application/json, text/html;q=0.9, */*;q=0.8',
            'Accept-Language: pt-BR,pt;q=0.9',
        ],
    ]);
    try {
        $resposta = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if ($resposta === false) {
            throw new RuntimeException('Falha ao consultar a loja: ' . curl_error($ch));
        }
        if ($status < 200 || $status >= 300) {
            throw new RuntimeException('A loja respondeu com HTTP ' . $status . '.');
        }
        return $resposta;
    } finally {
        curl_close($ch);
    }
}

function moeda(float $valor): string
{
    return 'R$ ' . number_format($valor, 2, ',', '.');
}

function formatarParcelamento(array $ofertas): string
{
    $candidato = '';
    foreach ($ofertas as $oferta) {
        $numero = (int) ($oferta['NumberOfInstallments'] ?? 0);
        $valor = (float) ($oferta['Value'] ?? 0);
        if ($numero < 2 || $valor <= 0) {
            continue;
        }
        if ((float) ($oferta['InterestRate'] ?? 0) == 0.0) {
            return sprintf('%dx de %s sem juros', $numero, moeda($valor));
        }
        if ($candidato === '') {
            $candidato = sprintf('%dx de %s', $numero, moeda($valor));
        }
    }
    return $candidato;
}

function obterOferta(array $produto): array
{
    $primeira = null;
    foreach (($produto['items'] ?? []) as $item) {
        foreach (($item['sellers'] ?? []) as $vendedor) {
            $dados = ['item' => $item, 'oferta' => $vendedor['commertialOffer'] ?? []];
            $primeira ??= $dados;
            if (($vendedor['sellerDefault'] ?? false) === true) {
                return $dados;
            }
        }
    }
    return $primeira ?? ['item' => [], 'oferta' => []];
}

function urlAbsoluta(string $url): string
{
    $url = trim($url);
    if ($url === '') {
        return '';
    }
    if (str_starts_with($url, '//')) {
        return 'https:' . $url;
    }
    if (preg_match('~^https?://~i', $url)) {
        return $url;
    }
    if (preg_match('~^[a-z][a-z0-9+.-]*:~i', $url)) {
        return '';
    }
    return configuracaoBusca()['loja_url'] . '/' . ltrim($url, '/');
}

function camposPreco(float $preco, float $precoLista): array
{
    $atual = $preco > 0 ? moeda($preco) : 'N/A';
    $temDesconto = $preco > 0 && $precoLista > $preco;
    return [
        'preco_de' => $temDesconto ? moeda($precoLista) : 'N/A',
        'preco_por' => $atual,
        'valor' => $atual,
        'preco_original' => $temDesconto ? moeda($precoLista) : $atual,
        'desconto_percentual' => $temDesconto ? round((1 - $preco / $precoLista) * 100, 2) : 0,
        'preco' => $preco > 0 ? $preco : null,
        'preco_lista' => $precoLista > 0 ? $precoLista : null,
        'moeda' => 'BRL',
    ];
}

function normalizarProduto(array $produto): ?array
{
    ['item' => $item, 'oferta' => $oferta] = obterOferta($produto);
    $nome = trim((string) ($produto['productName'] ?? $produto['productTitle'] ?? ''));
    if ($nome === '') {
        $nome = trim((string) ($item['name'] ?? ''));
    }
    if ($nome === '') {
        return null;
    }
    return [
        'id' => (string) ($produto['productId'] ?? ''),
        'nome' => $nome,
        'link' => urlAbsoluta((string) ($produto['link'] ?? '')),
        'imagem' => urlAbsoluta((string) ($item['images'][0]['imageUrl'] ?? '')),
        ...camposPreco((float) ($oferta['Price'] ?? 0), (float) ($oferta['ListPrice'] ?? 0)),
        'parcelamento' => formatarParcelamento((array) ($oferta['Installments'] ?? [])),
    ];
}

function normalizarLista(array $dados): array
{
    if (!array_is_list($dados)) {
        throw new RuntimeException('A API de catálogo não retornou uma lista.');
    }
    $produtos = [];
    foreach ($dados as $produto) {
        if (!is_array($produto)) {
            throw new RuntimeException('Produto inválido recebido da loja.');
        }
        $normalizado = normalizarProduto($produto);
        if ($normalizado !== null) {
            $chave = $normalizado['id'] ?: ($normalizado['link'] ?: $normalizado['nome']);
            $produtos[$chave] = $normalizado;
        }
    }
    return array_values($produtos);
}

function buscarViaApi(string $termo, int $limite): array
{
    $todos = [];
    // Cada chamada VTEX retorna até 50 produtos.
    for ($de = 0; $de < $limite; $de += 50) {
        $ate = min($de + 49, $limite - 1);
        $query = http_build_query(['ft' => $termo, '_from' => $de, '_to' => $ate], '', '&', PHP_QUERY_RFC3986);
        $json = baixar(configuracaoBusca()['loja_url'] . '/api/catalog_system/pub/products/search?' . $query);
        // Sem assoc, distingue {} de [].
        if (!is_array(json_decode($json, false, 512, JSON_THROW_ON_ERROR))) {
            throw new RuntimeException('A API de catálogo não retornou uma lista.');
        }
        $dados = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        $todos = array_merge($todos, $dados);
        if (count($dados) < $ate - $de + 1) {
            break;
        }
    }
    return array_slice(normalizarLista($todos), 0, $limite);
}

function textoNo(DOMXPath $xpath, DOMNode $contexto, string $consulta): string
{
    $nodes = $xpath->query($consulta, $contexto);
    return trim(preg_replace('/\s+/u', ' ', $nodes ? ($nodes->item(0)?->textContent ?? '') : '') ?? '');
}

function extrairValorNumerico(string $texto): float
{
    $numero = preg_replace('/[^0-9,.]/u', '', $texto) ?? '';
    if (str_contains($numero, ',')) {
        $numero = str_replace(',', '.', str_replace('.', '', $numero));
    }
    return is_numeric($numero) ? (float) $numero : 0.0;
}

function extrairProdutosHtml(string $html, int $limite): array
{
    if (!class_exists(DOMDocument::class)) {
        throw new RuntimeException('A extensão PHP DOM é necessária para o fallback HTML.');
    }
    $anterior = libxml_use_internal_errors(true);
    try {
        $dom = new DOMDocument();
        $dom->loadHTML('<?xml encoding="UTF-8">' . $html);
    } finally {
        libxml_clear_errors();
        libxml_use_internal_errors($anterior);
    }
    $xpath = new DOMXPath($dom);
    $cards = $xpath->query('//section[contains(concat(" ", normalize-space(@class), " "), " vtex-product-summary-2-x-container ")]');
    if (!$cards || $cards->length === 0) {
        throw new RuntimeException('O HTML da loja não contém cards VTEX reconhecíveis.');
    }
    $produtos = [];
    foreach ($cards as $card) {
        $linkNode = $xpath->query('.//a[contains(@class, "vtex-product-summary-2-x-clearLink")][1]', $card)->item(0);
        $imagemNode = $xpath->query('.//img[1]', $card)->item(0);
        $nome = trim($linkNode?->getAttribute('aria-label') ?? '') ?: textoNo($xpath, $card, './/h3[1]');
        if ($nome === '') {
            continue;
        }
        $link = urlAbsoluta($linkNode?->getAttribute('href') ?? '');
        $imagem = ($imagemNode?->getAttribute('src') ?? '') ?: ($imagemNode?->getAttribute('data-src') ?? '');
        $preco = textoNo($xpath, $card, './/*[contains(@class, "vtex-product-price-1-x-sellingPrice")]');
        $lista = textoNo($xpath, $card, './/*[contains(@class, "vtex-product-price-1-x-listPrice")]');
        $parcelamento = textoNo($xpath, $card, './/*[contains(translate(@class, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "installment")][1]');
        $produtos[$link ?: $nome] = [
            'id' => '', 'nome' => $nome, 'link' => $link, 'imagem' => urlAbsoluta($imagem),
            ...camposPreco(extrairValorNumerico($preco), extrairValorNumerico($lista)),
            'parcelamento' => $parcelamento,
        ];
        if (count($produtos) >= $limite) {
            break;
        }
    }
    if ($produtos === []) {
        throw new RuntimeException('Não foi possível interpretar os produtos no HTML.');
    }
    return array_values($produtos);
}

function buscarViaHtml(string $termo, int $limite): array
{
    $query = http_build_query(['_q' => $termo, 'map' => 'ft'], '', '&', PHP_QUERY_RFC3986);
    $url = configuracaoBusca()['loja_url'] . '/' . rawurlencode($termo) . '?' . $query;
    return extrairProdutosHtml(baixar($url), $limite);
}

function buscarProdutos(string $termo, int $limite = LIMITE_PADRAO): array
{
    $termo = trim($termo);
    if (!preg_match('//u', $termo) || strlen($termo) > 800) {
        throw new InvalidArgumentException('Use um termo UTF-8 válido com até 200 caracteres.');
    }
    $tamanho = preg_match_all('/./us', $termo);
    if ($tamanho > 200) {
        throw new InvalidArgumentException('O termo deve ter até 200 caracteres.');
    }
    if ($tamanho < 2) {
        return [];
    }
    $limite = max(1, min($limite, LIMITE_MAXIMO));
    try {
        return buscarViaApi($termo, $limite);
    } catch (Throwable $erroApi) {
        if (!configuracaoBusca()['fallback_html']) {
            throw $erroApi;
        }
        return buscarViaHtml($termo, $limite);
    }
}

// require_once disponibiliza as funções sem emitir uma resposta HTTP.
if (realpath((string) ($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    try {
        $origens = configuracaoBusca()['origens_permitidas'];
        $origem = $_SERVER['HTTP_ORIGIN'] ?? '';
        if (in_array('*', $origens, true)) {
            header('Access-Control-Allow-Origin: *');
        } else {
            header('Vary: Origin');
            if ($origem !== '' && !in_array($origem, $origens, true)) {
                responder(['erro' => true, 'mensagem' => 'Origem não permitida.', 'total' => 0, 'produtos' => []], 403);
            }
            if ($origem !== '') {
                header('Access-Control-Allow-Origin: ' . $origem);
            }
        }
        header('Access-Control-Allow-Methods: GET, OPTIONS');
        $metodo = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if ($metodo === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
        if ($metodo !== 'GET') {
            header('Allow: GET, OPTIONS');
            responder(['erro' => true, 'mensagem' => 'Use GET para consultar produtos.', 'total' => 0, 'produtos' => []], 405);
        }
        $termo = $_GET['produto'] ?? '';
        $limite = $_GET['limite'] ?? (string) LIMITE_PADRAO;
        if (!is_string($termo) || !is_string($limite)
            || !preg_match('/^[0-9]{1,3}$/D', $limite)
            || (int) $limite < 1 || (int) $limite > LIMITE_MAXIMO) {
            throw new InvalidArgumentException('Use produto como texto e limite inteiro de 1 a 100.');
        }
        $produtos = buscarProdutos($termo, (int) $limite);
        responder(['total' => count($produtos), 'produtos' => $produtos]);
    } catch (InvalidArgumentException $erro) {
        responder(['erro' => true, 'mensagem' => $erro->getMessage(), 'total' => 0, 'produtos' => []], 400);
    } catch (Throwable $erro) {
        error_log('[api-busca] ' . $erro->getMessage());
        responder(['erro' => true, 'mensagem' => 'Não foi possível consultar os produtos agora.', 'total' => 0, 'produtos' => []], 502);
    }
}
