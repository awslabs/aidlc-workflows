from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandParser


class Command(BaseCommand):
    help = "Create Application User"

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--email", type=str, help="User's email")
        parser.add_argument("--name", type=str, help="User's name")
        parser.add_argument("--password", type=str, help="User's password")

    def handle(self, *args, **options) -> None:
        email: str = options["email"]
        name: str = options["name"]
        password: str = options["password"]

        User = get_user_model()
        if email and name and password:
            if not User.objects.filter(email=email).exists() and not User.objects.filter(name=name).exists():
                User.objects.create_user(email=email, password=password, name=name)
                self.stdout.write(self.style.SUCCESS("Admin user created successfully."))
            else:
                self.stdout.write(self.style.WARNING("Admin user already exists."))
        else:
            self.stdout.write(self.style.ERROR("Please provide --email, --name, and --password arguments."))
