/**
 * Константы префиксов логирования плагина.
 *
 * Используются только для отладочного логирования (debug/trace),
 * чтобы в логах было легко отфильтровать сообщения этого плагина
 * и различить контекст (service worker vs client).
 */

/** Базовый префикс плагина в логах. Стабильный между релизами. */
export const PLUGIN_LOG_PREFIX = '[cache-range]';

/** Префикс для отладочных логов внутри Service Worker. */
export const SW_DEBUG_PREFIX = `${PLUGIN_LOG_PREFIX}[sw]`;

/** Префикс для отладочных логов клиентского кода (зарезервировано на будущее). */
export const CLIENT_DEBUG_PREFIX = `${PLUGIN_LOG_PREFIX}[client]`;

