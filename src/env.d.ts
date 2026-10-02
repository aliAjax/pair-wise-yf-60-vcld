/// <reference types="vite/client" />

// 本地垫片：vinxi@0.5.11 发布包缺少 dist/types（tsconfig 中原 types: ["vinxi/client"] 解析失败）。
// 这里补齐等价的全局声明，内容与 vinxi/types/client.d.ts 保持一致。
type VinxiManifest = { readonly [key: string]: unknown };

declare interface Window {
  MANIFEST: VinxiManifest;
  manifest: any;
}

interface ImportMetaEnv {
  readonly MANIFEST: VinxiManifest;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
