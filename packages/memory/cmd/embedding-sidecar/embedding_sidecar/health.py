"""gRPC health check service for the embedding sidecar."""

from __future__ import annotations

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
