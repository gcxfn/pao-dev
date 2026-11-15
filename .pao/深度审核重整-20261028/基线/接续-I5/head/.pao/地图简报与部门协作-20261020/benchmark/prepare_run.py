"""把明确来源组装成新的不可复用运行目录；纯离线，不启动 Docker 或模型。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import shutil

import runner_common


def _normalize_target(relative: str) -> str:
    target = PurePosixPath(relative)
    if target.is_absolute() or ".." in target.parts or not target.parts:
        raise ValueError("最终目标路径越界：" + relative)
    return target.as_posix()


def _add_target(
    assembly: dict[str, dict],
    relative: str,
    source: Path,
    *,
    source_kind: str,
    operation: str = "copy",
    sha256: str | None = None,
) -> None:
    target = _normalize_target(relative)
    if target in assembly:
        previous = assembly[target]["source"]
        raise ValueError(f"最终目标重复：{target}（{previous}，{source}）")
    if not source.is_file():
        raise FileNotFoundError(source)
    source_sha256 = sha256 if sha256 is not None else runner_common.digest(source)
    assembly[target] = {
        "target": target,
        "source": source.resolve(),
        "source_kind": source_kind,
        "operation": operation,
        "sha256": source_sha256,
    }


def _source_files(root: Path) -> list[Path]:
    if not root.is_dir():
        raise FileNotFoundError(root)
    return [
        path
        for path in sorted(root.rglob("*"))
        if path.is_file()
        and not runner_common.source_excluded(
            PurePosixPath(path.relative_to(root).as_posix())
        )
    ]


def build_package_assembly(benchmark: Path, sdk_host: Path) -> dict[str, dict]:
    """先固定每个最终包的唯一来源；复制阶段只消费此表。"""
    assembly: dict[str, dict] = {}
    organized_manifest = runner_common.read_json(
        benchmark / "organized-post" / "manifest.json"
    )
    manifest_records: dict[str, str] = {}
    for record in organized_manifest["files"]:
        target = _normalize_target(record["path"])
        if target in manifest_records:
            raise ValueError("组织配置来源清单含重复目标：" + target)
        manifest_records[target] = record["sha256"]

    root_files = {
        "organized-post/kit.json",
        "organized-post/probe-tools.mjs",
        "organized-post/setup.mjs",
    }
    allowed_manifest_targets = root_files | {
        "organized-post/activate-tools.mjs",
        "map_bench_pao_organized.py",
    }
    if set(manifest_records) != allowed_manifest_targets:
        raise ValueError("组织配置来源清单与允许来源集合不一致")
    root_activation = benchmark / "organized-post" / "activate-tools.mjs"
    if not root_activation.is_file():
        raise FileNotFoundError(root_activation)
    if (
        runner_common.digest(root_activation)
        != manifest_records["organized-post/activate-tools.mjs"]
    ):
        raise ValueError("组织配置来源摘要不符：organized-post/activate-tools.mjs")

    sdk_files = {
        "activate-tools.mjs",
        "benchmark-child-entry.mjs",
        "benchmark-host-factories.mjs",
        "benchmark-organized-entry.mjs",
        "benchmark-worktree-host.mjs",
        "probe-child-rpc.mjs",
    }

    for relative in sorted(root_files):
        source = benchmark / relative
        sha256 = runner_common.digest(source)
        if sha256 != manifest_records[relative]:
            raise ValueError("组织配置来源摘要不符：" + relative)
        if relative == "organized-post/kit.json":
            _add_target(
                assembly,
                relative,
                source,
                source_kind="benchmark_derived",
                operation="derive",
                sha256=sha256,
            )
        else:
            _add_target(
                assembly,
                relative,
                source,
                source_kind="benchmark",
                sha256=sha256,
            )

    for name in sorted(sdk_files):
        relative = "organized-post/" + name
        _add_target(
            assembly,
            relative,
            sdk_host / name,
            source_kind="sdk_host",
        )
    adapter_source = sdk_host / "benchmark-organized-adapter.py"
    adapter_sha256 = runner_common.digest(adapter_source)
    if adapter_sha256 != manifest_records["map_bench_pao_organized.py"]:
        raise ValueError("组织配置来源摘要不符：map_bench_pao_organized.py")
    _add_target(
        assembly,
        "map_bench_pao_organized.py",
        adapter_source,
        source_kind="sdk_host",
        sha256=adapter_sha256,
    )
    for relative in ("map_bench_pao", "scripts"):
        for source in _source_files(benchmark / relative):
            _add_target(
                assembly,
                source.relative_to(benchmark).as_posix(),
                source,
                source_kind="benchmark",
            )
    for name in ("preparation_agent.py", "bench_controller.py"):
        _add_target(
            assembly,
            name,
            benchmark / name,
            source_kind="benchmark",
        )
    return dict(sorted(assembly.items()))


def validate_frozen_task(source: Path, source_manifest: dict) -> dict[str, str]:
    expected = {
        item["path"]: item["sha256"] for item in source_manifest["files"]
    }
    actual = {
        path.relative_to(source).as_posix()
        for path in source.rglob("*")
        if path.is_file()
    }
    if actual != set(expected):
        raise ValueError("冻结原题文件集合与来源清单不一致")
    for relative, sha256 in expected.items():
        if runner_common.digest(source / relative) != sha256:
            raise ValueError("冻结原题摘要不符：" + relative)
    return expected


def copy_frozen_task(source: Path, destination: Path, source_manifest: dict) -> dict:
    expected = validate_frozen_task(source, source_manifest)
    runner_common.copy_tree_files(source, destination)
    return {
        "source": str(source),
        "destination": str(destination),
        "ref": source_manifest["ref"],
        "files": [
            {"path": relative, "sha256": sha256}
            for relative, sha256 in sorted(expected.items())
        ],
    }


def copy_assembly(assembly: dict[str, dict], destination: Path) -> list[dict]:
    records = []
    for target, cell in assembly.items():
        if cell["operation"] == "derive":
            continue
        if cell["operation"] != "copy":
            raise ValueError("未知装配操作：" + cell["operation"])
        final_path = destination / Path(target)
        if final_path.exists():
            raise ValueError("最终目标已被其他来源写入：" + target)
        record = runner_common.copy_file(Path(cell["source"]), final_path)
        if record["sha256"] != cell["sha256"]:
            raise ValueError("最终目标复制摘要与装配表不符：" + target)
        records.append(
            {
                **record,
                "target": target,
                "source_kind": cell["source_kind"],
                "operation": cell["operation"],
            }
        )
    return records


def _cleanup_failed_prepare(temporary: Path, failure: BaseException) -> None:
    """清理暂存目录；清理也失败时用标准异常组同时保留两个错误。"""
    try:
        if temporary.exists():
            shutil.rmtree(temporary)
    except BaseException as cleanup_failure:
        raise BaseExceptionGroup(
            "准备运行失败，且暂存目录清理失败",
            [failure, cleanup_failure],
        ) from failure


def derive_kit(
    cell: dict,
    destination: Path,
    model: str,
    thinking: str,
) -> dict:
    """从唯一模板派生运行 kit，并把参数和实际写出摘要一并留证。"""
    if cell["operation"] != "derive":
        raise ValueError("kit 装配记录不是派生操作")
    source = Path(cell["source"])
    template_sha256 = runner_common.digest(source)
    if template_sha256 != cell["sha256"]:
        raise ValueError("kit 源模板摘要与装配表不符")
    kit = runner_common.read_json(source)
    target = cell["target"]
    kit_path = destination / Path(target)
    if kit_path.exists():
        raise ValueError("最终目标已被其他来源写入：" + target)
    expected_model = "harbor-endpoint/" + model
    for node in kit["workflow"]["节点"]:
        node["模型"] = expected_model
        node["思考强度"] = thinking
        node["档位"] = "primary"
    for department in kit["departments"]:
        recipe = department.get("recipe")
        if not isinstance(recipe, str):
            raise ValueError("部门配方默认档位不是 primary：" + department.get("name", ""))
        binding_line = f"模型名:{expected_model}"
        thinking_line = f"思考强度:{thinking}"
        if not recipe.endswith("\n"):
            recipe += "\n"
        recipe += binding_line + "\n" + thinking_line + "\n"
        if "默认档位:primary" not in recipe:
            raise ValueError("部门配方默认档位不是 primary：" + department.get("name", ""))
        department["recipe"] = recipe
    runner_common.write_json(kit_path, kit)
    return {
        "target": "organized-post/kit.json",
        "source": str(source.resolve()),
        "source_kind": cell["source_kind"],
        "operation": "derive",
        "template_sha256": template_sha256,
        "transform": {
            "model_name": expected_model,
            "selected_model_name": model,
            "thinking": thinking,
            "tier": "primary",
            "recipe_append": [
                "模型名:" + expected_model,
                "思考强度:" + thinking,
                "默认档位:primary",
            ],
        },
        "sha256": runner_common.digest(kit_path),
        "final_sha256": runner_common.digest(kit_path),
    }


def offline_source_record(
    source: Path,
    destination: Path,
    declared_sha256: str,
) -> dict:
    final_sha256 = runner_common.digest(destination)
    return {
        "source": str(source),
        "destination": str(destination),
        "declared_sha256": declared_sha256,
        "sha256": final_sha256,
        "final_sha256": final_sha256,
        "origin": "unknown",
        "origin_status": "unknown",
    }


def prepare(source_manifest_path: Path) -> dict:
    manifest_path = source_manifest_path.resolve()
    sources = runner_common.read_json(manifest_path)
    run_parent = runner_common.absolute_path(sources["run_parent"], "run_parent")
    run = runner_common.absolute_path(sources["run_dir"], "run_dir")
    if run.parent != run_parent or run.exists():
        raise ValueError("run_dir 必须尚不存在且直接位于 run_parent 下")

    repository = runner_common.absolute_path(sources["pao_source"], "pao_source")
    benchmark = runner_common.absolute_path(sources["benchmark_source"], "benchmark_source")
    sdk_host = runner_common.absolute_path(sources["sdk_host_source"], "sdk_host_source")
    task_source = runner_common.absolute_path(sources["task_source"], "task_source")
    task_source_manifest = runner_common.absolute_path(
        sources["task_source_manifest"], "task_source_manifest"
    )
    model_data = runner_common.absolute_path(sources["model_data_archive"], "model_data_archive")
    node_archive = runner_common.absolute_path(sources["node_archive"], "node_archive")
    dependencies = runner_common.absolute_path(
        sources["system_dependencies_archive"], "system_dependencies_archive"
    )
    model_metadata = runner_common.absolute_path(
        sources["model_metadata_path"], "model_metadata_path"
    )
    config_source = runner_common.absolute_path(
        sources["config_source"], "config_source"
    )
    if runner_common.digest(config_source) != sources["config_source_sha256"]:
        raise ValueError("配置来源摘要不符")
    compose_source = None
    compose_sha256 = None
    if "extra_docker_compose_source" in sources:
        compose_source = runner_common.absolute_path(
            sources["extra_docker_compose_source"],
            "extra_docker_compose_source",
        )
        compose_sha256 = sources.get("extra_docker_compose_sha256")
        if not isinstance(compose_sha256, str):
            raise ValueError("网络覆写来源缺少 SHA-256")
        if runner_common.digest(compose_source) != compose_sha256:
            raise ValueError("网络覆写来源摘要不符")
    mounts = sources["container_mounts"]
    model_name = sources["model_name"]
    thinking = sources["thinking"]
    authorization = sources["authorization"]

    task_manifest = runner_common.read_json(task_source_manifest)
    model_entry = runner_common.load_model_metadata(
        model_metadata,
        sources["model_metadata_sha256"],
        model_name,
        thinking,
    )
    for key in ("model_data_sha256", "node_sha256", "system_dependencies_sha256"):
        if runner_common.digest(
            {
                "model_data_sha256": model_data,
                "node_sha256": node_archive,
                "system_dependencies_sha256": dependencies,
            }[key]
        ) != sources[key]:
            raise ValueError("冻结件摘要不符：" + key)
    package_assembly = build_package_assembly(benchmark, sdk_host)
    task_destination = run / "task-cache" / PurePosixPath(
        PurePosixPath(task_source.as_posix()).name
    )
    offline_destinations = {
        "model_data": run / "model-data.zip",
        "node": run / node_archive.name,
        "system_dependencies": run / "git-system-dependencies.zip",
        "model_metadata": run / "model-metadata.json",
    }
    reserved_targets = {
        task_destination.relative_to(run).as_posix(),
        *(
            destination.relative_to(run).as_posix()
            for destination in offline_destinations.values()
        ),
    }
    duplicates = sorted(reserved_targets.intersection(package_assembly))
    if duplicates:
        raise ValueError("最终目标重复：" + "、".join(duplicates))

    temporary = runner_common.temporary_sibling(run)
    try:
        task_destination = temporary / "task-cache" / PurePosixPath(
            PurePosixPath(task_source.as_posix()).name
        )
        task_record = copy_frozen_task(task_source, task_destination, task_manifest)

        source_archive = temporary / "source.zip"
        source_record = runner_common.build_source_archive(repository, source_archive)

        model = runner_common.model_id(model_name)
        runtime_model_name = "harbor-endpoint/" + model
        adapter_records = copy_assembly(package_assembly, temporary)
        derived_record = derive_kit(
            package_assembly["organized-post/kit.json"],
            temporary,
            model,
            thinking,
        )
        organized = temporary / "organized-post"
        config = runner_common.read_json(config_source)
        configured_tasks = config.get("tasks")
        if not isinstance(configured_tasks, list) or len(configured_tasks) != 1:
            raise ValueError("来源配置必须明确一道题目")
        configured_task = configured_tasks[0]
        if (
            configured_task.get("name") != sources["task_name"]
            or configured_task.get("ref") != task_manifest["ref"]
        ):
            raise ValueError("来源配置的题目范围与冻结原题不一致")
        shutil.copy2(model_data, temporary / "model-data.zip")
        shutil.copy2(node_archive, temporary / node_archive.name)
        shutil.copy2(dependencies, temporary / "git-system-dependencies.zip")
        shutil.copy2(model_metadata, temporary / "model-metadata.json")

        kit_manifest = runner_common.file_records(
            organized, exclude={"manifest.json"}
        )
        for record in kit_manifest:
            record["path"] = "organized-post/" + record["path"]
        runner_common.write_json(
            organized / "manifest.json",
            {
                "at": runner_common.now(),
                "files": kit_manifest,
            },
        )
        binding = {
            "model_name": runtime_model_name,
            "selected_model_name": model_name,
            "provider": "harbor-endpoint",
            "model": model,
            "thinking": thinking,
        }
        runner_common.write_json(
            temporary / "role-model-binding.json", binding
        )
        configured_agents = config.get("agents")
        if not isinstance(configured_agents, list) or len(configured_agents) != 1:
            raise ValueError("来源配置必须明确一个主代理")
        configured_agent = configured_agents[0]
        if not isinstance(configured_agent, dict):
            raise ValueError("来源配置的主代理必须是对象")
        if isinstance(configured_agent.get("source_metadata"), dict):
            stale_binding = configured_agent["source_metadata"]
            if (
                stale_binding.get("model_name") != runtime_model_name
                or stale_binding.get("provider") != "harbor-endpoint"
                or stale_binding.get("model") != model
            ):
                raise ValueError("运行配置的模型绑定与 harbor-endpoint 运行别名不一致")
        configured_agent["source_metadata"] = binding
        configured_agent["model_name"] = runtime_model_name

        config["job_name"] = sources["job_name"]
        config["jobs_dir"] = runner_common.container_path(run / "jobs", mounts)
        config["tasks"] = [{"name": sources["task_name"], "ref": task_manifest["ref"]}]
        config["environment"]["kwargs"]["keep_containers"] = True
        if compose_source is not None:
            compose_destination = temporary / "network-override.yaml"
            runner_common.copy_file(compose_source, compose_destination)
            if runner_common.digest(compose_destination) != compose_sha256:
                raise ValueError("网络覆写副本摘要不符")
            config["environment"]["kwargs"]["extra_docker_compose"] = [
                runner_common.container_path(run / "network-override.yaml", mounts)
            ]
        agent = runner_common.validate_run_config(config)
        agent["model_base_url"] = sources["model_base_url"]
        agent["model_api_key_name"] = "PAO_BENCH_API_KEY"
        agent["model_api_format"] = "anthropic_messages"
        kwargs = agent["kwargs"]
        kwargs.update(
            configuration_root=runner_common.container_path(run, mounts),
            source_archive=runner_common.container_path(run / "source.zip", mounts),
            source_sha256=source_record["archive_sha256"],
            model_data_archive=runner_common.container_path(run / "model-data.zip", mounts),
            model_data_sha256=runner_common.digest(temporary / "model-data.zip"),
            node_archive=runner_common.container_path(run / node_archive.name, mounts),
            node_sha256=runner_common.digest(temporary / node_archive.name),
            system_dependencies_archive=runner_common.container_path(
                run / "git-system-dependencies.zip", mounts
            ),
            system_dependencies_sha256=runner_common.digest(
                temporary / "git-system-dependencies.zip"
            ),
            organization_manifest_sha256=runner_common.digest(organized / "manifest.json"),
            model_metadata_path=runner_common.container_path(
                run / "model-metadata.json", mounts
            ),
            model_metadata_sha256=runner_common.digest(temporary / "model-metadata.json"),
        )
        runner_common.validate_run_config(config)
        runner_common.write_json(temporary / "run-config.json", config)
        runner_common.write_json(
            temporary / "approved-launch.json",
            {
                "at": runner_common.now(),
                "authorization": authorization,
                "model": runner_common.model_id(model_name),
                "thinking": thinking,
                "tasks": [sources["task_name"]],
                "attempts": 1,
                "automatic_retries": 0,
                "controller": sources["controller_name"],
            },
        )
        manifest_assembly = sorted(
            [
                {
                    "target": record["target"],
                    "source": record["source"],
                    "source_kind": record["source_kind"],
                    "operation": record["operation"],
                    "sha256": record["sha256"],
                }
                for record in adapter_records
            ]
            + [
                {
                    "target": derived_record["target"],
                    "source": derived_record["source"],
                    "source_kind": derived_record["source_kind"],
                    "operation": derived_record["operation"],
                    "template_sha256": derived_record["template_sha256"],
                    "sha256": derived_record["sha256"],
                    "transform": derived_record["transform"],
                }
            ],
            key=lambda record: record["target"],
        )
        assembly_targets = [record["target"] for record in manifest_assembly]
        if assembly_targets != sorted(package_assembly):
            raise ValueError("最终装配记录与唯一目标表不一致")
        runner_common.write_json(
            temporary / "source-manifest.json",
            {
                **source_record,
                "adapters": [
                    {
                        "source": record["source"],
                        "destination": str(
                            run / Path(record["target"])
                        ),
                        "sha256": record["sha256"],
                    }
                    for record in adapter_records
                ],
                "package_assembly": manifest_assembly,
                "derived": [derived_record],
                "task": {
                    **task_record,
                    "destination": str(
                        run / Path(task_record["destination"]).relative_to(temporary)
                    ),
                },
                "model_metadata": {
                    **offline_source_record(
                        model_metadata,
                        temporary / "model-metadata.json",
                        sources["model_metadata_sha256"],
                    ),
                    "destination": str(offline_destinations["model_metadata"]),
                    "model_name": model_name,
                    "thinking": thinking,
                    "entry": model_entry,
                },
                "offline": {
                    "model_data": {
                        **offline_source_record(
                            model_data,
                            temporary / "model-data.zip",
                            sources["model_data_sha256"],
                        ),
                        "destination": str(offline_destinations["model_data"]),
                    },
                    "node": {
                        **offline_source_record(
                            node_archive,
                            temporary / node_archive.name,
                            sources["node_sha256"],
                        ),
                        "destination": str(offline_destinations["node"]),
                    },
                    "system_dependencies": {
                        **offline_source_record(
                            dependencies,
                            temporary / "git-system-dependencies.zip",
                            sources["system_dependencies_sha256"],
                        ),
                        "destination": str(
                            offline_destinations["system_dependencies"]
                        ),
                    },
                },
                "extra_docker_compose": (
                    {
                        "source": str(compose_source),
                        "sha256": compose_sha256,
                        "destination": str(run / "network-override.yaml"),
                    }
                    if compose_source is not None
                    else None
                ),
            },
        )
        runner_common.write_json(
            temporary / "run-sources.json",
            {
                "at": runner_common.now(),
                "source_manifest": str(manifest_path),
                "source_manifest_sha256": runner_common.digest(manifest_path),
                "task": {
                    **task_record,
                    "destination": str(
                        run / Path(task_record["destination"]).relative_to(temporary)
                    ),
                },
                "current_sources": {
                    "pao": str(repository),
                    "benchmark": str(benchmark),
                    "sdk_host": str(sdk_host),
                },
                "container_mounts": mounts,
                "config_source": str(config_source),
                "config_source_sha256": sources["config_source_sha256"],
                "harbor_cache": str(
                    runner_common.absolute_path(sources["harbor_cache"], "harbor_cache")
                ),
                "model_name": model_name,
                "runtime_model_name": runtime_model_name,
                "thinking": thinking,
                "automatic_retries": 0,
                "extra_docker_compose": (
                    {
                        "source": str(compose_source),
                        "sha256": compose_sha256,
                        "path": str(run / "network-override.yaml"),
                    }
                    if compose_source is not None
                    else None
                ),
            },
        )
        runner_common.write_json(
            temporary / "run-freeze.json",
            {
                "files": runner_common.file_records(
                    temporary, exclude={"run-freeze.json"}
                )
            },
        )
        runner_common.validate_run_references(
            config, temporary, run, mounts
        )
        import bench_controller

        bench_controller.validate(
            temporary, final_run=run, container_mounts=mounts
        )
        temporary.replace(run)
        bench_controller.validate(
            run, final_run=run, container_mounts=mounts
        )
    except BaseException as failure:
        _cleanup_failed_prepare(temporary, failure)
        raise
    return {
        "run": str(run),
        "task": sources["task_name"],
        "model": model_name,
        "thinking": thinking,
        "source_sha256": source_record["archive_sha256"],
        "model_calls": 0,
        "docker_calls": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.sources), ensure_ascii=False))


if __name__ == "__main__":
    main()
