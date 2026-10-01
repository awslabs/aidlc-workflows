"""Provider abstraction."""

from __future__ import annotations

from typing import Protocol

from aidlc_interactive.models import Availability, InteractionRequest, ProviderResult


class InteractionProvider(Protocol):
    @property
    def provider_id(self) -> str: ...

    def is_available(self) -> Availability: ...

    def show_questionnaire(self, request: InteractionRequest) -> ProviderResult: ...

    def show_review(self, request: InteractionRequest) -> ProviderResult: ...
