-- Lazy Tool Exposure: agent_tools table
-- Tracks which tools each agent/peer has been exposed to via demand-driven expansion.
-- The broker catalog builder includes previously-requested tools in future builds.

CREATE TABLE IF NOT EXISTS agent_tools (
    id BIGSERIAL PRIMARY KEY,
    peer_id TEXT NOT NULL,
    tool_server TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    first_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    use_count INTEGER NOT NULL DEFAULT 0,
    bypass_broker BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(peer_id, tool_server, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_tools_peer ON agent_tools(peer_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_bypass ON agent_tools(bypass_broker) WHERE bypass_broker = TRUE;