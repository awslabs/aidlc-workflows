from __future__ import annotations

from typing import Annotated, Any

from ninja import ModelSchema, Schema
from pydantic import AfterValidator, EmailStr, ValidationInfo, field_validator

from accounts.models import User
from helpers.empty import EMPTY, _Empty


def none_to_blank(v: str | None, info: ValidationInfo) -> str:
    return "" if v is None else v


class ProfileSchema(ModelSchema):
    model_config = {"populate_by_name": True, "from_attributes": True}

    following: bool
    bio: str | None
    image: str | None

    class Meta:
        model = User
        fields = ["username"]

    @staticmethod
    def resolve_following(obj: User | ProfileSchema, context: dict[str, Any] | None) -> bool:
        if hasattr(obj, "following"):  # following was pre-computed via annotation, use it
            return bool(obj.following)  # bool() needed - Django's Exists(), dynamically attached by annotation
        if isinstance(obj, ProfileSchema):  # re-validating an already-constructed schema
            return obj.following  # return existing bool
        user = getattr(context.get("request") if context else None, "user", None)  # fallback: compute through db query
        return obj.followers.filter(pk=user.id).exists() if user and user.is_authenticated else False

    @field_validator("bio", mode="before")
    @classmethod
    def empty_str_to_none(cls, v: str | None) -> str | None:
        return v or None

    @field_validator("image", mode="before")
    @classmethod
    def default_image(cls, v: str | None) -> str | None:
        return v or None


class ProfileOutSchema(Schema):
    profile: ProfileSchema


class UserInCreateSchema(ModelSchema):
    email: EmailStr

    class Meta:
        model = User
        fields = ["email", "password", "username"]

    @field_validator("email", "password", "username", check_fields=False, mode="before")
    @classmethod
    def non_empty(cls, v: object) -> object:
        if isinstance(v, str) and not v:
            raise ValueError("can't be blank")
        return v


class UserCreateSchema(Schema):
    user: UserInCreateSchema


class UserInLoginSchema(ModelSchema):
    class Meta:
        model = User
        fields = ["email", "password"]

    @field_validator("email", "password", check_fields=False)
    @classmethod
    def non_empty(cls, v: str) -> str:
        if not v:
            raise ValueError("can't be blank")
        return v


class UserLoginSchema(Schema):
    user: UserInLoginSchema


class UserAnySchema(ModelSchema):
    email: EmailStr
    bio: str | None
    image: str | None

    class Meta:
        model = User
        fields = ["email", "bio", "image", "username"]

    @field_validator("bio", "image", mode="before")
    @classmethod
    def empty_str_to_none(cls, v: str | None) -> str | None:
        return v or None


class UserMineSchema(UserAnySchema):
    token: str

    @staticmethod
    def resolve_token(obj: User, context: dict[str, Any] | None) -> str:
        return str(context.get("token", "") if context is not None else "")


class UserGetSchema(Schema):
    user: UserMineSchema


class UserInPartialUpdateInSchema(Schema):
    email: Annotated[EmailStr | None | _Empty, AfterValidator(none_to_blank)] = EMPTY
    bio: Annotated[str | None | _Empty, AfterValidator(none_to_blank)] = EMPTY
    image: Annotated[str | None | _Empty, AfterValidator(none_to_blank)] = EMPTY
    username: Annotated[str | None | _Empty, AfterValidator(none_to_blank)] = EMPTY
    password: Annotated[str | None | _Empty, AfterValidator(none_to_blank)] = EMPTY

    @field_validator("email", "username", "password", check_fields=False, mode="after")
    @classmethod
    def non_empty(cls, v: object) -> object:
        if isinstance(v, str) and not v:
            raise ValueError("can't be blank")
        return v

    # NIST 800-63B section 5.1.1.2: memorized secrets must be at least 8 chars.
    @field_validator("password", check_fields=False, mode="after")
    @classmethod
    def password_min_length(cls, v: object) -> object:
        if isinstance(v, str) and 0 < len(v) < 8:
            raise ValueError("must be at least 8 characters long")
        return v


class UserPartialUpdateInSchema(Schema):
    user: UserInPartialUpdateInSchema


class UserInPartialUpdateOutSchema(UserAnySchema):
    token: str

    @staticmethod
    def resolve_token(obj: User, context: dict[str, Any] | None) -> str:
        return str(context.get("token", "") if context is not None else "")


class UserPartialUpdateOutSchema(Schema):
    user: UserInPartialUpdateOutSchema
