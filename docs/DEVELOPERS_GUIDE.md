# Developer's Guide

## Running CodeBuild Locally

You can run AWS CodeBuild builds locally using the [CodeBuild local agent](https://docs.aws.amazon.com/codebuild/latest/userguide/use-codebuild-agent.html). This is useful for testing buildspec changes without pushing to the remote.

### Prerequisites

- Docker installed and running
- The `codebuild_build.sh` script:

### Basic Usage

1. Setup
- Download the local CodeBuild script and make it executable.
- Send the `GH_TOKEN` environmental GitHub Personal Access Token (PAT) into a `./.env` file

```bash
if [ ! -f codebuild_build.sh ]; then
  curl -O https://raw.githubusercontent.com/aws/aws-codebuild-docker-images/master/local_builds/codebuild_build.sh && chmod +x codebuild_build.sh;
fi;
echo "GH_TOKEN=${GH_TOKEN:-ghp_notset}" > "./.env";
```

2. Iterate

- _Optionally edit the `buildspec-override` value in the `.github/workflows/codebuild.yml` GitHub workflow_
- Update `./buildspec.yml` based on the workflow contents to a local file
- Run AWS CodeBuild build locally with images based on the machine architecture

```bash
cat .github/workflows/codebuild.yml \
    | uvx yq -r '.jobs.build.steps[] | select(.id == "codebuild") | .with["buildspec-override"]' \
    > buildspec.yml
./codebuild_build.sh \
  -i "public.ecr.aws/codebuild/amazonlinux-$([ "$(arch)" = "arm64" -o "$(arch)" = "aarch64" ] && echo "aarch64" || echo "x86_64")-standard:$([ "$(arch)" = "arm64" -o "$(arch)" = "aarch64" ] && echo "3.0" || echo "5.0")" \
  -a "./.codebuild/artifacts/" \
  -l "public.ecr.aws/codebuild/local-builds:$([ "$(arch)" = "arm64" -o "$(arch)" = "aarch64" ] && echo "aarch64" || echo "latest")" \
  -c \
  -e "./.env"
```

### All Script Options

| Flag         | Required | Description                                                                                                                                                                                         |
|--------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `-i IMAGE`   | Yes      | Customer build container image (e.g. `aws/codebuild/standard:5.0`)                                                                                                                                  |
| `-a DIR`     | Yes      | Artifact output directory                                                                                                                                                                           |
| `-b FILE`    | No       | Buildspec override file. Defaults to `buildspec.yml` in the source directory                                                                                                                        |
| `-s DIR`     | No       | Source directory. First `-s` is the primary source; additional `-s` flags use `<sourceIdentifier>:<sourceLocation>` format for secondary sources. Defaults to the current working directory |
| `-l IMAGE`   | No       | Override the default local agent image                                                                                                                                                              |
| `-r DIR`     | No       | Report output directory                                                                                                                                                                             |
| `-c`         | No       | Use AWS configuration and credentials from your local host (`~/.aws` and `AWS_*` environment variables)                                                                                             |
| `-p PROFILE` | No       | AWS CLI profile to use (requires `-c`)                                                                                                                                                              |
| `-e FILE`    | No       | File containing environment variables (`VAR=VAL` format, one per line)                                                                                                                              |
| `-m`         | No       | Mount the source directory into the build container directly                                                                                                                                        |
| `-d`         | No       | Run the build container in Docker privileged mode                                                                                                                                                   |


## Running GitHub Actions locally

_NOTE: This uses the [`act`](https://github.com/nektos/act) tool and assumes access to a valid AWS CodeBuild project `codebuild-project` in "us-east-1"_

```shell
act --platform ubuntu-latest=-self-hosted \
    --job build \
    --workflows .github/workflows/codebuild.yml \
    --env-file .env \
    --var CODEBUILD_PROJECT_NAME=codebuild-project \
    --var AWS_REGION=us-east-1 \
    --var ROLE_DURATION_SECONDS=7200 \
    --artifact-server-path=$PWD/.codebuild/artifacts \
    --cache-server-path=$PWD/.codebuild/artifacts \
    --env ACT_CODEBUILD_DIR=$PWD/.codebuild/downloads \
    --bind
```
