"""T-133: README must present neuralgentics-web as a standalone product.

These tests guard against the README regressing back into "for the neuralgentics
ecosystem" framing. They also assert the README has the key install/quickstart
sections a new user needs to evaluate the package on its own.
"""

import tomllib
from pathlib import Path


def test_readme_exists():
    assert Path("README.md").exists()
    assert Path("README.md").read_text().strip() != ""


def test_readme_not_neuralgentics_only_framing():
    text = Path("README.md").read_text()
    forbidden = [
        "for the neuralgentics ecosystem",
        "modular web UI shell for neuralgentics",
    ]
    for phrase in forbidden:
        assert phrase.lower() not in text.lower(), f"Forbidden phrase found: {phrase!r}"


def test_readme_has_install_section():
    text = Path("README.md").read_text()
    assert "## Install" in text


def test_readme_has_quickstart_section():
    text = Path("README.md").read_text()
    assert "## Quickstart" in text


def test_readme_mentions_console_script():
    text = Path("README.md").read_text()
    assert "neuralgentics-web" in text
    assert "pip install" in text


def test_readme_has_what_this_is_not():
    text = Path("README.md").read_text()
    assert "## What this is NOT" in text


def test_pyproject_description_is_neutral():
    data = tomllib.loads(Path("pyproject.toml").read_text())
    desc = data["project"]["description"]
    assert "for neuralgentics" not in desc.lower()
    assert "standalone" in desc.lower() or "no other" in desc.lower()
