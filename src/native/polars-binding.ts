// Stands in for nodejs-polars' platform package (tsconfig paths, see scripts/gen-native.ts).
import { loadNative } from "./native";
import { polarsNative } from "./platform.gen";

module.exports = loadNative("polars-" + polarsNative.version, [["polars.node", polarsNative.node]]);
