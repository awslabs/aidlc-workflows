from django.db import migrations, models


def copy_taggit_data(apps, schema_editor):
    """Copy tags from taggit tables into the local Tag model, if they exist."""
    Tag = apps.get_model("articles", "Tag")
    conn = schema_editor.connection
    cursor = conn.cursor()

    existing_tables = conn.introspection.table_names()
    if "taggit_taggeditem" not in existing_tables or "taggit_tag" not in existing_tables:
        return

    cursor.execute("SELECT id FROM django_content_type WHERE app_label = 'articles' AND model = 'article'")
    row = cursor.fetchone()
    if not row:
        return
    article_ct_id = row[0]

    cursor.execute(
        "SELECT DISTINCT t.id, t.name FROM taggit_tag t "
        "INNER JOIN taggit_taggeditem ti ON t.id = ti.tag_id "
        "WHERE ti.content_type_id = %s",
        [article_ct_id],
    )
    tag_map = {}
    for taggit_id, name in cursor.fetchall():
        local_tag, _ = Tag.objects.get_or_create(name=name)
        tag_map[taggit_id] = local_tag.pk

    ArticleTags = apps.get_model("articles", "Article").tags.through
    cursor.execute(
        "SELECT object_id, tag_id FROM taggit_taggeditem WHERE content_type_id = %s",
        [article_ct_id],
    )
    for article_id, taggit_tag_id in cursor.fetchall():
        local_tag_id = tag_map.get(taggit_tag_id)
        if local_tag_id:
            ArticleTags.objects.get_or_create(article_id=int(article_id), tag_id=local_tag_id)


class Migration(migrations.Migration):
    dependencies = [
        ("articles", "0002_alter_article_updated"),
        ("contenttypes", "0002_remove_content_type_name"),
    ]

    operations = [
        migrations.CreateModel(
            name="Tag",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=100, unique=True)),
            ],
        ),
        migrations.AddField(
            model_name="article",
            name="tags",
            field=models.ManyToManyField(blank=True, to="articles.tag"),
        ),
        migrations.AlterField(
            model_name="article",
            name="title",
            field=models.CharField(max_length=150),
        ),
        migrations.RunPython(copy_taggit_data, migrations.RunPython.noop),
    ]
