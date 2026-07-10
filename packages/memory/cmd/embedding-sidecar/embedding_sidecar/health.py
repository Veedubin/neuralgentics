"""gRPC health check service for the embedding sidecar.

Also provides a helper to build the JSON status payload used by the HTTP
/status endpoint (kept here so all health/status logic lives in one place).
"""

from __future__ import annotations

import json
from typing import Any

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc


def create_health_service() -> tuple[
    health.HealthServicer, health_pb2_grpc.HealthServicerToServerServicer
]:
    """Create a gRPC health service that reports SERVING."""
    service = health.HealthServicer()
    service.set(
        "",
        health_pb2.HealthCheckResponse.SERVING,
    )
    return service


def register_health(server: grpc.aio.Server, service: health.HealthServicer) -> None:
    """Register the health service on a gRPC server."""
    health_pb2_grpc.add_HealthServicer_to_server(service, server)


def build_status_json(status_dict: dict[str, Any]) -> bytes:
    """Serialize a status dict to JSON bytes for the HTTP /status endpoint.

    Args:
        status_dict: The dict returned by ModelManager.status().

    Returns:
        UTF-8 encoded JSON bytes with 2-space indentation.
    """
    return json.dumps(status_dict, indent=2).encode("utf-8")
