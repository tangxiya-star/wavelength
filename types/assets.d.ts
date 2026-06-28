// Let TypeScript resolve bundled media imports (Metro returns an asset id number).
declare module '*.mp4' {
  const source: number;
  export default source;
}
