'use strict'

const { serialize, deserialize } = require('node:v8')

function sameSnapshotSlots (left = [], right = []) {
  const normalize = values => values
    .map(value => [Number(value.slot), String(value.itemKey), Number(value.amount)])
    .sort((a, b) => a[0] - b[0])
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function sameSnapshotItems (left = [], right = []) {
  const normalize = values => values
    .map(value => [String(value.itemKey), Number(value.amount)])
    .sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

// A craft batch may reuse an already opened barrel only when all evidence still
// describes the same server-owned state. Mineflayer mirrors the open window's
// player slots to bot.inventory only on close, so its unchanged opening view is
// also valid while the window itself matches the latest full server snapshot.
function canReuseCraftWindow ({ expectedRevision, currentRevision, bot, container, serverSnapshot, localSnapshot, initialBotPlayerItems }) {
  if (expectedRevision !== currentRevision || !bot || bot.currentWindow !== container) return false
  if (!container || container.selectedItem || bot.inventory?.selectedItem) return false
  if (bot.inventory?.slots?.slice(0, 5).some(Boolean)) return false
  if (!serverSnapshot || serverSnapshot.cursorEmpty !== true || !localSnapshot) return false
  if (!sameSnapshotSlots(serverSnapshot.chestSlots, localSnapshot.chestSlots) ||
      !sameSnapshotItems(serverSnapshot.playerItems, localSnapshot.playerItems)) return false
  if (localSnapshot.botPlayerItems && !sameSnapshotItems(serverSnapshot.playerItems, localSnapshot.botPlayerItems) &&
      (!initialBotPlayerItems || !sameSnapshotItems(initialBotPlayerItems, localSnapshot.botPlayerItems))) return false
  return true
}

function currentRevision (warehouse, chestId) {
  return warehouse?.warehouseState?.chestRevisions?.get(String(chestId)) || 0
}

function containerSnapshot (container, catalog, bot) {
  const start = Number(container?.inventoryStart)
  const end = Number(container?.inventoryEnd)
  if (!Array.isArray(container?.slots) || !Number.isInteger(start) || !Number.isInteger(end)) return null
  const chestSlots = []
  for (let slot = 0; slot < start; slot++) {
    const item = container.slots[slot]
    if (!item) continue
    const normalized = catalog.fromPrismarineItem(item)
    chestSlots.push({ ...normalized, slot, amount: item.count })
  }
  const playerItems = catalog.aggregatePrismarineItems(container.slots.slice(start, end).filter(Boolean))
  return {
    chestSlots,
    playerItems,
    botPlayerItems: typeof bot?.inventory?.items === 'function'
      ? catalog.aggregatePrismarineItems(bot.inventory.items())
      : null,
    cursorEmpty: !container.selectedItem && !bot?.inventory?.selectedItem
  }
}

async function openServerContainer (warehouse, chest, catalog, bot, options = {}) {
  const client = bot._client
  if (typeof client?.on !== 'function' || typeof client?.removeListener !== 'function') {
    throw new Error('缺少服务端容器快照观察。')
  }
  const Item = require('prismarine-item')(bot.registry || catalog.mcData)
  const opened = new Set()
  const packets = []
  const revision = currentRevision(warehouse, chest.chestId)
  const keepEvidence = options.keepEvidence === true
  let latest = null
  let decodeError = null
  let disposed = false
  const windowId = packet => packet?.windowId ?? packet?.containerId
  let inventoryStart = null
  let inventoryEnd = null
  const decodePacket = packet => {
    if (!Array.isArray(packet?.items) || !Number.isInteger(inventoryStart) || !Number.isInteger(inventoryEnd) ||
      packet.items.length !== inventoryEnd || !Object.hasOwn(packet, 'carriedItem')) return null
    const carried = Item.fromNotch(packet.carriedItem)
    const chestSlots = packet.items.slice(0, inventoryStart).map((value, slot) => {
      const item = Item.fromNotch(value)
      return item ? { ...catalog.fromPrismarineItem(item), slot, amount: item.count } : null
    }).filter(Boolean)
    const player = packet.items.slice(inventoryStart, inventoryEnd).map(value => Item.fromNotch(value)).filter(Boolean)
    return {
      chestSlots,
      playerItems: catalog.aggregatePrismarineItems(player),
      cursorEmpty: !carried,
      stateId: packet.stateId
    }
  }
  const onOpen = packet => {
    opened.clear()
    packets.length = 0
    latest = null
    decodeError = null
    if (Number.isInteger(windowId(packet))) opened.add(windowId(packet))
  }
  const invalidate = () => {
    latest = null
    packets.length = 0
  }
  const onItems = packet => {
    if (keepEvidence && windowId(packet) === 0) invalidate()
    if (!opened.has(windowId(packet))) return
    if (keepEvidence) invalidate()
    const items = packet?.items ?? packet?.slots
    if (Array.isArray(items)) {
      const copy = deserialize(serialize({ ...packet, windowId: windowId(packet), items }))
      packets.push(copy)
      try {
        const decoded = decodePacket(copy)
        if (decoded) latest = decoded
      } catch (error) {
        decodeError = error
      }
    }
  }
  const onSlot = packet => {
    const id = windowId(packet)
    if (opened.has(id) || [0, -1, 255, -2, 254].includes(id)) invalidate()
  }
  const listeners = [
    ['open_window', onOpen], ['open_screen', onOpen],
    ['window_items', onItems], ['container_set_content', onItems]
  ]
  if (keepEvidence) listeners.push(
    ['set_slot', onSlot], ['container_set_slot', onSlot],
    ['set_cursor_item', invalidate], ['container_set_cursor_item', invalidate],
    ['set_player_inventory', invalidate]
  )
  for (const [event, listener] of listeners) client.on(event, listener)
  let container
  let handedOff = false
  try {
    container = await warehouse.openContainerAt(chest)
    const start = container?.inventoryStart
    const end = container?.inventoryEnd
    inventoryStart = start
    inventoryEnd = end
    const packet = packets.findLast(value => value.windowId === container?.id && value.items.length === end)
    if (!Number.isInteger(start) || !Number.isInteger(end) || end - start !== 36 || !packet || bot.currentWindow !== container) {
      throw new Error('没有收到当前容器完整的服务端快照。')
    }
    if (!Object.hasOwn(packet, 'carriedItem')) throw new Error('服务端容器快照缺少光标状态。')
    let chestSlots
    let playerItems
    try {
      const decoded = decodePacket(packet)
      if (!decoded) throw new Error('服务端容器快照结构不完整。')
      if (!decoded.cursorEmpty) throw new Error('服务端光标仍持有物品。')
      latest = decoded
      chestSlots = decoded.chestSlots
      playerItems = decoded.playerItems
    } catch (error) {
      throw new Error(`无法解码服务端容器快照：${error.message}`)
    }
    if (decodeError) throw new Error(`无法持续解码服务端容器快照：${decodeError.message}`)
    const initialBotPlayerItems = keepEvidence ? containerSnapshot(container, catalog, bot)?.botPlayerItems : null
    const evidence = {
      revision,
      windowId: container.id,
      current: () => latest,
      isReusable: () => !disposed && canReuseCraftWindow({
        expectedRevision: revision,
        currentRevision: currentRevision(warehouse, chest.chestId),
        bot,
        container,
        serverSnapshot: decodeError ? null : latest,
        localSnapshot: containerSnapshot(container, catalog, bot),
        initialBotPlayerItems
      }),
      dispose: () => {
        if (disposed) return
        disposed = true
        for (const [event, listener] of listeners) client.removeListener(event, listener)
      }
    }
    if (!keepEvidence) {
      evidence.dispose()
      return { container, chestSlots, playerItems, evidence: null }
    }
    handedOff = true
    return { container, chestSlots, playerItems, evidence }
  } catch (error) {
    if (container) warehouse.closeContainerQuietly(container)
    throw error
  } finally {
    if (!handedOff) {
      for (const [event, listener] of listeners) client.removeListener(event, listener)
    }
  }
}

async function readServerContainer (warehouse, chest, catalog, bot) {
  const snapshot = await openServerContainer(warehouse, chest, catalog, bot)
  try {
    warehouse.closeContainerQuietly(snapshot.container)
  } finally {
    snapshot.evidence?.dispose()
  }
  return snapshot
}

module.exports = {
  canReuseCraftWindow,
  snapshotCraftWindow: containerSnapshot,
  openServerContainer,
  readServerContainer
}
