#!/bin/sh
# Запускать из корня репозитория. Собирает библиотеку и обновляет воркспейс,
# чтобы demo (и другие пакеты с workspace:*) видели актуальный dist/.

set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Сборка библиотеки..."
pnpm run build

echo ""
echo "Обновление воркспейса (pnpm install)..."
pnpm install

echo ""
echo "Готово. Demo и другие воркспейс-зависимости используют актуальный dist/."
