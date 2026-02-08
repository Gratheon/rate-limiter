# Justfile for rate-limiter package

default: test

install:
	@echo "Installing dependencies..."
	npm install

build:
	@echo "Building TypeScript to dist..."
	npm run build

test:
	@echo "Running tests..."
	npm test
