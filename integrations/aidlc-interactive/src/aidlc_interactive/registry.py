"""Lazy provider registry."""

from __future__ import annotations

from collections.abc import Callable

from aidlc_interactive.config import InteractionConfig
from aidlc_interactive.providers.base import InteractionProvider

ProviderFactory = Callable[[InteractionConfig], InteractionProvider]
_FACTORIES: dict[str, ProviderFactory] = {}


def register_provider(provider_id: str, factory: ProviderFactory) -> None:
    if not provider_id or provider_id in _FACTORIES:
        raise ValueError(f"provider is already registered or invalid: {provider_id}")
    _FACTORIES[provider_id] = factory


def _load_builtin(provider_id: str) -> None:
    if provider_id == "plannotator" and provider_id not in _FACTORIES:
        from aidlc_interactive.providers.plannotator import PlannotatorProvider

        register_provider(provider_id, PlannotatorProvider.from_config)


def get_provider(provider_id: str, config: InteractionConfig) -> InteractionProvider:
    _load_builtin(provider_id)
    try:
        return _FACTORIES[provider_id](config)
    except KeyError as exc:
        raise ValueError(f"unknown interaction provider: {provider_id}") from exc


def list_provider_ids() -> list[str]:
    return ["plannotator"]


def clear_registry_for_tests() -> None:
    _FACTORIES.clear()
