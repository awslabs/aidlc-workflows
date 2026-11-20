"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/4.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.http import Http404, HttpRequest, HttpResponse
from django.urls import path
from ninja import NinjaAPI
from ninja.errors import AuthorizationError, HttpError, ValidationError

from helpers.exceptions import ResourceNotFound

api_prefix = "api"

api = NinjaAPI()


@api.exception_handler(ValidationError)
def validation_error_handler(request: HttpRequest, exc: ValidationError) -> HttpResponse:
    errors: dict[str, list[str]] = {}
    for error in exc.errors:
        loc = error.get("loc", [])
        field = str(loc[-1]) if loc else "unknown"
        msg = error.get("msg", "")
        for prefix in ("Value error, ", "Assertion failed, "):
            if msg.startswith(prefix):
                msg = msg[len(prefix) :]
        errors.setdefault(field, []).append(msg)
    return api.create_response(request, {"errors": errors}, status=422)


def _resource_from_path(path: str) -> str:
    if "/comments/" in path:
        return "comment"
    if "/profiles/" in path:
        return "profile"
    if "/articles/" in path:
        return "article"
    return "resource"


@api.exception_handler(Http404)
def not_found_handler(request: HttpRequest, exc: Http404) -> HttpResponse:
    resource = exc.resource if isinstance(exc, ResourceNotFound) else _resource_from_path(request.path)
    return api.create_response(request, {"errors": {resource: ["not found"]}}, status=404)


@api.exception_handler(AuthorizationError)
def authorization_error_handler(request: HttpRequest, exc: AuthorizationError) -> HttpResponse:
    return api.create_response(request, {"errors": {_resource_from_path(request.path): ["forbidden"]}}, status=403)


@api.exception_handler(HttpError)
def http_error_handler(request: HttpRequest, exc: HttpError) -> HttpResponse:
    if exc.status_code == 401:
        return api.create_response(request, {"errors": {"token": ["is missing"]}}, status=401)
    return api.create_response(request, {"detail": str(exc)}, status=exc.status_code)


api.add_router(f"/{api_prefix}", "accounts.api.router")
api.add_router(f"/{api_prefix}", "articles.api.router")
api.add_router(f"/{api_prefix}", "comments.api.router")
api.add_router("/auth", "jwt_ninja.api.router")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", api.urls),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
