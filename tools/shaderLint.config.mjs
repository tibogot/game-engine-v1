// ============================================================================
// THE GUARD THAT WOULD HAVE CAUGHT THE BLACK ROAD.
//
// A one-line slip — a variable folded into another and its old name left
// referenced two lines down — shipped a `ReferenceError` into the road's bump
// shader. Every surface using that material rendered black, palette thumbnails
// included, and ELEVEN GREEN TEST TOOLS said nothing.
//
// WHY THE TESTS MISSED IT, because this is the part worth internalising: TSL
// `Fn` bodies are LAZY. `Fn(() => { ... })()` returns a call node and the
// JavaScript inside never runs until the shader is built for a real device. So
// every "the material builds" assertion constructed the object without once
// executing the function that contained the error. Node-side tests can check
// wiring — uniforms registered, gates recorded, look keys round-tripping, which
// material class three picks — but they CANNOT tell you the shader compiles.
// Only a GPU can do that, and until it does the bug is invisible.
//
// So the shader modules get a linter. `no-undef` is not a style rule here, it
// is the only cheap check that reads the inside of a lazy function body and
// catches the one failure mode that costs a whole session: a name that is not
// there. `no-unused-vars` is its other half — the leftover the rename left
// behind, which is how these pairs usually appear.
//
// Deliberately NOT a project-wide lint. It runs on the files whose bodies are
// deferred into shader compilation, where a normal test cannot reach.
//
// Run: node tools/shaderLint.mjs
// ============================================================================
import globals from "./shaderLintGlobals.mjs";

export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals,
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      // The black road.
      "no-undef": "error",
      // Its usual companion — the half of the rename that got left behind.
      "no-unused-vars": ["warn", {
        args: "none",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
      }],
      // Cheap correctness rules that also survive into a shader graph.
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
