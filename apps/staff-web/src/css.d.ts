// Side-effect CSS imports (main.tsx: design tokens, BC Sans, our own global.css) have no
// runtime value — esbuild handles them at build time — but still need a module declaration so
// `tsc` can resolve the specifier.
declare module "*.css";
