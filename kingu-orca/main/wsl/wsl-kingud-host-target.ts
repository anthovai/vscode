/**
 * The identity a WSL distro's kingud transport reports; `kind` is absent from `SshTarget`, which is
 * what tells the two apart. `id` and `distro` are the WSL deployment record's `environmentId` and
 * `distro`; `label` is the environment's name.
 */
export type WslKingudHostTarget = {
  kind: 'wsl'
  id: string
  distro: string
  label: string
}
