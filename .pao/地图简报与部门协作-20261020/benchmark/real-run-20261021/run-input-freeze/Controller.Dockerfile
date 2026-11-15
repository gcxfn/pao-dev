# 用途：为已批准的真实对比提供 Linux Harbor 宿主和 Docker CLI；不包含模型凭证或题目答案。
FROM docker:29.7.2-cli AS dockercli
FROM python:3.12-slim@sha256:2259debdc6af85626058a15a7bf44ad6a68b8c98c9ae82a02cf5cdb92f096d47
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
ENV PYTHONUNBUFFERED=1 HARBOR_DISABLE_TELEMETRY=1
