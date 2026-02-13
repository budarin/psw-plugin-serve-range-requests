// Функция для добавления заголовков кэширования (можно вынести в отдельный файл)
export function addCacheHeaders(response: Response): Response {
    const headers = new Headers(response.headers);

    headers.set('Cache-Control', 'max-age=31536000, immutable');
    headers.delete('Expires');
    headers.delete('Pragma');
    headers.delete('ETag');
    headers.delete('Last-Modified');

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers,
    });
}
