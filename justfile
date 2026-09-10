set shell := ["bash", "-euo", "pipefail", "-c"]

_default:
    @just --list

setup:
    NODE_ENV=development npm_config_production=false npm ci

test-fast:
    npm run test:architecture

build-sdk:
    npm run build --workspace=@a5c-ai/atlas
    npm run build --workspace=@a5c-ai/tasks-adapter
    npm run build --workspace=@a5c-ai/babysitter-sdk

test: build-sdk
    npm run test:library
    npm run test:shared
    npm run test:sdk

lint:
    npm run guard:packages
    npm run check:library-syntax
    npm run verify:metadata

verify: lint test
