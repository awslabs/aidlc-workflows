from typing import Any

from accounts.models import User
from django.db import IntegrityError, transaction
from django.http import HttpResponse
from ninja import Router
from ninja.errors import AuthorizationError

from articles.models import Article, Tag
from articles.schemas import ArticleCreateSchema, ArticleListOutSchema, ArticleOutSchema, ArticlePartialUpdateSchema
from helpers.empty import EMPTY
from helpers.exceptions import clean_integrity_error, get_or_404
from helpers.jwt_utils import AuthedRequest, TokenAuth

router = Router()


@router.post("/articles/{slug}/favorite", auth=TokenAuth(), response={200: Any, 404: Any})
def favorite(request: AuthedRequest, slug: str) -> dict[str, Any] | tuple[int, dict[str, Any]]:
    article = get_or_404(Article.objects.with_favorites(request.user), "article", slug=slug)
    if article.favorites.filter(id=request.user.id).exists():
        return 409, {"errors": {"body": ["Already Favourited Article"]}}
    article.favorites.add(request.user)
    qs = Article.objects.with_favorites(request.user)
    article = get_or_404(qs, "article", id=article.id)  # Now with updated values
    return {"article": ArticleOutSchema.from_orm(article, context={"request": request})}


@router.delete("/articles/{slug}/favorite", auth=TokenAuth(), response={200: Any, 404: Any})
def unfavorite(request: AuthedRequest, slug: str) -> dict[str, Any]:
    article = get_or_404(Article.objects.with_favorites(request.user), "article", slug=slug)
    get_or_404(article.favorites, "article", id=request.user.id)
    article.favorites.remove(request.user.id)
    qs = Article.objects.with_favorites(request.user)
    article = get_or_404(qs, "article", id=article.id)  # Now with updated values
    return {"article": ArticleOutSchema.from_orm(article, context={"request": request})}


@router.get("/articles/feed", auth=TokenAuth(), response={200: Any, 404: Any})
def feed(request: AuthedRequest, limit: int = 20, offset: int = 0) -> dict[str, Any]:
    followed_authors = User.objects.filter(followers=request.user)
    queryset = Article.objects.with_favorites(request.user).filter(author__in=followed_authors).order_by("-created")
    articles = list(queryset[offset : offset + limit])
    return {
        "articlesCount": queryset.count(),
        "articles": [ArticleListOutSchema.from_orm(a, context={"request": request}) for a in articles],
    }


@router.get("/articles", response={200: Any})
def list_articles(
    request,
    tag: str | None = None,
    author: str | None = None,
    favorited: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> dict[str, Any]:
    queryset = Article.objects.with_favorites(request.user)
    queryset = queryset.filter(tags__name=tag) if tag else queryset
    queryset = queryset.filter(author__username=author) if author else queryset
    queryset = queryset.filter(favorites__username=favorited) if favorited else queryset
    queryset = queryset.order_by("-created")
    articles = list(queryset[offset : offset + limit])
    return {
        "articles": [ArticleListOutSchema.from_orm(a, context={"request": request}) for a in articles],
        "articlesCount": queryset.count(),
    }


@router.post("/articles", auth=TokenAuth(), response={201: Any, 409: Any, 422: Any})
def create_article(request: AuthedRequest, data: ArticleCreateSchema) -> tuple[int, dict[str, Any]]:
    tag_objs = (
        [Tag.objects.get_or_create(name=name)[0] for name in data.article.tags] if data.article.tags != EMPTY else []
    )
    with transaction.atomic():
        try:
            article = Article.objects.create(
                **{k: v for k, v in data.article.dict().items() if k != "tags"},
                author=request.user,
            )
        except IntegrityError as err:
            field = clean_integrity_error(err) or "title"
            if field == "slug":
                field = "title"
            return 409, {"errors": {field: ["has already been taken"]}}
        if tag_objs:
            article.tags.set(tag_objs)
    article = get_or_404(Article.objects.with_favorites(request.user), "article", id=article.id)
    return 201, {"article": ArticleOutSchema.from_orm(article, context={"request": request})}


@router.get("/articles/{slug}", auth=TokenAuth(pass_even=True), response={200: Any, 404: Any})
def retrieve(request, slug: str) -> dict[str, Any]:
    article = get_or_404(Article.objects.with_favorites(request.user), "article", slug=slug)
    return {"article": ArticleOutSchema.from_orm(article, context={"request": request})}


@router.delete("/articles/{slug}", auth=TokenAuth(), response={200: Any, 204: Any, 404: Any, 403: Any, 401: Any})
def destroy(request: AuthedRequest, slug: str) -> HttpResponse:
    article = get_or_404(Article, "article", slug=slug)
    if request.user != article.author:
        raise AuthorizationError
    article.delete()
    # As `return 204, None` would fail with newman outside debug => Content-Length=2 like if we outputed ""
    return HttpResponse(status=204)


@router.put("/articles/{slug}", auth=TokenAuth(), response={200: Any, 404: Any, 403: Any, 401: Any})
def update(request: AuthedRequest, slug: str, data: ArticlePartialUpdateSchema) -> dict[str, Any]:
    """This is wrong, but this method behaves like a PATCH, as required by the RealWorld API spec"""
    article = get_or_404(Article.objects.with_favorites(request.user), "article", slug=slug)
    if request.user != article.author:
        raise AuthorizationError
    update_data = data.article.dict(exclude_unset=True)
    new_tags = update_data.pop("tags", EMPTY)
    tag_objs = [Tag.objects.get_or_create(name=name)[0] for name in new_tags] if new_tags is not EMPTY else EMPTY
    with transaction.atomic():
        updated_fields = []
        for attr, value in update_data.items():
            setattr(article, attr, value)
            updated_fields.extend(["title", "slug"] if attr == "title" else [attr])
        updated_fields.append("updated")
        article.save(update_fields=updated_fields)
        if tag_objs is not EMPTY:
            article.tags.set(tag_objs)
    return {"article": ArticleOutSchema.from_orm(article, context={"request": request})}


@router.get("/tags", response={200: Any})
def list_tags(request) -> dict[str, Any]:
    return {"tags": [t.name for t in Tag.objects.all()]}
