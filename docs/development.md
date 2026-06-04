# Development

This guide is for contributors wishing to extend the Neuralgentics runtime.

## 🛠️ Local Development Setup

### 1. Environment
We use a mixed-language stack. Ensure you have the following installed:
- **Go 1.22+**: For the Broker and Backend.
- **Python 3.12**: For the Memini-AI memory server.
- **Node.js 20+**: For the OpenCode plugin overlay.
- **PostgreSQL 16+**: With `pgvector` enabled.

### 2. Building the System
Use the provided `Makefile` for a consistent quality gate pipeline:
```bash
# Run all gates (Lint $\rightarrow$ Typecheck $\rightarrow$ Build $\rightarrow$ Test $\rightarrow$ Smoke)
make all
```

### 3. Running In Dev Mode
The easiest way to manage dependencies is via the dev-up script:
```bash
./scripts/dev-up.sh
```
This starts the PostgreSQL container and the Python memory server in the background.

---

## 🧪 Testing Strategy

Neuralgentics follows a "Gate-First" testing philosophy. No code is merged unless it passes the full suite.

### Go Modules
Each module is tested independently:
```bash
cd packages/broker-go && go test ./...
```

### Integration (Smoke Tests)
The `smoke-test-mvp.sh` script validates the end-to-end JSON-RPC flow:
`TUI $\rightarrow$ Broker $\rightarrow$ Backend $\rightarrow$ Memory $\rightarrow$ DB`.
Run it via:
```bash
make smoke
```

---

## ✍️ Contributing to Documentation

Documentation is a first-class citizen in this project. 

### The Docs Site
The site is powered by **mkdocs-material**. 
1. Add your `.md` file to the `docs/` directory.
2. Update the `nav` section in `mkdocs.yml` to include your new page.
3. Preview locally:
   ```bash
   make docs-serve
   ```
4. Build strictly to check for broken links:
   ```bash
   make docs-build
   ```

### Diagram Guidelines
All diagrams **must** be hand-crafted using Unicode box-drawing characters. **Do not use Mermaid**. Refer to the style guide in `docs/design/docs-site-architecture.md`.
