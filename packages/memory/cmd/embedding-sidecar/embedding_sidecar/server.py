"""gRPC server implementing EmbeddingService for the Python sidecar."""

from __future__ import annotations

import asyncio
from concurrent import futures

import grpc

from embedding_sidecar.embed import EmbeddingEngine
from embedding_sidecar.health import create_health_service, register_health
from embedding_sidecar.proto.embedding.v1 import embedding_pb2, embedding_pb2_grpc


class EmbeddingServiceServicer(embedding_pb2_grpc.EmbeddingServiceServicer):
    """Implements the EmbeddingService gRPC service."""

    def __init__(self, engine: EmbeddingEngine) -> None:
        self.engine = engine

    async def Embed(
        self,
        request: embedding_pb2.EmbedRequest,
        context: grpc.aio.ServicerContext,
    ) -> embedding_pb2.EmbedResponse:
        """Generate a single embedding vector from text."""
        if not request.text:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "text is required")

        model_hint = request.model if request.model else None
        vector, dimensions, model, latency_us = await asyncio.to_thread(
            self.engine.embed, request.text, model_hint
        )
        return embedding_pb2.EmbedResponse(
            vector=vector,
            dimensions=dimensions,
            model=model,
            latency_us=latency_us,
        )

    async def EmbedBatch(
        self,
        request_iterator: grpc.aio.StreamIterator[embedding_pb2.EmbedRequest],
        context: grpc.aio.ServicerContext,
    ) -> embedding_pb2.EmbedResponse:
        """Generate embeddings for a stream of texts, yielding responses."""
        texts: list[str] = []
        model_hint: str | None = None
        async for request in request_iterator:
            if not request.text:
                await context.abort(
                    grpc.StatusCode.INVALID_ARGUMENT, "text is required"
                )
            texts.append(request.text)
            if request.model and not model_hint:
                model_hint = request.model

        if not texts:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "no texts provided")

        results = await asyncio.to_thread(self.engine.embed_batch, texts, model_hint)
        for vector, dimensions, model, latency_us in results:
            yield embedding_pb2.EmbedResponse(
                vector=vector,
                dimensions=dimensions,
                model=model,
                latency_us=latency_us,
            )

    async def Health(
        self,
        request: embedding_pb2.HealthRequest,
        context: grpc.aio.ServicerContext,
    ) -> embedding_pb2.HealthResponse:
        """Return readiness status."""
        return embedding_pb2.HealthResponse(status="ready")


async def serve(
    listen_addr: str = "unix:///tmp/neuralgentics-embed.sock",
) -> grpc.aio.Server:
    """Create and start the gRPC embedding sidecar server."""
    engine = EmbeddingEngine()

    server = grpc.aio.server(futures.ThreadPoolExecutor(max_workers=4))
    embedding_pb2_grpc.add_EmbeddingServiceServicer_to_server(
        EmbeddingServiceServicer(engine), server
    )

    # Register health service
    health_service = create_health_service()
    register_health(server, health_service)

    server.add_insecure_port(listen_addr)
    await server.start()
    return server
