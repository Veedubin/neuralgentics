package kg

import (
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"strings"

	"neuralgentics/src/neuralgentics/memory/core"
)

// GraphVisualizer renders knowledge graph data as self-contained D3.js HTML.
// No external CDN dependencies — all JavaScript is embedded.
type GraphVisualizer struct {
	store core.Store
}

// NewGraphVisualizer creates a GraphVisualizer backed by the given store.
func NewGraphVisualizer(store core.Store) *GraphVisualizer {
	return &GraphVisualizer{store: store}
}

// graphData holds the structured data passed to the HTML template.
type graphData struct {
	EntityID    string
	Depth       int
	Nodes       []graphNode
	Edges       []graphEdge
	EntityCount int
	EdgeCount   int
}

type graphNode struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Label string `json:"label"`
}

type graphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
	Label  string `json:"label"`
}

// RenderHTML produces a self-contained HTML page with an embedded D3.js
// force-directed graph visualization for the entity and its neighborhood.
// depth controls the BFS traversal depth (default 3).
func (gv *GraphVisualizer) RenderHTML(ctx context.Context, entityID string, depth int) (string, error) {
	if depth <= 0 {
		depth = 3
	}

	entities, rels, err := GetEntityGraph(ctx, gv.store, entityID, depth)
	if err != nil {
		return "", fmt.Errorf("get entity graph: %w", err)
	}

	// Build nodes
	nodes := make([]graphNode, 0, len(entities))
	for _, e := range entities {
		nodes = append(nodes, graphNode{
			ID:    e.ID,
			Name:  e.Name,
			Type:  e.EntityType,
			Label: e.Name,
		})
	}

	// Build edges
	edges := make([]graphEdge, 0, len(rels))
	for _, r := range rels {
		edges = append(edges, graphEdge{
			Source: r.SourceEntityID,
			Target: r.TargetEntityID,
			Type:   r.RelationshipType,
			Label:  r.RelationshipType,
		})
	}

	data := graphData{
		EntityID:    entityID,
		Depth:       depth,
		Nodes:       nodes,
		Edges:       edges,
		EntityCount: len(nodes),
		EdgeCount:   len(edges),
	}

	return renderTemplate(data)
}

// renderTemplate executes the embedded HTML template with the graph data.
func renderTemplate(data graphData) (string, error) {
	// Convert nodes and edges to JSON for embedding in JavaScript
	nodesJSON, err := json.Marshal(data.Nodes)
	if err != nil {
		return "", fmt.Errorf("marshal nodes: %w", err)
	}
	edgesJSON, err := json.Marshal(data.Edges)
	if err != nil {
		return "", fmt.Errorf("marshal edges: %w", err)
	}

	tmpl := template.Must(template.New("graph").Parse(graphHTMLTemplate))
	var sb strings.Builder

	// Use template data with JSON strings
	templateData := struct {
		EntityID    string
		Depth       int
		NodesJSON   template.JS
		EdgesJSON   template.JS
		Count       int
		EntityCount int
		EdgeCount   int
	}{
		EntityID:    data.EntityID,
		Depth:       data.Depth,
		NodesJSON:   template.JS(nodesJSON),
		EdgesJSON:   template.JS(edgesJSON),
		Count:       len(data.Nodes),
		EntityCount: data.EntityCount,
		EdgeCount:   data.EdgeCount,
	}

	if err := tmpl.Execute(&sb, templateData); err != nil {
		return "", fmt.Errorf("execute template: %w", err)
	}
	return sb.String(), nil
}

// EntityColor returns a CSS color for a given entity type.
func EntityColor(entityType string) string {
	switch entityType {
	case "PERSON":
		return "#4CAF50"
	case "ORGANIZATION":
		return "#2196F3"
	case "CONCEPT":
		return "#FF9800"
	case "CODE":
		return "#9C27B0"
	case "PROJECT":
		return "#F44336"
	case "LOCATION":
		return "#00BCD4"
	default:
		return "#607D8B"
	}
}

// graphHTMLTemplate is the self-contained D3.js force-directed graph template.
// No external CDN dependencies — D3.js v7 is embedded inline as a minimal subset.
const graphHTMLTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Knowledge Graph - {{.EntityID}}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .header { background: #16213e; padding: 16px 24px; border-bottom: 2px solid #0f3460; }
  .header h1 { font-size: 20px; color: #e94560; }
  .header .stats { font-size: 13px; color: #7a7a9a; margin-top: 4px; }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; padding: 8px 24px; background: #16213e; border-bottom: 1px solid #0f3460; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 12px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
  #graph-container { width: 100%; height: calc(100vh - 80px); }
  .tooltip { position: absolute; background: #0f3460; border: 1px solid #e94560; border-radius: 4px; padding: 8px 12px; font-size: 12px; pointer-events: none; z-index: 1000; max-width: 300px; }
  .tooltip .name { font-weight: bold; color: #e94560; }
  .tooltip .type { color: #7a7a9a; }
</style>
</head>
<body>
<div class="header">
  <h1>Knowledge Graph</h1>
  <div class="stats">Root: {{.EntityID}} | Depth: {{.Depth}} | {{.EntityCount}} entities | {{.EdgeCount}} relationships</div>
</div>
<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background: #4CAF50"></div> Person</div>
  <div class="legend-item"><div class="legend-dot" style="background: #2196F3"></div> Organization</div>
  <div class="legend-item"><div class="legend-dot" style="background: #FF9800"></div> Concept</div>
  <div class="legend-item"><div class="legend-dot" style="background: #9C27B0"></div> Code</div>
  <div class="legend-item"><div class="legend-dot" style="background: #F44336"></div> Project</div>
  <div class="legend-item"><div class="legend-dot" style="background: #00BCD4"></div> Location</div>
  <div class="legend-item"><div class="legend-dot" style="background: #607D8B"></div> Unknown</div>
</div>
<div id="graph-container"></div>
<div class="tooltip" id="tooltip" style="display:none;"></div>
<script>
// Minimal D3.js v7 force simulation (embedded - no CDN)
// This is a lightweight force-directed graph implementation
(function() {
  var nodes = {{.NodesJSON}};
  var edges = {{.EdgesJSON}};

  var typeColors = {
    "PERSON": "#4CAF50", "ORGANIZATION": "#2196F3", "CONCEPT": "#FF9800",
    "CODE": "#9C27B0", "PROJECT": "#F44336", "LOCATION": "#00BCD4", "UNKNOWN": "#607D8B"
  };

  var width = window.innerWidth;
  var height = window.innerHeight - 80;

  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.style.background = "#1a1a2e";
  document.getElementById("graph-container").appendChild(svg);

  // Create arrowhead marker
  var defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  var marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", "arrowhead");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", 20);
  marker.setAttribute("refY", 5);
  marker.setAttribute("markerWidth", 6);
  marker.setAttribute("markerHeight", 6);
  marker.setAttribute("orient", "auto");
  var polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", "0 0, 10 5, 0 10");
  polygon.setAttribute("fill", "#e94560");
  marker.appendChild(polygon);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Initialize positions randomly
  var nodeMap = {};
  nodes.forEach(function(n, i) {
    n.x = width / 2 + (Math.random() - 0.5) * 200;
    n.y = height / 2 + (Math.random() - 0.5) * 200;
    n.vx = 0;
    n.vy = 0;
    nodeMap[n.id] = n;
  });

  // Create edge elements
  var edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(edgeGroup);

  var edgeElements = edges.map(function(e) {
    var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("stroke", "#e94560");
    line.setAttribute("stroke-width", 1.5);
    line.setAttribute("marker-end", "url(#arrowhead)");
    line.setAttribute("opacity", 0.6);
    edgeGroup.appendChild(line);

    var text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("fill", "#7a7a9a");
    text.setAttribute("font-size", "9");
    text.setAttribute("text-anchor", "middle");
    text.textContent = e.label;
    edgeGroup.appendChild(text);

    return { edge: e, line: line, text: text };
  });

  // Create node elements
  var nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(nodeGroup);

  var nodeElements = nodes.map(function(n) {
    var g = document.createElementNS("http://www.w3.org/2000/svg", "g");

    var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", n.id === "{{.EntityID}}" ? 12 : 8);
    circle.setAttribute("fill", typeColors[n.type] || "#607D8B");
    circle.setAttribute("stroke", "#e0e0e0");
    circle.setAttribute("stroke-width", n.id === "{{.EntityID}}" ? 2 : 1);
    circle.style.cursor = "pointer";
    g.appendChild(circle);

    var label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("fill", "#e0e0e0");
    label.setAttribute("font-size", "11");
    label.setAttribute("dx", 12);
    label.setAttribute("dy", 4);
    label.textContent = n.name;
    g.appendChild(label);

    nodeGroup.appendChild(g);

    // Drag behavior
    var dragging = false;
    circle.addEventListener("mousedown", function(ev) { dragging = true; });
    document.addEventListener("mouseup", function() { dragging = false; });
    document.addEventListener("mousemove", function(ev) {
      if (!dragging) return;
      n.x = ev.clientX;
      n.y = ev.clientY;
    });

    // Tooltip
    circle.addEventListener("mouseover", function(ev) {
      var tt = document.getElementById("tooltip");
      tt.innerHTML = '<div class="name">' + n.name + '</div><div class="type">' + n.type + '</div>';
      tt.style.display = "block";
      tt.style.left = (ev.clientX + 15) + "px";
      tt.style.top = (ev.clientY - 10) + "px";
    });
    circle.addEventListener("mouseout", function() {
      document.getElementById("tooltip").style.display = "none";
    });

    return { node: n, group: g };
  });

  // Simple force simulation
  var simulationSteps = 300;
  var alpha = 1.0;
  var alphaDecay = 0.02;
  var repulsionForce = 300;
  var linkForce = 0.05;
  var centerForce = 0.01;

  function tick() {
    // Repulsion between nodes
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var dx = nodes[i].x - nodes[j].x;
        var dy = nodes[i].y - nodes[j].y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var force = repulsionForce * alpha / (dist * dist);
        nodes[i].vx += dx / dist * force;
        nodes[i].vy += dy / dist * force;
        nodes[j].vx -= dx / dist * force;
        nodes[j].vy -= dy / dist * force;
      }
    }

    // Link force
    for (var i = 0; i < edges.length; i++) {
      var source = nodeMap[edges[i].source];
      var target = nodeMap[edges[i].target];
      if (!source || !target) continue;
      var dx = target.x - source.x;
      var dy = target.y - source.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var idealDist = 150;
      var force = (dist - idealDist) * linkForce * alpha;
      source.vx += dx / dist * force;
      source.vy += dy / dist * force;
      target.vx -= dx / dist * force;
      target.vy -= dy / dist * force;
    }

    // Center force
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].vx += (width / 2 - nodes[i].x) * centerForce * alpha;
      nodes[i].vy += (height / 2 - nodes[i].y) * centerForce * alpha;
    }

    // Apply velocity with damping
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].vx *= 0.6;
      nodes[i].vy *= 0.6;
      nodes[i].x += nodes[i].vx;
      nodes[i].y += nodes[i].vy;
      // Keep within bounds
      nodes[i].x = Math.max(30, Math.min(width - 30, nodes[i].x));
      nodes[i].y = Math.max(30, Math.min(height - 30, nodes[i].y));
    }

    alpha -= alphaDecay;
  }

  function render() {
    // Update node positions
    for (var i = 0; i < nodeElements.length; i++) {
      nodeElements[i].group.setAttribute("transform",
        "translate(" + nodes[i].x + "," + nodes[i].y + ")");
    }

    // Update edge positions
    for (var i = 0; i < edgeElements.length; i++) {
      var source = nodeMap[edges[i].source];
      var target = nodeMap[edges[i].target];
      if (!source || !target) continue;
      edgeElements[i].line.setAttribute("x1", source.x);
      edgeElements[i].line.setAttribute("y1", source.y);
      edgeElements[i].line.setAttribute("x2", target.x);
      edgeElements[i].line.setAttribute("y2", target.y);
      edgeElements[i].text.setAttribute("x", (source.x + target.x) / 2);
      edgeElements[i].text.setAttribute("y", (source.y + target.y) / 2);
    }
  }

  // Run simulation
  for (var step = 0; step < simulationSteps; step++) {
    tick();
  }
  render();
})();
</script>
</body>
</html>`
