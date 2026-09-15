########################
# Variables

DEFAULT_API_URL := "http://localhost:8000"
MEMDB := "file:memdb1?mode=memory&cache=shared"

########################
# Django Project

help:
	@echo "Available commands:"
	@echo "  sync"
	@echo "  run-debug"
	@echo "  run"
	@echo "  test-django"
	@echo "  test-django-fast"
	@echo "  test-hurl"
	@echo "  test-hurl-with-managed-server"
	@echo "  lint"
	@echo "  lint-check"
	@echo "  type-check"
	@echo "  verify"
	@echo "  submodule"
	@echo "  front-setup-react"
	@echo "  front-run-react"
	@echo "  front-clean-react"
	@echo "  front-setup-vue"
	@echo "  front-run-vue"
	@echo "  front-clean-vue"

########################
# Django Project

sync:
	uv sync --extra dev

run-debug:
	DEBUG=True uv run python manage.py runserver 0.0.0.0:8000

migrate:
	uv run python manage.py migrate

run:
	uv run python manage.py runserver 0.0.0.0:8000

test-django:
	DEBUG=True uv run python manage.py test apps

test-django-fast:
	DEBUG=True DATABASE_URL=$(MEMDB) USE_FAST_HASHER=True uv run python manage.py test apps

test-hurl:
	HOST=http://localhost:8000 realworld/specs/api/hurl/run-hurl-tests.sh

test-hurl-with-managed-server:
	DEBUG=True DATABASE_URL=$(MEMDB) USE_FAST_HASHER=True DJANGO_SETTINGS_MODULE=config.settings uv run python -c \
	"import django; django.setup(); from django.core.management import call_command; call_command('migrate', verbosity=0); call_command('runserver', '0.0.0.0:8000', '--noreload')" & \
	SERVER_PID=$$!; \
	while ! curl -s http://localhost:8000/api/tags > /dev/null 2>&1; do sleep 0.2; done; \
	HOST=http://localhost:8000 realworld/specs/api/run-api-tests-hurl.sh; \
	EXIT_CODE=$$?; \
	kill $$SERVER_PID; \
	exit $$EXIT_CODE

lint:
	uv run ruff check --fix; uv run ruff format

lint-check:
	uv run ruff check --no-fix && uv run ruff format --check

type-check:
	uv run ty check

verify:
	make lint-check && make type-check && make test-django-fast

########################
# Setup

submodule:
	git submodule init; git submodule update

########################
# Frontend

front-setup-react:
	cd fronts/react-redux-realworld-example-app/; npm i

front-run-react:
	cd fronts/react-redux-realworld-example-app/;\
	REACT_APP_BACKEND_URL="$${API_URL:=$(DEFAULT_API_URL)}"/api npm start

front-clean-react:
	cd fronts/react-redux-realworld-example-app/; rm -r node_modules package-lock.json

front-setup-vue:
	cd fronts/vue3-realworld-example-app/; npm i

front-run-vue:
	cd fronts/vue3-realworld-example-app/;\
	VITE_API_HOST="$${API_URL:=$(DEFAULT_API_URL)}" npm run dev -- --host

front-clean-vue:
	cd fronts/vue3-realworld-example-app/; rm -r node_modules package-lock.json
