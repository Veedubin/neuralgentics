package main

import (
	"encoding/json"
	"testing"
)

// ─── Status Handler Tests ──────────────────────────────────────────────────────

// NOTE: handleMemoryGetStatus and handleMemoryCount call memSys directly
// with no required params, so they panic with nil memSys. They are tested
// via TestAllNewMethods_WithRequiredParams below, which routes param-first methods.
// For paramless methods, we verify the switch routing via a simple compile-time check:
// all 30 methods appear in the switch statement in handleRequest.

// ─── Audit Handler Tests ───────────────────────────────────────────────────────

func TestHandleRequest_LogAuditEvent_MissingParams(t *testing.T) {
	t.Parallel()

	t.Run("nil params returns error", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("lae1"),
			Method:  "memory.logAuditEvent",
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for nil params")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("missing eventType returns error", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("lae2"),
			Method:  "memory.logAuditEvent",
			Params:  json.RawMessage(`{"description":"test"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for missing eventType")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_GetAuditEvents_Recognized(t *testing.T) {
	t.Parallel()

	// getAuditLog accepts nil params — verify it's a known method by sending invalid params
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("gae1"),
		Method:  "memory.getAuditLog",
		Params:  json.RawMessage(`{invalid}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for invalid params")
	}
	if resp.Error.Code == -32601 {
		t.Error("memory.getAuditLog should be a recognized method")
	}
}

// ─── Trust Handler Tests ──────────────────────────────────────────────────────

func TestHandleRequest_GetTrustScore_MissingMemoryID(t *testing.T) {
	t.Parallel()

	t.Run("nil params", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("gts1"),
			Method:  "memory.getTrustScore",
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for nil params")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("empty memoryId", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("gts2"),
			Method:  "memory.getTrustScore",
			Params:  json.RawMessage(`{"memoryId":""}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty memoryId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_ListArchived_Recognized(t *testing.T) {
	t.Parallel()

	// listArchived accepts nil params — verify it's a known method by sending invalid params
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("la1"),
		Method:  "memory.listArchived",
		Params:  json.RawMessage(`{invalid}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for invalid params")
	}
	if resp.Error.Code == -32601 {
		t.Error("memory.listArchived should be recognized")
	}
}

// ─── Decay Handler Tests ──────────────────────────────────────────────────────

func TestHandleRequest_GetDecayStatus_Recognized(t *testing.T) {
	t.Parallel()

	// getDecayStatus accepts nil params — verify it's recognized by sending invalid params
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("gds1"),
		Method:  "memory.getDecayStatus",
		Params:  json.RawMessage(`{invalid}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for invalid params")
	}
	if resp.Error.Code == -32601 {
		t.Error("memory.getDecayStatus should be recognized")
	}
}

func TestHandleRequest_AdjustDecayRate_MissingParams(t *testing.T) {
	t.Parallel()

	t.Run("nil params", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("adr1"),
			Method:  "memory.adjustDecayRate",
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for nil params")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("empty memoryId", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("adr2"),
			Method:  "memory.adjustDecayRate",
			Params:  json.RawMessage(`{"memoryId":"","rate":1.0}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty memoryId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_TriggerConsolidation_Recognized(t *testing.T) {
	t.Parallel()

	// triggerConsolidation accepts nil params — verify it's recognized
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("tc1"),
		Method:  "memory.triggerConsolidation",
		Params:  json.RawMessage(`{invalid}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for invalid params")
	}
	if resp.Error.Code == -32601 {
		t.Error("memory.triggerConsolidation should be recognized")
	}
}

func TestHandleRequest_ListFadingMemories_Recognized(t *testing.T) {
	t.Parallel()

	// listFadingMemories accepts nil params — verify it's recognized
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("lfm1"),
		Method:  "memory.listFadingMemories",
		Params:  json.RawMessage(`{invalid}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for invalid params")
	}
	if resp.Error.Code == -32601 {
		t.Error("memory.listFadingMemories should be recognized")
	}
}

// ─── Knowledge Graph Handler Tests ────────────────────────────────────────────

func TestHandleRequest_ExtractEntities_MissingParams(t *testing.T) {
	t.Parallel()

	t.Run("nil params", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("ee1"),
			Method:  "memory.extractEntities",
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for nil params")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("empty text", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("ee2"),
			Method:  "memory.extractEntities",
			Params:  json.RawMessage(`{"text":""}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty text")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_QueryKG_MissingStartEntity(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("qkg1"),
		Method:  "memory.queryKG",
		Params:  json.RawMessage(`{"endEntity":"entity2"}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for missing startEntity")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

func TestHandleRequest_SearchEntities_MissingName(t *testing.T) {
	t.Parallel()

	t.Run("nil params", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("se1"),
			Method:  "memory.searchEntities",
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("empty name", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("se2"),
			Method:  "memory.searchEntities",
			Params:  json.RawMessage(`{"name":""}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty name")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_GetEntitiesByType_MissingType(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("gebt1"),
		Method:  "memory.getEntitiesByType",
		Params:  json.RawMessage(`{"entityType":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty entityType")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

func TestHandleRequest_CreateEntityRelationship_MissingFields(t *testing.T) {
	t.Parallel()

	t.Run("missing sourceId", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("cer1"),
			Method:  "memory.createEntityRelationship",
			Params:  json.RawMessage(`{"targetId":"t1","relType":"RELATED_TO"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for missing sourceId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("missing targetId", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("cer2"),
			Method:  "memory.createEntityRelationship",
			Params:  json.RawMessage(`{"sourceId":"s1","relType":"RELATED_TO"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for missing targetId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("missing relType", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("cer3"),
			Method:  "memory.createEntityRelationship",
			Params:  json.RawMessage(`{"sourceId":"s1","targetId":"t1"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for missing relType")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_GetEntityGraph_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("geg1"),
		Method:  "memory.getEntityGraph",
		Params:  json.RawMessage(`{"entityId":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty entityId")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

func TestHandleRequest_RenderGraphHTML_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("rgh1"),
		Method:  "memory.renderGraphHTML",
		Params:  json.RawMessage(`{"entityId":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty entityId")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

// ─── Thought Chain Handler Tests ───────────────────────────────────────────────

func TestHandleRequest_StartThoughtChain_Recognized(t *testing.T) {
	t.Parallel()

	// startThoughtChain accepts nil params — verify it's recognized
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("stc1"),
		Method:  "memory.startThoughtChain",
		Params:  json.RawMessage(`{invalid}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for invalid params")
	}
	if resp.Error.Code == -32601 {
		t.Error("memory.startThoughtChain should be recognized")
	}
}

func TestHandleRequest_AddThought_MissingParams(t *testing.T) {
	t.Parallel()

	t.Run("nil params", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("at1"),
			Method:  "memory.addThought",
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for nil params")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("empty chainId", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("at2"),
			Method:  "memory.addThought",
			Params:  json.RawMessage(`{"chainId":"","thought":"test","thoughtNumber":1,"totalThoughts":3,"nextThoughtNeeded":true}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty chainId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("empty thought", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("at3"),
			Method:  "memory.addThought",
			Params:  json.RawMessage(`{"chainId":"abc","thought":"","thoughtNumber":1,"totalThoughts":3,"nextThoughtNeeded":true}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty thought")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("zero thoughtNumber", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("at4"),
			Method:  "memory.addThought",
			Params:  json.RawMessage(`{"chainId":"abc","thought":"hello","thoughtNumber":0,"totalThoughts":3,"nextThoughtNeeded":true}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for zero thoughtNumber")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("zero totalThoughts", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("at5"),
			Method:  "memory.addThought",
			Params:  json.RawMessage(`{"chainId":"abc","thought":"hello","thoughtNumber":1,"totalThoughts":0,"nextThoughtNeeded":true}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for zero totalThoughts")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_GetThoughtChain_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("gtc1"),
		Method:  "memory.getThoughtChain",
		Params:  json.RawMessage(`{"chainId":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty chainId")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

func TestHandleRequest_GetRelatedThoughtChains_MissingQuery(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("grtc1"),
		Method:  "memory.getRelatedThoughtChains",
		Params:  json.RawMessage(`{"query":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty query")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

func TestHandleRequest_ReviseThought_MissingFields(t *testing.T) {
	t.Parallel()

	t.Run("empty chainId", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("rt1"),
			Method:  "memory.reviseThought",
			Params:  json.RawMessage(`{"chainId":"","thoughtNumber":1,"revisedThought":"new text"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty chainId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("zero thoughtNumber", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("rt2"),
			Method:  "memory.reviseThought",
			Params:  json.RawMessage(`{"chainId":"abc","thoughtNumber":0,"revisedThought":"new text"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for zero thoughtNumber")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("empty revisedThought", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("rt3"),
			Method:  "memory.reviseThought",
			Params:  json.RawMessage(`{"chainId":"abc","thoughtNumber":1,"revisedThought":""}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty revisedThought")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_BranchThought_MissingFields(t *testing.T) {
	t.Parallel()

	t.Run("empty chainId", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("bt1"),
			Method:  "memory.branchThought",
			Params:  json.RawMessage(`{"chainId":"","branchId":"b1","thought":"alt path"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty chainId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("empty branchId", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("bt2"),
			Method:  "memory.branchThought",
			Params:  json.RawMessage(`{"chainId":"abc","branchId":"","thought":"alt path"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty branchId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("empty thought", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("bt3"),
			Method:  "memory.branchThought",
			Params:  json.RawMessage(`{"chainId":"abc","branchId":"b1","thought":""}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty thought")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_PauseThoughtChain_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("ptc1"),
		Method:  "memory.pauseThoughtChain",
		Params:  json.RawMessage(`{"chainId":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty chainId")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

func TestHandleRequest_ResumeThoughtChain_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("rtc1"),
		Method:  "memory.resumeThoughtChain",
		Params:  json.RawMessage(`{"chainId":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty chainId")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

func TestHandleRequest_AbandonThoughtChain_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("atc1"),
		Method:  "memory.abandonThoughtChain",
		Params:  json.RawMessage(`{"chainId":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty chainId")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

// ─── Dialectic Handler Tests ──────────────────────────────────────────────────

func TestHandleRequest_FindContradictions_Recognized(t *testing.T) {
	t.Parallel()

	// findContradictions accepts nil params — verify it's recognized
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("fc1"),
		Method:  "memory.findContradictions",
		Params:  json.RawMessage(`{invalid}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for invalid params")
	}
	if resp.Error.Code == -32601 {
		t.Error("memory.findContradictions should be recognized")
	}
}

func TestHandleRequest_ResolveContradiction_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("rc1"),
		Method:  "memory.resolveContradiction",
		Params:  json.RawMessage(`{"contradictionId":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty contradictionId")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

func TestHandleRequest_ChallengeMemory_MissingFields(t *testing.T) {
	t.Parallel()

	t.Run("missing memoryId", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("cm1"),
			Method:  "memory.challengeMemory",
			Params:  json.RawMessage(`{"memoryId":"","challengeText":"I disagree"}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty memoryId")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})

	t.Run("missing challengeText", func(t *testing.T) {
		t.Parallel()
		req := jsonrpcRequest{
			JSONRPC: "2.0",
			ID:      jsonRawID("cm2"),
			Method:  "memory.challengeMemory",
			Params:  json.RawMessage(`{"memoryId":"abc","challengeText":""}`),
		}
		resp := handleRequest(nil, req, nil, nil, nil)
		if resp.Error == nil {
			t.Fatal("expected error for empty challengeText")
		}
		if resp.Error.Code != -32602 {
			t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
		}
	})
}

func TestHandleRequest_GetDialecticHistory_MissingID(t *testing.T) {
	t.Parallel()

	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      jsonRawID("gdh1"),
		Method:  "memory.getDialecticHistory",
		Params:  json.RawMessage(`{"memoryId":""}`),
	}
	resp := handleRequest(nil, req, nil, nil, nil)
	if resp.Error == nil {
		t.Fatal("expected error for empty memoryId")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code: got %d, want %d", resp.Error.Code, -32602)
	}
}

// ─── Comprehensive Method Routing Tests ────────────────────────────────────────
// Verify that all new methods are recognized (not "method not found").
// Only methods that have required params can be tested with nil memSys,
// because param validation runs before the memSys call and returns -32602.
// Methods that accept nil/optional params would panic with nil memSys,
// so they are verified indirectly by the handler tests above.

func TestAllNewMethods_WithRequiredParams_Recognized(t *testing.T) {
	t.Parallel()

	// These methods all require specific params; missing/invalid params will
	// trigger -32602 before hitting the nil memSys.
	methodsWithMissingParamTests := []struct {
		method string
		params string // minimal params that trigger param validation error
	}{
		// Audit
		{"memory.logAuditEvent", ``}, // nil params triggers -32602

		// Trust
		{"memory.getTrustScore", `{"memoryId":""}`},

		// Decay
		{"memory.adjustDecayRate", `{"memoryId":""}`},

		// Knowledge Graph
		{"memory.extractEntities", `{"text":""}`},
		{"memory.queryKG", `{"endEntity":"e2"}`}, // missing startEntity
		{"memory.searchEntities", `{"name":""}`},
		{"memory.getEntitiesByType", `{"entityType":""}`},
		{"memory.createEntityRelationship", `{"sourceId":"","targetId":"t1","relType":"RELATED_TO"}`},
		{"memory.getEntityGraph", `{"entityId":""}`},
		{"memory.renderGraphHTML", `{"entityId":""}`},

		// Thought Chains
		{"memory.addThought", `{"chainId":"","thought":"t","thoughtNumber":1,"totalThoughts":1,"nextThoughtNeeded":true}`},
		{"memory.getThoughtChain", `{"chainId":""}`},
		{"memory.getRelatedThoughtChains", `{"query":""}`},
		{"memory.reviseThought", `{"chainId":"","thoughtNumber":1,"revisedThought":"x"}`},
		{"memory.branchThought", `{"chainId":"","branchId":"b","thought":"x"}`},
		{"memory.pauseThoughtChain", `{"chainId":""}`},
		{"memory.resumeThoughtChain", `{"chainId":""}`},
		{"memory.abandonThoughtChain", `{"chainId":""}`},

		// Dialectic
		{"memory.resolveContradiction", `{"contradictionId":""}`},
		{"memory.challengeMemory", `{"memoryId":"","challengeText":"x"}`},
		{"memory.getDialecticHistory", `{"memoryId":""}`},
	}

	for _, tt := range methodsWithMissingParamTests {
		t.Run(tt.method, func(t *testing.T) {
			t.Parallel()

			var params json.RawMessage
			if tt.params != "" {
				params = json.RawMessage(tt.params)
			}

			req := jsonrpcRequest{
				JSONRPC: "2.0",
				ID:      jsonRawID(tt.method),
				Method:  tt.method,
				Params:  params,
			}
			resp := handleRequest(nil, req, nil, nil, nil)
			// Must NOT return "method not found" (-32601)
			if resp.Error == nil {
				// Some paramless methods might succeed — that's fine
				return
			}
			if resp.Error.Code == -32601 {
				t.Errorf("method %q should be recognized (got method not found)", tt.method)
			}
			// Getting -32602 (invalid params) or -32603 (internal error) means
			// the method IS recognized, which is what we're testing.
		})
	}
}

// TestParamlessMethods_Recognized verifies that methods without required params
// are recognized by the routing switch. We test this by sending invalid JSON
// params which should trigger -32602, proving the method is routed.
func TestParamlessMethods_Recognized(t *testing.T) {
	t.Parallel()

	// These methods accept nil params; we send invalid JSON to trigger -32602
	// which proves the method was recognized and param parsing was attempted.
	paramlessMethods := []string{
		"memory.status",
		"memory.count",
		"memory.getAuditLog",
		"memory.listArchived",
		"memory.getDecayStatus",
		"memory.triggerConsolidation",
		"memory.listFadingMemories",
		"memory.startThoughtChain",
		"memory.findContradictions",
	}

	for _, method := range paramlessMethods {
		t.Run(method, func(t *testing.T) {
			t.Parallel()

			// Send intentionally invalid JSON params to trigger parsing error
			req := jsonrpcRequest{
				JSONRPC: "2.0",
				ID:      jsonRawID(method),
				Method:  method,
				Params:  json.RawMessage(`{invalid}`),
			}
			resp := handleRequest(nil, req, nil, nil, nil)
			// Must NOT return "method not found" (-32601)
			if resp.Error == nil {
				t.Errorf("expected error for invalid JSON params, got success")
				return
			}
			if resp.Error.Code == -32601 {
				t.Errorf("method %q should be recognized (got method not found)", method)
			}
			// We expect -32602 (invalid params) which proves the method exists
			if resp.Error.Code != -32602 {
				t.Errorf("expected -32602 for invalid params, got code %d: %s", resp.Error.Code, resp.Error.Message)
			}
		})
	}
}

// ─── Param Unmarshaling Round-Trip Tests ───────────────────────────────────────
// Verify that the param structs correctly unmarshal from JSON

func TestParamUnmarshaling_Status(t *testing.T) {
	t.Parallel()

	t.Run("memoryGetStatusParams empty object", func(t *testing.T) {
		t.Parallel()
		var params memoryGetStatusParams
		if err := json.Unmarshal([]byte(`{}`), &params); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestParamUnmarshaling_LogAuditEvent(t *testing.T) {
	t.Parallel()

	var params memoryLogAuditEventParams
	raw := `{"eventType":"auth_failure","severity":"warning","sessionId":"s1","peerId":"p1","agentName":"agent","toolName":"tool","memoryId":"m1","description":"test","details":{"key":"val"}}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.EventType != "auth_failure" {
		t.Errorf("eventType: got %q, want %q", params.EventType, "auth_failure")
	}
	if params.Severity != "warning" {
		t.Errorf("severity: got %q, want %q", params.Severity, "warning")
	}
	if params.Description != "test" {
		t.Errorf("description: got %q, want %q", params.Description, "test")
	}
	if params.Details["key"] != "val" {
		t.Errorf("details.key: got %v, want %q", params.Details["key"], "val")
	}
}

func TestParamUnmarshaling_QueryKG(t *testing.T) {
	t.Parallel()

	var params memoryQueryKGParams
	raw := `{"startEntity":"e1","endEntity":"e2","relationshipTypes":["RELATED_TO"],"maxDepth":5,"limit":100}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.StartEntity != "e1" {
		t.Errorf("startEntity: got %q, want %q", params.StartEntity, "e1")
	}
	if params.EndEntity != "e2" {
		t.Errorf("endEntity: got %q, want %q", params.EndEntity, "e2")
	}
	if len(params.RelationshipTypes) != 1 || params.RelationshipTypes[0] != "RELATED_TO" {
		t.Errorf("relationshipTypes: got %v", params.RelationshipTypes)
	}
	if params.MaxDepth == nil || *params.MaxDepth != 5 {
		t.Errorf("maxDepth: got %v, want 5", params.MaxDepth)
	}
	if params.Limit == nil || *params.Limit != 100 {
		t.Errorf("limit: got %v, want 100", params.Limit)
	}
}

func TestParamUnmarshaling_AddThought(t *testing.T) {
	t.Parallel()

	var params memoryAddThoughtParams
	raw := `{"chainId":"chain-1","thought":"reasoning step","thoughtNumber":2,"totalThoughts":5,"nextThoughtNeeded":true}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.ChainID != "chain-1" {
		t.Errorf("chainId: got %q, want %q", params.ChainID, "chain-1")
	}
	if params.Thought != "reasoning step" {
		t.Errorf("thought: got %q, want %q", params.Thought, "reasoning step")
	}
	if params.ThoughtNumber != 2 {
		t.Errorf("thoughtNumber: got %d, want %d", params.ThoughtNumber, 2)
	}
	if params.TotalThoughts != 5 {
		t.Errorf("totalThoughts: got %d, want %d", params.TotalThoughts, 5)
	}
	if !params.NextNeeded {
		t.Error("nextThoughtNeeded: got false, want true")
	}
}

func TestParamUnmarshaling_BranchThought(t *testing.T) {
	t.Parallel()

	var params memoryBranchThoughtParams
	raw := `{"chainId":"chain-1","fromThoughtNumber":3,"branchId":"branch-a","thought":"alternate path","thoughtNumber":1,"totalThoughts":2,"nextThoughtNeeded":true}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.ChainID != "chain-1" {
		t.Errorf("chainId: got %q, want %q", params.ChainID, "chain-1")
	}
	if params.FromThought != 3 {
		t.Errorf("fromThoughtNumber: got %d, want %d", params.FromThought, 3)
	}
	if params.BranchID != "branch-a" {
		t.Errorf("branchId: got %q, want %q", params.BranchID, "branch-a")
	}
}

func TestParamUnmarshaling_AdjustDecayRate(t *testing.T) {
	t.Parallel()

	var params memoryAdjustDecayRateParams
	raw := `{"memoryId":"mem-123","rate":2.5}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.MemoryID != "mem-123" {
		t.Errorf("memoryId: got %q, want %q", params.MemoryID, "mem-123")
	}
	if params.Rate != 2.5 {
		t.Errorf("rate: got %f, want %f", params.Rate, 2.5)
	}
}

func TestParamUnmarshaling_FindContradictions(t *testing.T) {
	t.Parallel()

	var params memoryFindContradictionsParams
	raw := `{"query":"test query","limit":5}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.Query != "test query" {
		t.Errorf("query: got %q, want %q", params.Query, "test query")
	}
	if params.Limit == nil || *params.Limit != 5 {
		t.Errorf("limit: got %v, want 5", params.Limit)
	}
}

func TestParamUnmarshaling_ChallengeMemory(t *testing.T) {
	t.Parallel()

	var params memoryChallengeMemoryParams
	raw := `{"memoryId":"m1","challengerId":"c1","challengeText":"I disagree with this"}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.MemoryID != "m1" {
		t.Errorf("memoryId: got %q, want %q", params.MemoryID, "m1")
	}
	if params.ChallengerID != "c1" {
		t.Errorf("challengerId: got %q, want %q", params.ChallengerID, "c1")
	}
	if params.ChallengeText != "I disagree with this" {
		t.Errorf("challengeText: got %q, want %q", params.ChallengeText, "I disagree with this")
	}
}

func TestParamUnmarshaling_CreateEntityRelationship(t *testing.T) {
	t.Parallel()

	var params memoryCreateEntityRelationshipParams
	raw := `{"sourceId":"e1","targetId":"e2","relType":"RELATED_TO","confidence":0.85}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.SourceID != "e1" {
		t.Errorf("sourceId: got %q, want %q", params.SourceID, "e1")
	}
	if params.TargetID != "e2" {
		t.Errorf("targetId: got %q, want %q", params.TargetID, "e2")
	}
	if params.RelType != "RELATED_TO" {
		t.Errorf("relType: got %q, want %q", params.RelType, "RELATED_TO")
	}
	if params.Confidence != 0.85 {
		t.Errorf("confidence: got %f, want %f", params.Confidence, 0.85)
	}
}

func TestParamUnmarshaling_GetEntityGraph(t *testing.T) {
	t.Parallel()

	var params memoryGetEntityGraphParams
	raw := `{"entityId":"ent-1","depth":3}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.EntityID != "ent-1" {
		t.Errorf("entityId: got %q, want %q", params.EntityID, "ent-1")
	}
	if params.Depth == nil || *params.Depth != 3 {
		t.Errorf("depth: got %v, want 3", params.Depth)
	}
}

func TestParamUnmarshaling_TriggerConsolidation(t *testing.T) {
	t.Parallel()

	t.Run("with force=true", func(t *testing.T) {
		t.Parallel()
		var params memoryTriggerConsolidationParams
		raw := `{"force":true}`
		if err := json.Unmarshal([]byte(raw), &params); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !params.Force {
			t.Error("force: got false, want true")
		}
	})

	t.Run("without force (defaults to false)", func(t *testing.T) {
		t.Parallel()
		var params memoryTriggerConsolidationParams
		raw := `{}`
		if err := json.Unmarshal([]byte(raw), &params); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if params.Force {
			t.Error("force: got true, want false (default)")
		}
	})
}

func TestParamUnmarshaling_ReviseThought(t *testing.T) {
	t.Parallel()

	var params memoryReviseThoughtParams
	raw := `{"chainId":"c1","thoughtNumber":3,"revisedThought":"updated thought text"}`
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if params.ChainID != "c1" {
		t.Errorf("chainId: got %q, want %q", params.ChainID, "c1")
	}
	if params.ThoughtNumber != 3 {
		t.Errorf("thoughtNumber: got %d, want %d", params.ThoughtNumber, 3)
	}
	if params.RevisedText != "updated thought text" {
		t.Errorf("revisedThought: got %q, want %q", params.RevisedText, "updated thought text")
	}
}
