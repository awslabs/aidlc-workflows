from datetime import datetime

from accounts.schemas import ProfileSchema
from ninja import Field, ModelSchema, Schema
from pydantic import field_validator

from comments.models import Comment


class CommentSchemaIn(Schema):
    body: str

    @field_validator("body")
    @classmethod
    def non_empty(cls, v: str) -> str:
        if not v:
            raise ValueError("can't be blank")
        return v


class CommentContainerSchemaIn(Schema):
    comment: CommentSchemaIn


class CommentOutSchema(ModelSchema):
    model_config = {"populate_by_name": True, "from_attributes": True}

    body: str = Field(alias="content")
    createdAt: datetime = Field(alias="created")
    updatedAt: datetime = Field(alias="updated")
    author: ProfileSchema

    class Meta:
        model = Comment
        fields = ["id"]


class CommentOutContainerSchema(Schema):
    comment: CommentOutSchema


class CommentsListOutSchema(Schema):
    comments: list[CommentOutSchema]
