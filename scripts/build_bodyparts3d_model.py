#!/usr/bin/env python3
"""Build the licensed BodyParts3D anatomy subset used by the Three.js viewer.

The source archive is intentionally external to Git. This script combines the
required OBJ elements into stable, semantically named objects that survive the
OBJ -> GLB conversion step.
"""

from __future__ import annotations

import argparse
import re
import zipfile
from collections import defaultdict
from pathlib import Path


GROUPS: dict[str, tuple[str, ...]] = {
    "body_shell": ("FMA7163",),
    "rib_cage": ("FMA7480",),
    "trachea": ("FMA7394",),
    "esophagus": ("FMA7131",),
    "vessels": ("FMA3734", "FMA4720", "FMA10951"),
    "heart": ("FMA7088",),
    "lungs": ("FMA7309", "FMA7310"),
    "liver": ("FMA7197",),
    "gallbladder": ("FMA7202",),
    "stomach": ("FMA7148",),
    "pancreas": ("FMA7198",),
    "kidney": ("FMA7204", "FMA7205"),
    "intestines": ("FMA7200", "FMA7201"),
    "prostate": ("FMA9600",),
}


def load_elements(path: Path) -> dict[str, list[str]]:
    concepts: dict[str, list[str]] = defaultdict(list)
    for line in path.read_text(encoding="utf-8").splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) >= 3:
            concepts[parts[0]].append(parts[2])
    return concepts


def offset_index(token: str, vertex_offset: int, texture_offset: int, normal_offset: int) -> str:
    values = token.split("/")
    offsets = (vertex_offset, texture_offset, normal_offset)
    adjusted: list[str] = []
    for index, value in enumerate(values):
        if not value:
            adjusted.append("")
            continue
        number = int(value)
        adjusted.append(str(number + offsets[index]) if number > 0 else str(number))
    return "/".join(adjusted)


def build(zip_path: Path, elements_path: Path, output: Path) -> None:
    concepts = load_elements(elements_path)
    vertex_offset = texture_offset = normal_offset = 0
    lines: list[str] = ["# HealthPocket BodyParts3D derived anatomy subset", "s 1"]
    with zipfile.ZipFile(zip_path) as archive:
        archive_names = {Path(name).name: name for name in archive.namelist() if name.endswith(".obj")}
        for group, concept_ids in GROUPS.items():
            file_ids = list(dict.fromkeys(file_id for concept_id in concept_ids for file_id in concepts[concept_id]))
            available = [file_id for file_id in file_ids if f"{file_id}.obj" in archive_names]
            if not available:
                raise RuntimeError(f"No OBJ elements found for {group}: {concept_ids}")
            lines.append(f"o {group}_1")
            for file_id in available:
                payload = archive.read(archive_names[f"{file_id}.obj"]).decode("utf-8", errors="replace")
                local_vertices = local_textures = local_normals = 0
                for raw_line in payload.splitlines():
                    if raw_line.startswith("v "):
                        lines.append(raw_line)
                        local_vertices += 1
                    elif raw_line.startswith("vt "):
                        lines.append(raw_line)
                        local_textures += 1
                    elif raw_line.startswith("vn "):
                        lines.append(raw_line)
                        local_normals += 1
                    elif raw_line.startswith("f "):
                        parts = re.split(r"\s+", raw_line.strip())
                        face = " ".join(
                            offset_index(token, vertex_offset, texture_offset, normal_offset)
                            for token in parts[1:]
                        )
                        lines.append(f"f {face}")
                vertex_offset += local_vertices
                texture_offset += local_textures
                normal_offset += local_normals
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {output} with {vertex_offset:,} vertices")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", type=Path, required=True, help="BodyParts3D OBJ archive")
    parser.add_argument("--elements", type=Path, required=True, help="BodyParts3D element mapping TSV")
    parser.add_argument("--output", type=Path, required=True, help="Merged OBJ destination")
    args = parser.parse_args()
    build(args.zip, args.elements, args.output)


if __name__ == "__main__":
    main()
