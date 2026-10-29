from sqlite3 import IntegrityError as SQLiteIntegrityError

from django.db.models import Model, QuerySet
from django.http import Http404
from django.shortcuts import get_object_or_404
from psycopg2.errors import UniqueViolation


class ResourceNotFound(Http404):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(f"{resource} not found")


def get_or_404(model_or_qs: type[Model] | QuerySet, resource: str, **kwargs) -> Model:
    try:
        return get_object_or_404(model_or_qs, **kwargs)
    except Http404:
        raise ResourceNotFound(resource) from None


def clean_integrity_error(error: Exception) -> str | None:
    """Helper to convert an IntegrityError from psycopg2/sqlite3 to a field name string"""
    try:
        if isinstance(error.__cause__, UniqueViolation):
            return error.__cause__.args[0].split(":")[1].split("(")[1].split(")")[0]
        if isinstance(error.__cause__, SQLiteIntegrityError):
            return error.__cause__.args[0].split(": ")[1].split(".")[1]
        return None
    except Exception:
        return None
