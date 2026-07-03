/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PODIUM_DEBUG_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
