<?php

declare(strict_types=1);

return [
    // Configure uma loja com API pública VTEX. Não é uma busca universal.
    'loja_url' => 'https://www.drogaraia.com.br/',
    // '*' permite usar a API em qualquer site, sem cookies.
    // Para restringir: ['https://meusite.com.br', 'https://outrosite.com.br'].
    'origens_permitidas' => ['*'],
    // Alternativa: extrair os cards VTEX presentes no HTML da loja.
    'fallback_html' => true,
];
