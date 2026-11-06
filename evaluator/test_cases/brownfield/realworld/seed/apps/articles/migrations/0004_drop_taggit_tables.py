from django.db import migrations


def drop_taggit(apps, schema_editor):
    """Drop taggit tables and migration records if they exist."""
    conn = schema_editor.connection
    cursor = conn.cursor()
    existing_tables = conn.introspection.table_names()

    for table in ("taggit_taggeditem", "taggit_tag"):
        if table in existing_tables:
            cursor.execute(f"DROP TABLE {table}")

    if "django_migrations" in existing_tables:
        cursor.execute("DELETE FROM django_migrations WHERE app = 'taggit'")


class Migration(migrations.Migration):
    dependencies = [
        ("articles", "0003_replace_taggit_with_tags"),
    ]

    operations = [
        migrations.RunPython(drop_taggit, migrations.RunPython.noop),
    ]
