.PHONY: setup doctor dev preview dev-run preview-run build bundle install-suite configure-tailscale mesh-config test verify

setup:
	mise install
	mise exec -- corepack install --global pnpm@11.25.0
	mise exec -- corepack pnpm --dir web install --frozen-lockfile

doctor:
	mise exec -- go version
	mise exec -- node --version
	mise exec -- corepack pnpm --version
	python3 --version
	openssl version

dev:
	./ops/with-env $(MAKE) dev-run

dev-run:
	@set -eu; \
	: "$${SCREEN_CONTROL_MESH_URL:?set SCREEN_CONTROL_MESH_URL in .env}"; \
	tail_ip="$${SCREEN_CONTROL_TAILSCALE_IP:-$$(tailscale ip -4)}"; \
	mise exec -- go run ./cmd/screen-control --serve & backend_pid=$$!; \
	mise exec -- corepack pnpm --dir web exec vite --host "$$tail_ip" --port 5174 --strictPort & tail_web_pid=$$!; \
	trap 'kill $$backend_pid $$tail_web_pid 2>/dev/null || true' EXIT INT TERM; \
	mise exec -- corepack pnpm --dir web exec vite --host 127.0.0.1

preview: build
	./ops/with-env $(MAKE) preview-run

preview-run:
	@set -eu; \
	: "$${SCREEN_CONTROL_MESH_URL:?set SCREEN_CONTROL_MESH_URL in .env}"; \
	tail_ip="$${SCREEN_CONTROL_TAILSCALE_IP:-$$(tailscale ip -4)}"; \
	mise exec -- go run ./cmd/screen-control --serve & backend_pid=$$!; \
	mise exec -- corepack pnpm --dir web exec vite preview --host "$$tail_ip" --port 4174 --strictPort & tail_web_pid=$$!; \
	trap 'kill $$backend_pid $$tail_web_pid 2>/dev/null || true' EXIT INT TERM; \
	mise exec -- corepack pnpm --dir web exec vite preview --host 127.0.0.1

build:
	mkdir -p bin
	mise exec -- corepack pnpm --dir web build
	mise exec -- go build -trimpath -o bin/screen-control ./cmd/screen-control
	mise exec -- go build -trimpath -o bin/screen-control-files ./cmd/screen-control-files

bundle: build
	rm -rf dist/suite
	install -d dist/suite/bin dist/suite/share/portal dist/suite/deploy
	install -m 0755 bin/screen-control dist/suite/bin/screen-control
	install -m 0755 bin/screen-control-files dist/suite/bin/screen-control-files
	cp -a dist/portal/. dist/suite/share/portal/
	cp -a deploy/g0/suite/. dist/suite/deploy/
	install -d dist/suite/deploy/files
	cp -a deploy/g0/files/. dist/suite/deploy/files/
	install -d dist/suite/deploy/gateway
	cp -a deploy/gateway/. dist/suite/deploy/gateway/
	tar -C dist -czf dist/screen-control-suite.tar.gz suite

install-suite:
	./ops/with-env ./deploy/g0/suite/install.sh

configure-tailscale:
	./ops/with-env ./deploy/g0/suite/configure-tailscale.sh

test:
	python3 -m unittest discover -s tests/operations -p 'test_*.py' -v
	mise exec -- go test ./...
	mise exec -- go test -race ./...
	mise exec -- corepack pnpm --dir web test
	mise exec -- corepack pnpm --dir web typecheck

verify:
	python3 ops/bootstrap/validate_toolchain.py
	./ops/verify/run suite bootstrap --dry-run
	mise exec -- python3 deploy/spike/meshcentral/verify.py

mesh-config:
	./ops/with-env python3 deploy/spike/meshcentral/render_config.py
