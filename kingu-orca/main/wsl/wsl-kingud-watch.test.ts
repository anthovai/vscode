import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openKingudStdioBridgeChannel } from '../ssh/kingud-stdio-bridge'
import { fakeWslBridgeChildren, posixKingudStdioBridge } from './wsl-kingud-bridge-test-child'
import { createWslKingudHostTransport } from './wsl-kingud-host-transport'
import { watchChannel } from './wsl-kingud-watch'

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close()
  }
})

async function kingudLike(): Promise<{ port: number; sockets: Socket[] }> {
  const sockets: Socket[] = []
  const server = createServer((socket) => sockets.push(socket))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { port: typeof address === 'object' && address ? address.port : 0, sockets }
}

async function openWatch(port: number) {
  const children = fakeWslBridgeChildren()
  const transport = createWslKingudHostTransport({
    target: { kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' },
    spawn: children.spawn
  })
  const channel = await openKingudStdioBridgeChannel(transport, posixKingudStdioBridge(port))
  return { watch: await watchChannel(channel, 5_000), children }
}

describe('watchChannel', () => {
  it('holds a ready bridge and reports its exit code when kingud closes it', async () => {
    const kingud = await kingudLike()
    const { watch } = await openWatch(kingud.port)
    expect(watch.signal).toBe('ready')
    const exited = new Promise<number | null>((resolve) => watch.onExit(resolve))
    await new Promise((resolve) => setTimeout(resolve, 20))
    kingud.sockets[0].destroy()
    expect(await exited).toBe(0)
  })

  it('reads a refused port as refused and holds nothing', async () => {
    const kingud = await kingudLike()
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()))
    const { watch, children } = await openWatch(kingud.port)
    expect(watch.signal).toBe('refused')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(children.live()).toBe(0)
  })

  it('never reports an exit it caused itself', async () => {
    const kingud = await kingudLike()
    const { watch, children } = await openWatch(kingud.port)
    let reported = false
    watch.onExit(() => {
      reported = true
    })
    watch.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(children.live()).toBe(0)
    expect(reported).toBe(false)
  })
})
