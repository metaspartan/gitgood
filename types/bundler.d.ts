declare module "*.html" {
  const bundle: { readonly size: number };
  export default bundle;
}

declare module "*.css" {
  const file: Blob & { size: number };
  export default file;
}
