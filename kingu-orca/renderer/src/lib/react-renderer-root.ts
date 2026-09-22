import { createRoot, type Root } from 'react-dom/client'

type RendererRootHotData = {
  kinguRendererRoot?: Root
}

export function getOrCreateRendererRoot(
  container: HTMLElement,
  hotData?: RendererRootHotData
): Root {
  const existingRoot = hotData?.kinguRendererRoot
  if (existingRoot) {
    return existingRoot
  }
  const root = createRoot(container)
  if (hotData) {
    hotData.kinguRendererRoot = root
  }
  return root
}
