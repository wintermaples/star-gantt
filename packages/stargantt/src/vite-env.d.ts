// The default stylesheet is inlined into the JS as a string at build time. Vite serves `?inline`
// CSS imports as a default-exported string; `tsc` needs this declaration to type the same import
// when it emits the `.d.ts` files.
declare module "*.css?inline" {
  const css: string;
  export default css;
}
