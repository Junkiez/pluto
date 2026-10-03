<p align="center"><img src="assets/logo.png" width="96" alt=""></p>

# Pluto

A notebook in a single binary: TypeScript/JavaScript, Postgres, SQLite, DuckDB and Polars cells, a Vue UI with a
CodeMirror editor (TypeScript completions), and an MCP endpoint for agents.

## Run

Download a binary from [Releases](../../releases), or build one (below), then:

```bash
./pluto --file example/getting-started.json
```

Open http://localhost:9999.

| Flag | |
|---|---|
| `--file <path>` | notebook to open (default `notebook.json`); notebooks next to it show up in the picker |
| `--pass <password>` | require a password (browser prompt, `?password=` link, or `Authorization: Bearer` for MCP). `PLUTO_PASS` env works too |
| `--unsafe` | give cells the real filesystem; without it, `fs`, DuckDB and SQLite are confined to `<notebook>.files/` |
| `--allow-import=host,…` | hosts JS cells may import from (default esm.sh, cdn.jsdelivr.net, unpkg.com, jsr.io); bare `--allow-import` allows any |
| `PORT` env | port (default 9999) |

Per notebook, data lives next to the file: `<name>.pgdata` (Postgres), `<name>.sqlite`, `<name>.duckdb`, `<name>.files/`.

## Cells

- **TypeScript / JavaScript** — one shared kernel (edge-runtime). Top-level `await`, URL/esm.sh imports, HTML output.
  Globals: `sql` (Postgres), `duck` (DuckDB), `pl` (Polars), `fs`.
- **Postgres** (PGlite), **SQLite** (bun:sqlite), **DuckDB** — results render as tables.
- **Polars** — SQL over the DataFrames defined in JS cells, by variable name.

## MCP

`http://localhost:9999/mcp` (Streamable HTTP). Tools: `run_code`, `get_notebook`, `add_cell`, `update_cell`,
`delete_cell`, `list_notebooks`, `open_notebook`.

```bash
claude mcp add --transport http pluto http://localhost:9999/mcp --header "Authorization: Bearer <password>"
```

## Build

```bash
npm ci
npm run build   # -> example/pluto
```

Builds for the platform you're on (DuckDB and Polars are native). CI builds darwin-arm64, darwin-x64, linux-x64 and
linux-arm64 and publishes a release on every push to `main` (`.github/workflows/release.yml`).

```
src/server.ts          server, kernels, MCP
src/web/               UI: index.html (Vue), editor.ts (CodeMirror + Shiki), ts-worker.ts (TypeScript service)
src/native/            loaders for the embedded DuckDB / Polars native libraries
scripts/               build steps: gen-types (TS libs for the editor), gen-native (per-platform native paths)
example/               sample notebooks (+ the built binary)
```
