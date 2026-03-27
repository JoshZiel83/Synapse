#!/usr/bin/env python3
import json
import os
import re
import sys


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def parse_requested_platforms(raw_value: str) -> list[str] | None:
    value = (raw_value or "").strip()
    if not value or value.lower() == "all":
        return None

    requested: list[str] = []
    seen: set[str] = set()
    for item in re.split(r"[\s,]+", value):
        platform = item.strip()
        if not platform or platform in seen:
            continue
        requested.append(platform)
        seen.add(platform)
    return requested or None


def write_outputs(outputs: dict[str, str]) -> None:
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            for key, value in outputs.items():
                handle.write(f"{key}={value}\n")

    for key, value in outputs.items():
        print(f"{key}={value}")


def main() -> None:
    matrix_json = os.environ.get("MATRIX_JSON", "").strip()
    if not matrix_json:
        fail("MATRIX_JSON is required.")

    try:
        matrix = json.loads(matrix_json)
    except json.JSONDecodeError as exc:
        fail(f"Failed to parse MATRIX_JSON: {exc}")

    if not isinstance(matrix, list) or not matrix:
        fail("MATRIX_JSON must be a non-empty JSON array.")

    available_platforms: dict[str, dict] = {}
    for item in matrix:
        if not isinstance(item, dict):
            fail("Each matrix item must be a JSON object.")
        suffix = item.get("suffix")
        if not isinstance(suffix, str) or not suffix:
            fail("Each matrix item must include a non-empty string suffix.")
        if suffix in available_platforms:
            fail(f"Duplicate matrix suffix detected: {suffix}")
        available_platforms[suffix] = item

    requested_platforms = parse_requested_platforms(
        os.environ.get("REQUESTED_PLATFORMS", "all")
    )
    if requested_platforms is None:
        selected_matrix = matrix
    else:
        invalid_platforms = [
            platform
            for platform in requested_platforms
            if platform not in available_platforms
        ]
        if invalid_platforms:
            allowed = ", ".join(available_platforms)
            invalid = ", ".join(invalid_platforms)
            fail(
                f"Unsupported platforms: {invalid}. "
                f"Allowed values: {allowed}, or all."
            )
        selected_matrix = [
            available_platforms[platform] for platform in requested_platforms
        ]

    selected_platforms = ",".join(item["suffix"] for item in selected_matrix)
    print(f"Selected platforms: {selected_platforms}")

    write_outputs(
        {
            "matrix": json.dumps({"include": selected_matrix}, separators=(",", ":")),
            "selected_platforms": selected_platforms,
        }
    )


if __name__ == "__main__":
    main()
