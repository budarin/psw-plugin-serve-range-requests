/**
 * Готовые пресеты конфигураций для Request Range плагина
 *
 * Скопируйте нужный пресет или импортируйте этот файл:
 * import { VIDEO_PRESET, AUDIO_PRESET } from './presets';
 */

// Device Memory API: дополняем WorkerNavigator (отсутствует в @types/web 0.0.332)
// TODO: Убрать когда @types/web добавит поддержку WorkerNavigator.deviceMemory
declare global {
    interface WorkerNavigator {
        readonly deviceMemory?: number;
    }
}

/**
 * 🎬 Пресет для видео файлов (ЧАСТО используется)
 * ✅ Медиаплееры используют Range для перемотки и буферизации.
 * Очереди — тормоза. maxConcurrentRangesPerUrl: 1, без кешей.
 */
export const VIDEO_PRESET = {
    include: ['*.mp4', '*.webm', '*.mkv', '*.avi', '*.mov', '*.m4v'],
    maxCacheableRangeSize: 20 * 1024 * 1024, // 20MB — верхняя граница одной записи
    maxCachedRanges: 0,
    maxCachedMetadata: 0,
    maxConcurrentRangesPerUrl: 1,
    prioritizeLatestRequest: true,
} as const;

/**
 * 🎵 Пресет для аудио файлов (ЧАСТО используется)
 * ✅ Аудиоплееры используют Range для перемотки. Очереди — тормоза. Как у видео.
 */
export const AUDIO_PRESET = {
    include: ['*.mp3', '*.flac', '*.wav', '*.m4a', '*.ogg', '*.aac'],
    maxCacheableRangeSize: 8 * 1024 * 1024, // 8MB
    maxCachedRanges: 0,
    maxCachedMetadata: 0,
    maxConcurrentRangesPerUrl: 1,
    prioritizeLatestRequest: true,
} as const;

/**
 * 🗺️ Пресет для карт и тайлов (ЧАСТО используется)
 * ✅ Картографические библиотеки используют Range для больших тайловых файлов
 */
export const MAPS_PRESET = {
    include: ['*.mbtiles', '*.pmtiles', '/tiles/*', '/maps/*', '*.mvt'],
    maxCacheableRangeSize: 2 * 1024 * 1024, // 2MB
    maxCachedRanges: 1000,
    maxCachedMetadata: 200,
    prioritizeLatestRequest: false,
} as const;

/**
 * 📚 Пресет для документов (ЧАСТО используется)
 * ✅ PDF.js и другие PDF-вьюеры используют Range для постраничной загрузки
 */
export const DOCS_PRESET = {
    include: ['*.pdf', '*.epub', '*.djvu', '*.mobi', '*.azw3'],
    maxCacheableRangeSize: 5 * 1024 * 1024, // 5MB
    maxCachedRanges: 150,
    maxCachedMetadata: 50,
    prioritizeLatestRequest: false,
} as const;

/**
 * ⚡ Адаптивные пресеты на основе характеристик устройства
 * Автоматически адаптирует настройки под мощность устройства:
 * - Очень слабые устройства (<2GB RAM, <2 ядра): минимальные настройки
 * - Слабые устройства (<4GB RAM ИЛИ <4 ядра): сниженные настройки
 * - Мощные устройства (>=4GB RAM И >=4 ядра): полные настройки
 *
 * Возвращает все адаптивные пресеты с суффиксом _ADAPTIVE:
 * ✅ VIDEO_ADAPTIVE, AUDIO_ADAPTIVE, MAPS_ADAPTIVE, DOCS_ADAPTIVE
 */
export function getAdaptivePresets() {
    // Определяем характеристики устройства
    const deviceMemory = navigator.deviceMemory || 4; // По умолчанию 4GB если не определено
    const hardwareConcurrency = navigator.hardwareConcurrency || 4; // По умолчанию 4 ядра

    // Слабое устройство: мало памяти ИЛИ мало ядер процессора
    const isLowEndDevice = deviceMemory < 4 || hardwareConcurrency < 4;

    // Очень слабое устройство: и память и процессор слабые
    const isVeryLowEndDevice = deviceMemory < 2 && hardwareConcurrency < 2;

    if (isVeryLowEndDevice) {
        // Очень консервативные настройки для старых/слабых устройств
        return {
            VIDEO_ADAPTIVE: {
                ...VIDEO_PRESET,
                maxCacheableRangeSize: 2 * 1024 * 1024, // 2MB
            },
            AUDIO_ADAPTIVE: {
                ...AUDIO_PRESET,
            },
            MAPS_ADAPTIVE: {
                ...MAPS_PRESET,
                maxCachedRanges: 100, // Очень мало
            },
            DOCS_ADAPTIVE: {
                ...DOCS_PRESET,
                maxCachedRanges: 25, // Очень мало
                maxCachedMetadata: 10,
            },
        };
    } else if (isLowEndDevice) {
        // Умеренно сниженные настройки для устройств среднего класса
        return {
            VIDEO_ADAPTIVE: {
                ...VIDEO_PRESET,
                maxCacheableRangeSize: 10 * 1024 * 1024, // 10MB
            },
            AUDIO_ADAPTIVE: {
                ...AUDIO_PRESET,
            },
            MAPS_ADAPTIVE: {
                ...MAPS_PRESET,
                maxCachedRanges: 750, // Умеренно меньше
            },
            DOCS_ADAPTIVE: {
                ...DOCS_PRESET,
                maxCachedRanges: 100, // Умеренно меньше
                maxCachedMetadata: 35,
            },
        };
    }

    // Мощное устройство (>=4GB RAM и >=4 ядра) — полные настройки
    return {
        VIDEO_ADAPTIVE: VIDEO_PRESET,
        AUDIO_ADAPTIVE: AUDIO_PRESET,
        MAPS_ADAPTIVE: MAPS_PRESET,
        DOCS_ADAPTIVE: DOCS_PRESET,
    };
}
