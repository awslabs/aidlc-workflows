"""
Django settings for config project.

- https://docs.djangoproject.com/en/5.0/topics/settings/ : For more information on this file
- https://docs.djangoproject.com/en/5.0/ref/settings/ : For the full list of settings and their values
- https://docs.djangoproject.com/en/5.0/howto/deployment/checklist/ : Important deployment checklist
"""

import sys
from datetime import timedelta
from os import getenv
from pathlib import Path
from urllib.parse import urlparse

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR / "apps"))  # Also allow direct loading of the content in apps


# Security settings
# SECURITY WARNING: Unsuitable for production
# See https://docs.djangoproject.com/en/5.0/howto/deployment/checklist/
# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = "django-insecure-2jr-1j1%i(%pqej_8_ujp9l2n1vl%^i9y390o^n&nj_(z8!+ke"
# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = str(getenv("DEBUG", False)).lower() == "true"
ALLOWED_HOSTS = ["*"] if DEBUG else (lambda s: s.split(";") if s else [])(getenv("ALLOWED_HOSTS", ""))
CORS_ORIGIN_ALLOW_ALL = True


# Application definition
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Needed for auto-host of Swagger files
    "ninja",
    # 3rd Party Packages
    "corsheaders",
    "django_extensions",
    "jwt_ninja",
    # Local Apps
    "apps.accounts",
    "apps.articles",
    "apps.comments",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"


# Database
# https://docs.djangoproject.com/en/5.0/ref/settings/#databases
# The parsed format follows postgresql://[user[:password]@][netloc][:port][/dbname][?param1=value1&...]
DATABASE_URL = getenv("DATABASE_URL")
if DATABASE_URL and DATABASE_URL.startswith((":memory:", "file:")):
    if not DEBUG:
        raise RuntimeError("In-memory SQLite should only be used with DEBUG=True")
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": DATABASE_URL}}
elif DATABASE_URL:
    PARSED_DATABASE_URL = urlparse(DATABASE_URL)
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": PARSED_DATABASE_URL.path[1:],
            "USER": PARSED_DATABASE_URL.username,
            "PASSWORD": PARSED_DATABASE_URL.password,
            "HOST": PARSED_DATABASE_URL.hostname,
            "PORT": PARSED_DATABASE_URL.port,
        }
    }
elif DEBUG:
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}
else:
    raise SystemExit(
        "You should set-up at least one of:\n"
        "- DATABASE_URL to use PostgreSQL - postgresql://[user[:password]@][netloc][:port][/dbname]\n"
        "- DATABASE_URL=':memory:' for in-memory SQLite (DEBUG only)\n"
        "- DEBUG to use file-based SQLite"
    )


# Password validation
# https://docs.djangoproject.com/en/5.0/ref/settings/#auth-password-validators
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

USE_FAST_HASHER = str(getenv("USE_FAST_HASHER", False)).lower() == "true"
if USE_FAST_HASHER and not DEBUG:
    raise RuntimeError("USE_FAST_HASHER should only be used with DEBUG=True")
if USE_FAST_HASHER:
    PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]


# Internationalization
# https://docs.djangoproject.com/en/5.0/topics/i18n/
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True


# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/5.0/howto/static-files/
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"


# Default primary key field type
# https://docs.djangoproject.com/en/5.0/ref/settings/#default-auto-field
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "accounts.User"


# JWT token settings using jwt-ninja
JWT_NINJA = {
    "ACCESS_TOKEN_LIFETIME": timedelta(days=7),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
}
