from accounts.models import User
from articles.models import Article
from django.db.models import Exists, OuterRef, Value
from django.http import HttpResponse
from ninja import Router
from ninja.errors import AuthorizationError

from comments.models import Comment
from comments.schemas import (
    CommentContainerSchemaIn,
    CommentOutContainerSchema,
    CommentOutSchema,
    CommentsListOutSchema,
)
from helpers.exceptions import get_or_404
from helpers.jwt_utils import AuthedRequest, TokenAuth

router = Router()


def _annotate_author_following(queryset, user):
    """Annotate comments with whether the current user follows each author."""
    if user.is_authenticated:
        return queryset.annotate(author_following=Exists(User.objects.filter(pk=OuterRef("author_id"), followers=user)))
    return queryset.annotate(author_following=Value(False))


@router.get("/articles/{slug}/comments", auth=TokenAuth(pass_even=True), response={200: CommentsListOutSchema})
def list_comments(request, slug: str) -> CommentsListOutSchema:
    article = get_or_404(Article, "article", slug=slug)
    comments = Comment.objects.filter(article=article).select_related("author").order_by("-created")
    comments = _annotate_author_following(comments, request.user)

    # Attach annotation to author objects for ProfileSchema to read
    comment_list = []
    for c in comments:
        c.author.following = c.author_following
        comment_list.append(CommentOutSchema.from_orm(c))

    return CommentsListOutSchema.model_construct(comments=comment_list)


@router.post("/articles/{slug}/comments", auth=TokenAuth(), response={201: CommentOutContainerSchema})
def create_comment(
    request: AuthedRequest, data: CommentContainerSchemaIn, slug: str
) -> tuple[int, CommentOutContainerSchema]:
    article = get_or_404(Article, "article", slug=slug)
    comment = Comment.objects.create(
        article=article,
        author=request.user,
        content=data.comment.body,
    )
    # For newly created comment, user is the author so they don't follow themselves
    comment.author.following = False

    return 201, CommentOutContainerSchema.model_construct(comment=CommentOutSchema.from_orm(comment))


@router.delete("/articles/{slug}/comments/{comment_id}", auth=TokenAuth(), response={204: None})
def delete_comment(request: AuthedRequest, slug: str, comment_id: int) -> HttpResponse:
    get_or_404(Article, "article", slug=slug)
    comment = get_or_404(Comment, "comment", id=comment_id)
    if comment.author != request.user and comment.article.author != request.user:
        raise AuthorizationError
    comment.delete()
    return HttpResponse(status=204)
