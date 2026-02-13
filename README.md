# @budarin/psw-plugin-serve-range-requests

Плагин Service Worker для @budarin/plug-in-serviceworker, который обслуживает range запросы для кэшированных файлов

## Быстрый старт

```typescript
import { serveRangeRequests } from '@budarin/psw-plugin-serve-range-requests';

// Базовое использование - только обязательный параметр
serveRangeRequests({ cacheName: 'media-cache' });

// С дополнительными настройками
serveRangeRequests({
    cacheName: 'media-cache',
    include: ['*.mp4', '*.mp3', '*.pdf'], // Только эти типы файлов
    maxCacheableRangeSize: 5 * 1024 * 1024, // Максимум 5MB на диапазон
    maxCachedRanges: 50, // Максимум 50 диапазонов в памяти
    enableLogging: true, // Включить логи для отладки
});
```

## Опции

| Параметр                | Тип        | По умолчанию | Описание                           |
| ----------------------- | ---------- | ------------ | ---------------------------------- |
| `cacheName`             | `string`   | -            | **Обязательно.** Имя кеша          |
| `order`                 | `number`   | `-10`        | Порядок выполнения (опционально)   |
| `maxCachedRanges`       | `number`   | `100`        | Количество диапазонов в кеше       |
| `maxCachedMetadata`     | `number`   | `200`        | Кеш метаданных (размер/тип файлов) |
| `maxCacheableRangeSize` | `number`   | `10MB`       | Максимальный размер диапазона      |
| `minCacheableRangeSize` | `number`   | `1KB`        | Минимальный размер диапазона       |
| `include`               | `string[]` | -            | Маски файлов (glob)                |
| `exclude`               | `string[]` | -            | Исключения (glob)                  |
| `enableLogging`         | `boolean`  | `false`      | Подробные логи                     |

Для настройки параметров плагина - ориентируйтесь на показатели запросов ваших ресурсов. Посмотреть и проанализировать все запросы к вашим ресурсам вы можете в DevTools браузера в разделе Network.

## Важные моменты

⚠️ **Не кешируйте огромные файлы и диапазоны** - мобильные устройства могут не справиться с ними

## Пример использования

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import { serveRangeRequests } from '@budarin/psw-plugin-serve-range-requests';

initServiceWorker({
    plugins: [
        serveRangeRequests({
            cacheName: 'media-cache',
            include: ['*.mp4', '*.webm', '*.mkv'], // Видео
            maxCacheableRangeSize: 20 * 1024 * 1024, // 20MB
            maxCachedRanges: 30,
        }),
        serveRangeRequests({
            cacheName: 'media-cache',
            include: ['*.mp3', '*.flac', '*.wav'], // Аудио
            maxCacheableRangeSize: 8 * 1024 * 1024, // 8MB
            maxCachedRanges: 200,
        }),
    ],
});
```

## Готовые пресеты (опционально)

Если не хотите настраивать параметры вручную, используйте готовые пресеты:

### Доступные пресеты:

- **VIDEO_PRESET** - для медиаплееров: `*.mp4`, `*.webm`, `*.mkv`, `*.avi`, `*.mov`, `*.m4v`
- **AUDIO_PRESET** - для аудиоплееров: `*.mp3`, `*.flac`, `*.wav`, `*.m4a`, `*.ogg`, `*.aac`
- **MAPS_PRESET** - для карт: `*.mbtiles`, `*.pmtiles`, `/tiles/*`, `/maps/*`, `*.mvt`
- **DOCS_PRESET** - для документов: `*.pdf`, `*.epub`, `*.djvu`, `*.mobi`, `*.azw3`

```typescript
import {
    VIDEO_PRESET,
    AUDIO_PRESET,
} from '@budarin/psw-plugin-serve-range-requests';

initServiceWorker({
    plugins: [
        serveRangeRequests({ ...VIDEO_PRESET, cacheName: 'video-cache' }),
        serveRangeRequests({ ...AUDIO_PRESET, cacheName: 'audio-cache' }),
    ],
});
```

### Адаптивные пресеты:

Все вышеуказанные пресеты могут быть адаптированы под характеристики устройства. На устройствах с малым объемом памяти и слабым процессором настройки автоматически снижаются для сохранения нормальной работы приложения.

```typescript
import { getAdaptivePresets } from '@budarin/psw-plugin-serve-range-requests';

// Автоматически адаптируется под мощность устройства:
// - Слабые устройства (<4GB RAM или <4 ядра): сниженные лимиты
// - Мощные устройства (>=4GB RAM и >=4 ядра): полные лимиты
const { VIDEO_ADAPTIVE, AUDIO_ADAPTIVE } = getAdaptivePresets();

initServiceWorker({
    plugins: [
        serveRangeRequests({ ...VIDEO_ADAPTIVE, cacheName: 'video-cache' }),
        serveRangeRequests({ ...AUDIO_ADAPTIVE, cacheName: 'audio-cache' }),
    ],
});
```

## Поддерживаемые Range форматы

- `bytes=0-499` - первые 500 байтов
- `bytes=500-999` - байты с 500 по 999
- `bytes=500-` - от 500 байта до конца
- `bytes=-500` - последние 500 байтов

## Как это работает

1. Проверяет Range заголовок в запросе
2. Ищет файл в указанном кеше
3. Читает нужный диапазон из файла
4. Кеширует готовый ответ для повторного использования
5. Возвращает HTTP 206 (Partial Content)

---

**Совет**: Для большинства случаев достаточно базовой конфигурации с указанием `cacheName` и `include` паттернов!

