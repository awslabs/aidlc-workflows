"""Package prepared bytes without lifecycle execution; validate before extraction."""
import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile


ROOTS = ("node_modules", "dist", "dist-release")


def safe_name(name):
    if not name or "\\" in name or ":" in name or "\0" in name or name.startswith("/"):
        raise ValueError("unsafe archive path")
    parts = name.rstrip("/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("unsafe archive path")
    return "/".join(parts)


def validate(members, expected):
    entries = {}
    folded = set()
    for member in members:
        name = safe_name(member.name)
        if name in entries or (os.name == "nt" and name.casefold() in folded):
            raise ValueError("duplicate archive path")
        if name.split("/")[0] not in expected:
            raise ValueError("unexpected archive top-level entry")
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError("unsupported archive entry type")
        entries[name] = member
        folded.add(name.casefold())
    if {name.split("/")[0] for name in entries} != set(expected):
        raise ValueError("missing archive top-level entry")
    for name, member in entries.items():
        if name in expected and not member.isdir():
            raise ValueError("archive root must be a directory")
        for parent in PurePosixPath(name).parents:
            if str(parent) == ".":
                break
            ancestor = entries.get(str(parent))
            if ancestor is not None and not ancestor.isdir():
                raise ValueError("archive entry has a non-directory ancestor")
        if member.issym() or member.islnk():
            target = member.linkname
            if not target or target.startswith("/") or "\\" in target or ":" in target or "\0" in target:
                raise ValueError("unsafe archive link")
            # Resolve links component by component, including '..' after another
            # symlink: lexical normalization alone permits chained escapes.
            pending = target.split("/")
            resolved = name.split("/")[:-1] if member.issym() else []
            seen = set()
            while pending:
                part = pending.pop(0)
                if part in ("", "."):
                    continue
                if part == "..":
                    if len(resolved) <= 1:
                        raise ValueError("archive link escapes its top-level root")
                    resolved.pop()
                    continue
                resolved.append(part)
                current = "/".join(resolved)
                linked = entries.get(current)
                if linked is not None and linked.issym():
                    if current in seen:
                        raise ValueError("cyclic archive link")
                    seen.add(current)
                    resolved.pop()
                    pending = linked.linkname.split("/") + pending
            target_name = "/".join(resolved)
            if not resolved or resolved[0] != name.split("/")[0]:
                raise ValueError("archive link escapes its top-level root")
            if member.islnk() and (target_name not in entries or not entries[target_name].isfile()):
                raise ValueError("hard link must target a regular archive file")
    return entries


def digest(path):
    result = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    print("sha256 " + result.hexdigest(), flush=True)


def pack(archive, workspace, cli):
    roots = {name: workspace / name for name in ROOTS}
    if cli is not None:
        roots["aidlc-cli"] = cli
    for path in roots.values():
        if path.is_symlink() or not path.is_dir():
            raise ValueError("prepared dependency root must be a real directory")
    with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as output:
        for name, path in roots.items():
            output.add(path, arcname=name, recursive=True)
    with tarfile.open(archive, "r:gz") as check:
        validate(check.getmembers(), roots)
    digest(archive)


def unpack(archive, workspace, temporary, posix_clis):
    expected = set(ROOTS) | ({"aidlc-cli"} if posix_clis else set())
    destinations = {name: workspace / name for name in ROOTS}
    if posix_clis:
        destinations["aidlc-cli"] = temporary / "aidlc-cli"
    for path in destinations.values():
        if os.path.lexists(path):
            raise ValueError("refusing to overwrite an existing dependency root")
    with tarfile.open(archive, "r:gz") as source:
        entries = validate(source.getmembers(), expected)
        digest(archive)
        with tempfile.TemporaryDirectory(prefix="aidlc-live-deps-", dir=temporary) as scratch:
            stage = Path(scratch)
            # Regular files first; no link can redirect a later write.
            for name, member in entries.items():
                destination = stage / name
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with source.extractfile(member) as incoming, open(destination, "xb") as output:
                        shutil.copyfileobj(incoming, output)
                    destination.chmod(member.mode & 0o777)
            for name, member in entries.items():
                destination = stage / name
                if member.issym():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.symlink_to(member.linkname)
                elif member.islnk():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    os.link(stage / safe_name(member.linkname), destination)
            for name, destination in destinations.items():
                shutil.move(str(stage / name), str(destination))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("pack", "unpack"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--temporary", type=Path)
    parser.add_argument("--cli", type=Path)
    parser.add_argument("--posix-clis", action="store_true")
    args = parser.parse_args()
    if args.command == "pack":
        pack(args.archive, args.workspace, args.cli)
    else:
        if args.temporary is None:
            parser.error("unpack requires --temporary")
        unpack(args.archive, args.workspace, args.temporary, args.posix_clis)


if __name__ == "__main__":
    main()
