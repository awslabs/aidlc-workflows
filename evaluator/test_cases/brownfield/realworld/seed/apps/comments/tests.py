import re
from unittest import mock

from articles.models import Article
from django.contrib.auth import get_user_model
from django.test import TestCase
from ninja.testing import TestClient
from parameterized import parameterized

from comments.api import router
from comments.models import Comment
from helpers.jwt_utils import create_jwt_token

User = get_user_model()


class CommentViewTestCase(TestCase):
    def setUp(self):
        for i in range(2):
            user = User.objects.create_user(username=f"testuser{i}", password="pass", email=f"test{i}@email.email")
            setattr(self, f"user_{i}", user)
            setattr(
                self,
                f"article_{i}",
                Article.objects.create(
                    author=user,
                    title=f"Title {i}",
                    summary=f"Summary {i}",
                    content=f"Content {i}",
                    slug=f"test-slug-{i}",
                ),
            )
        access_token = self.access_token = str(create_jwt_token(self.user_0))
        for i, article, author in [
            [0, self.article_0, self.user_1],
            [1, self.article_0, self.user_0],
            [2, self.article_1, self.user_0],
            [3, self.article_1, self.user_1],
        ]:
            comment = Comment.objects.create(article=article, author=author, content=f"comment {i} content")
            setattr(self, f"comment_{i}", comment)
        self.client = TestClient(
            router, headers={"Authorization": f"Token {access_token}", "Content-Type": "application/json"}
        )

    def _valid_timestamps_in_output_dict(self, output_dict):
        ts_regex = r"\b[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]*Z\b"
        self.assertTrue(re.search(ts_regex, output_dict["createdAt"]))
        self.assertTrue(re.search(ts_regex, output_dict["updatedAt"]))

    def test_get_comments_list_on_article_without_comment(self):
        for comment in Comment.objects.all():
            comment.delete()
        url = f"/articles/{self.article_1.slug}/comments"
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"comments": []})

    @parameterized.expand(((False,), (True,)))
    def test_get_comments_list_on_article_with_comments(self, make_it_follow):
        if make_it_follow:
            self.user_1.followers.add(self.user_0)
        url = f"/articles/{self.article_0.slug}/comments"
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data,
            {
                "comments": [
                    {
                        "id": comment.id,
                        "createdAt": mock.ANY,
                        "updatedAt": mock.ANY,
                        "body": f"comment {n} content",
                        "author": {
                            "username": f"testuser{u}",
                            "bio": None,
                            "image": None,
                            "following": make_it_follow and u == 1,
                        },
                    }
                    for comment, n, u in [[self.comment_1, 1, 0], [self.comment_0, 0, 1]]
                ],
            },
        )
        self._valid_timestamps_in_output_dict(response.data["comments"][0])
        self._valid_timestamps_in_output_dict(response.data["comments"][1])

    def test_create_comment(self):
        response = self.client.post(
            f"/articles/{self.article_1.slug}/comments",
            json={"comment": {"body": "This is a test comment"}},
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            response.data,
            {
                "comment": {
                    "id": self.article_1.comment_set.last().id,
                    "createdAt": mock.ANY,
                    "updatedAt": mock.ANY,
                    "body": "This is a test comment",
                    "author": {
                        "username": "testuser0",
                        "bio": None,
                        "image": None,
                        "following": False,
                    },
                },
            },
        )
        self.assertEqual(self.article_1.comment_set.count(), 3)
        self.assertEqual(self.article_1.comment_set.last().content, "This is a test comment")
        self.assertEqual(self.article_1.comment_set.last().author, self.user_0)
        self._valid_timestamps_in_output_dict(response.data["comment"])

    def test_cant_create_comment_if_not_logged(self):
        self.client.headers["Authorization"] = None
        response = self.client.post(
            f"/articles/{self.article_1.slug}/comments",
            json={"comment": {"body": "This is a test comment"}},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.article_1.comment_set.count(), 2)

    def test_delete_comment_on_my_article_from_other_user(self):
        response = self.client.delete(f"/articles/{self.article_0.slug}/comments/{self.comment_0.id}")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.article_0.comment_set.count(), 1)
        self.assertEqual(self.article_0.comment_set.first(), self.comment_1)

    def test_delete_comment_on_other_article_but_is_mine(self):
        response = self.client.delete(f"/articles/{self.article_1.slug}/comments/{self.comment_2.id}")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.article_1.comment_set.count(), 1)
        self.assertEqual(self.article_1.comment_set.first(), self.comment_3)

    def test_cant_delete_comment_on_other_article_as_it_is_not_mine(self):
        response = self.client.delete(f"/articles/{self.article_1.slug}/comments/{self.comment_3.id}")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.article_1.comment_set.count(), 2)

    def test_cant_delete_comment_not_logged(self):
        self.client.headers["Authorization"] = None
        response = self.client.delete(f"/articles/{self.article_0.slug}/comments/{self.comment_1.id}")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.article_1.comment_set.count(), 2)
