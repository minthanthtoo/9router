#!/usr/bin/env python3
"""Compare official 9Router Git tags and npm metadata with the pinned patch base."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen

VERSION = re.compile(r"\d+\.\d+\.\d+\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")


def version_key(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError(f"Unsupported stable 9Router version: {version!r}")
    return tuple(int(part) for part in version.split("."))


def parse_tag_refs(output):
    tags = {}
    for line in output.splitlines():
        parts = line.split()
        if len(parts) != 2 or not SHA.fullmatch(parts[0]):
            continue
        match = re.fullmatch(r"refs/tags/v(\d+\.\d+\.\d+)", parts[1])
        if match:
            tags[match.group(1)] = parts[0]
    if not tags:
        raise ValueError("No stable official 9Router tags were returned")
    return tags


def inspect_refs(baseline, tag_refs, package):
    pinned_version = baseline["version"]
    pinned_base = baseline["base"]
    pinned_package_head = baseline.get("npm_git_head", pinned_base)
    version_key(pinned_version)
    for label, value in (("pinned tag", pinned_base), ("pinned npm gitHead", pinned_package_head)):
        if not isinstance(value, str) or not SHA.fullmatch(value):
            raise ValueError(f"Invalid {label} commit")

    tags = parse_tag_refs(tag_refs)
    pinned_tag_sha = tags.get(pinned_version)

    package_version = package.get("version")
    package_head = package.get("gitHead")
    version_key(package_version)
    if not isinstance(package_head, str) or not SHA.fullmatch(package_head):
        raise ValueError("npm metadata did not include a valid gitHead")

    latest_tag_version = max(tags, key=version_key)
    latest_tag_sha = tags[latest_tag_version]
    reasons = []
    if pinned_tag_sha is None:
        reasons.append("The pinned official Git tag is missing")
    elif pinned_tag_sha != pinned_base:
        reasons.append("The pinned official tag now points to a different commit")
    if version_key(latest_tag_version) > version_key(pinned_version):
        reasons.append("A newer official Git tag is available")
    if version_key(package_version) > version_key(pinned_version):
        reasons.append("A newer npm release is available")
    elif package_version == pinned_version and package_head != pinned_package_head:
        reasons.append("The pinned npm version now points to a different gitHead")
    if package_version != latest_tag_version:
        reasons.append("The latest npm version and Git tag do not match")

    return {
        "pinned_version": pinned_version,
        "pinned_base": pinned_base,
        "pinned_npm_git_head": pinned_package_head,
        "latest_tag_version": latest_tag_version,
        "latest_tag_sha": latest_tag_sha,
        "npm_version": package_version,
        "npm_git_head": package_head,
        "review_required": bool(reasons),
        "reasons": reasons,
    }


def read_live_refs(repository, package_name):
    tags = subprocess.check_output(
        ["git", "ls-remote", "--tags", "--refs", repository, "refs/tags/v*"],
        text=True,
    )
    request = Request(
        f"https://registry.npmjs.org/{package_name}/latest",
        headers={"Accept": "application/json", "User-Agent": "9router-upstream-watch"},
    )
    with urlopen(request, timeout=20) as response:
        registry = json.load(response)
    package = {"version": registry.get("version"), "gitHead": registry.get("gitHead")}
    return tags, package


def write_github_output(report, path):
    if not path:
        return
    lines = [
        f"review-required={'true' if report['review_required'] else 'false'}",
        f"pinned-version={report['pinned_version']}",
        f"pinned-base={report['pinned_base']}",
        f"latest-tag-version={report['latest_tag_version']}",
        f"latest-tag-sha={report['latest_tag_sha']}",
        f"npm-version={report['npm_version']}",
        f"npm-git-head={report['npm_git_head']}",
        "reasons=" + "; ".join(report["reasons"]),
    ]
    with open(path, "a", encoding="utf-8") as output:
        output.write("\n".join(lines) + "\n")


def main():
    repo = Path(__file__).resolve().parents[2]
    config = json.loads((repo / "patches/upstream.json").read_text(encoding="utf-8"))
    tags, package = read_live_refs(config["repository"], "9router")
    report = inspect_refs(config, tags, package)
    print(json.dumps(report, indent=2))
    write_github_output(report, os.environ.get("GITHUB_OUTPUT"))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as output:
            state = "REVIEW REQUIRED" if report["review_required"] else "UP TO DATE"
            output.write(f"## Official 9Router watch: {state}\n\n")
            output.write(f"Pinned: v{report['pinned_version']} (`{report['pinned_base']}`)\n\n")
            output.write(f"Git tag: v{report['latest_tag_version']} (`{report['latest_tag_sha']}`)\n\n")
            output.write(f"npm: {report['npm_version']} (`{report['npm_git_head']}`)\n\n")
            if report["reasons"]:
                output.write("Reasons: " + "; ".join(report["reasons"]) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError, KeyError, ValueError) as error:
        print(f"upstream check failed closed: {error}", file=sys.stderr)
        raise SystemExit(1)
