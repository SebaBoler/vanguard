/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to '1' to point `pnpm dev` at a running `vanguard hub` instead of Tauri/mocks. */
  readonly VITE_VANGUARD_HUB?: string;
}
