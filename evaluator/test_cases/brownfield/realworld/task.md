# Task: implement follow / unfollow profile endpoints

The RealWorld API spec defines two profile endpoints that are missing from this
codebase:

- `POST /profiles/{username}/follow` — authenticated; the current user follows
  `{username}`; returns 200 with the target's Profile and `following: true`.
- `DELETE /profiles/{username}/follow` — authenticated; unfollows; returns 200
  with the target's Profile and `following: false`.

Both return 404 if `{username}` doesn't exist and 401 if unauthenticated.

The `Profile` schema and its `following` field already exist, and the follower
relationship is modeled — you are adding the two missing routes, not a new
subsystem. Implement both endpoints per the RealWorld spec. Keep the existing
endpoints and their contract behavior unchanged.
