@router.post(
    "/profiles/{username}/follow", auth=TokenAuth(), response={200: Any, 400: Any, 403: Any, 404: Any, 409: Any}
)
def follow_profile(request: AuthedRequest, username: str) -> tuple[int, None] | ProfileOutSchema:
    profile = get_or_404(User, "profile", username=username)
    if profile == request.user:
        raise AuthorizationError
    if profile.followers.filter(pk=request.user.id).exists():
        return 409, None
    profile.followers.add(request.user)
    return ProfileOutSchema.model_construct(profile=ProfileSchema.from_orm(profile, context={"request": request}))


@router.delete(
    "/profiles/{username}/follow", auth=TokenAuth(), response={200: Any, 400: Any, 403: Any, 404: Any, 409: Any}
)
def unfollow_profile(request: AuthedRequest, username: str) -> tuple[int, None] | ProfileOutSchema:
    profile = get_or_404(User, "profile", username=username)
    if profile == request.user:
        raise AuthorizationError
    if not profile.followers.filter(pk=request.user.id).exists():
        return 409, None
    profile.followers.remove(request.user)
    return ProfileOutSchema.model_construct(profile=ProfileSchema.from_orm(profile, context={"request": request}))
