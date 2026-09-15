from typing import Any

from django.contrib.auth import authenticate
from django.db import IntegrityError
from ninja import Router
from ninja.errors import AuthorizationError

from accounts.models import User
from accounts.schemas import (
    EMPTY,
    ProfileOutSchema,
    ProfileSchema,
    UserCreateSchema,
    UserGetSchema,
    UserInPartialUpdateOutSchema,
    UserLoginSchema,
    UserMineSchema,
    UserPartialUpdateInSchema,
    UserPartialUpdateOutSchema,
)
from helpers.exceptions import clean_integrity_error, get_or_404
from helpers.jwt_utils import AuthedRequest, TokenAuth, create_jwt_token

router = Router()


@router.post("/users", response={201: Any, 400: Any, 409: Any})
def account_registration(request, data: UserCreateSchema) -> tuple[int, dict[str, Any]]:
    try:
        user = User.objects.create_user(data.user.email, username=data.user.username, password=data.user.password)
    except IntegrityError as err:
        field = clean_integrity_error(err) or "unknown"
        return 409, {"errors": {field: ["has already been taken"]}}
    jwt_token = create_jwt_token(user)
    return 201, {
        "user": {
            "username": user.username,
            "email": user.email,
            "bio": user.bio or None,
            "image": user.image or None,
            "token": str(jwt_token),
        },
    }


@router.post("/users/login", response={200: Any, 401: Any})
def account_login(request, data: UserLoginSchema) -> dict[str, Any] | tuple[int, dict[str, Any]]:
    user = authenticate(email=data.user.email, password=data.user.password)
    if user is None:
        return 401, {"errors": {"credentials": ["invalid"]}}
    jwt_token = create_jwt_token(user)
    return {
        "user": {
            "username": user.username,
            "email": user.email,
            "bio": user.bio or None,
            "image": user.image or None,
            "token": str(jwt_token),
        },
    }


@router.get("/user", auth=TokenAuth(), response={200: Any, 404: Any})
def get_user(request: AuthedRequest) -> UserGetSchema:
    token = create_jwt_token(request.user)
    return UserGetSchema.model_construct(user=UserMineSchema.from_orm(request.user, context={"token": token}))


@router.put("/user", auth=TokenAuth(), response={200: Any, 401: Any})
def put_user(request: AuthedRequest, data: UserPartialUpdateInSchema) -> UserPartialUpdateOutSchema:
    """This is wrong, but this method behaves like a PATCH, as required by the RealWorld API spec"""
    for word in ("email", "bio", "image", "username"):
        value = getattr(data.user, word)
        if value != EMPTY:
            setattr(request.user, word, value)
    if data.user.password != EMPTY:
        request.user.set_password(data.user.password)
    request.user.save()
    token = create_jwt_token(request.user)
    return UserPartialUpdateOutSchema.model_construct(
        user=UserInPartialUpdateOutSchema.from_orm(request.user, context={"token": token}),
    )


@router.get("/profiles/{username}", auth=TokenAuth(pass_even=True), response={200: Any, 401: Any, 404: Any})
def get_profile(request, username: str) -> ProfileOutSchema:
    return ProfileOutSchema.model_construct(
        profile=ProfileSchema.from_orm(get_or_404(User, "profile", username=username), context={"request": request})
    )


