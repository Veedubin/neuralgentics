"""neuralgentics-web — modular web UI shell for neuralgentics.

Two modes:
  * embedded  — localhost-only, no auth, reads local files.
  * team-server — JWT+OAuth2 auth, PostgreSQL-backed, federated.

Entry point: ``python -m neuralgentics.web``.
"""

__version__ = "0.13.0"

__all__ = ["__version__"]
