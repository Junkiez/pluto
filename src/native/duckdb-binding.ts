// Stands in for @duckdb/node-bindings (tsconfig paths, see scripts/gen-native.ts). duckdb.node finds its shared
// library via @loader_path / $ORIGIN, so both are extracted side by side.
import { loadNative } from "./native";
import { duckdb } from "./platform.gen";

export default loadNative("duckdb-" + duckdb.version, [[duckdb.libName, duckdb.lib], ["duckdb.node", duckdb.node]]); // node-api uses .default
