import dataclasses
import time

from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser
from django.http import HttpRequest
from django.utils import timezone
from jwt_ninja.cryptography import decode_jwt, generate_jwt
from jwt_ninja.errors import (
    APIError,
    JWTExpiredError,
    JWTInvalidPayloadFormat,
    JWTInvalidTokenError,
)
from jwt_ninja.models import Session
from jwt_ninja.settings import jwt_settings
from jwt_ninja.types import JWTPayload
from ninja.security import HttpBearer

User = get_user_model()


@dataclasses.dataclass
class AuthDetails:
    user: User
    session: Session


@dataclasses.dataclass
class AuthedRequest(HttpRequest):
    auth: AuthDetails


class TokenAuth(HttpBearer):
    """Custom JWT authentication class that accepts 'Token' prefix in addition to 'Bearer'"""

    def __init__(self, *args, pass_even: bool = False, **kwargs) -> None:
        self.pass_even = pass_even
        super().__init__(*args, **kwargs)

    def __call__(self, request: HttpRequest) -> AuthDetails | None:
        headers = request.headers
        auth_value = headers.get("Authorization")
        if not auth_value:
            if self.pass_even:
                # For pass_even routes, we allow unauthenticated access
                # Set request.user to AnonymousUser so code can handle both cases
                request.user = AnonymousUser()
                return request.user
            return None

        # Handle both "Token" and "Bearer" prefixes
        if auth_value.startswith("Token "):
            token = auth_value[6:]  # Remove "Token " prefix
        elif auth_value.startswith("Bearer "):
            token = auth_value[7:]  # Remove "Bearer " prefix
        else:
            if self.pass_even:
                request.user = AnonymousUser()
                return request.user
            return None

        try:
            auth_details = self.authenticate(request, token)
            if auth_details:
                # Set request.user for backward compatibility
                request.user = auth_details.user
            return auth_details
        except APIError:
            if self.pass_even:
                # On authentication failure, allow unauthenticated access
                request.user = AnonymousUser()
                return request.user
            raise

    def authenticate(self, request: HttpRequest, token: str) -> AuthDetails | None:
        try:
            payload = decode_jwt(token, JWTPayload)
        except JWTExpiredError:
            raise APIError("expired_token", 401) from None
        except (JWTInvalidPayloadFormat, JWTInvalidTokenError):
            raise APIError("invalid_token", 401) from None

        # Validate the Session
        try:
            session = Session.objects.get(id=payload.session_id)
        except Session.DoesNotExist:
            raise APIError("session_not_found", 401) from None
        if session.expired_at and session.expired_at < timezone.now():
            raise APIError("session_expired", 401)

        # Validate the user
        try:
            user = User.objects.get(id=payload.user_id, is_active=True)
        except User.DoesNotExist:
            raise APIError("invalid_user", 401) from None

        return AuthDetails(user=user, session=session)


def create_jwt_token(user, request=None):
    """Create a JWT token for a user using jwt-ninja"""
    # Create a session for the user
    ip_address = "127.0.0.1"  # Default IP for testing/manual token creation
    if request and hasattr(request, "META"):
        ip_address = request.META.get("REMOTE_ADDR", "127.0.0.1")

    session = Session.create_session(
        user=user,
        ip_address=ip_address,
    )

    current_timestamp = int(time.time())
    access_payload = JWTPayload(
        user_id=user.id,
        type="access",
        exp=current_timestamp + jwt_settings.ACCESS_TOKEN_EXPIRE_SECONDS,
        session_id=str(session.id),
    )

    return generate_jwt(access_payload)
