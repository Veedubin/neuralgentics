"""Project file indexer — scan directories, chunk text, store embeddings."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from memini_core.database import Database

# Common text file extensions to index
_ALLOWED_EXTENSIONS: set[str] = {
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".cfg",
    ".ini",
    ".sh",
    ".bash",
    ".rs",
    ".go",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".html",
    ".css",
    ".scss",
    ".sql",
    ".r",
    ".R",
}

# Directories to skip
_SKIP_DIRS: set[str] = {
    "node_modules",
    ".git",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "target",
    ".cargo",
}

DEFAULT_CHUNK_SIZE = 500
DEFAULT_CHUNK_OVERLAP = 50


class ProjectIndexer:
    """Index project files into the project_chunks table.

    Walks a directory tree, reads text files, chunks them, and stores
    each chunk with an auto-generated embedding.
    """

    def __init__(
        self,
        db: Database,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    ) -> None:
        self._db = db
        self._chunk_size = chunk_size
        self._chunk_overlap = chunk_overlap

    def index_directory(self, root_path: str | None = None) -> dict[str, Any]:
        """Index all eligible files under root_path.

        Args:
            root_path: Directory to index. Defaults to current directory.

        Returns:
            Dict with files_indexed and chunks_created counts.
        """
        target = Path(root_path or ".").resolve()
        if not target.is_dir():
            return {"files_indexed": 0, "chunks_created": 0}

        files_indexed = 0
        chunks_created = 0

        for file_path in target.rglob("*"):
            if not file_path.is_file():
                continue

            if not self._should_index(file_path):
                continue

            try:
                content = file_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

            # Remove old chunks for this file
            self._db.delete_chunks_by_path(str(file_path))

            # Chunk and store
            chunks = self._chunk_text(content)
            for i, chunk in enumerate(chunks):
                self._db.add_chunk(
                    file_path=str(file_path),
                    content=chunk,
                    metadata={"chunk_index": i, "total_chunks": len(chunks)},
                )
                chunks_created += 1

            files_indexed += 1

        return {"files_indexed": files_indexed, "chunks_created": chunks_created}

    def search(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        """Search indexed chunks by semantic similarity.

        Args:
            query: Natural language query.
            limit: Maximum results.

        Returns:
            List of chunk result dicts.
        """
        return self._db.search_chunks(query, limit=limit)

    def _should_index(self, path: Path) -> bool:
        """Check whether a file should be indexed."""
        if path.suffix.lower() not in _ALLOWED_EXTENSIONS:
            return False
        for part in path.parts:
            if part in _SKIP_DIRS:
                return False
        try:
            if path.stat().st_size > 2 * 1024 * 1024:  # 2 MB limit
                return False
        except OSError:
            return False
        return True

    def _chunk_text(self, text: str) -> list[str]:
        """Split text into overlapping chunks of approximately chunk_size chars.

        Uses a simple sliding window with overlap.
        """
        if len(text) <= self._chunk_size:
            return [text]

        chunks: list[str] = []
        start = 0
        while start < len(text):
            end = start + self._chunk_size
            chunks.append(text[start:end])
            start += self._chunk_size - self._chunk_overlap

        # Remove near-duplicate trailing overlap
        if len(chunks) > 1 and chunks[-1] == chunks[-2][-len(chunks[-1]) :]:
            chunks.pop()

        return chunks
