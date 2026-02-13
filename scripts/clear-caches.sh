#!/bin/sh

set -e

clear;
echo "Очистка кеша ...";

pnpm store prune;
rm -rf ./node_modules/.vite
rm -rf ./node_modules/.cache;
rm -rf .eslintcache;

echo " ";
