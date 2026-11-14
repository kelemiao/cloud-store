'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const windows = require('prismarine-windows')('1.21.11')
const injectInventory = require('mineflayer/lib/plugins/inventory')
const Warehouse = require('../../src/warehouse')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../../src/config')

function fixture ({ mutateRevision = false, sendContent = true, rejectTransfer = false, dirtyCraftSlot = false } = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.version = '1.21.11'
  config.timing.containerSettleMs = 0
  config.timing.containerClickIntervalMs = 0
  const catalog = new ItemCatalog('1.21.11')
  const Item = require('prismarine-item')(catalog.mcData)
  const stoneRow = catalog.fromItemIdAmount('minecraft:stone', 12)
  const db = new StoreDb(':memory:', config)
  const chest = { chestId: 'source', x: 0, y: 64, z: 0, blockName: 'barrel' }
  db.upsertChest(chest)
  db.replaceChestSlots(chest.chestId, [{ ...stoneRow, slot: 0 }])
  const server = windows.createWindow(5, 'minecraft:generic_9x3', 'Barrel')
  server.updateSlot(0, new Item(catalog.mcData.itemsByName.stone.id, 12))
  const bot = Object.assign(new EventEmitter(), {
    username: 'craft-bot',
    version: '1.21.11',
    registry: catalog.mcData,
    supportFeature: name => catalog.mcData.supportFeature(name),
    _client: new EventEmitter(),
    entity: { position: { x: 0, y: 64, z: 0 } }
  })
  const emitContent = () => bot._client.emit('window_items', {
    windowId: server.id,
    stateId: 1,
    items: server.slots.map(Item.toNotch),
    carriedItem: Item.toNotch(server.selectedItem)
  })
  bot._client.write = (name, packet) => {
    if (name === 'close_window') return
    assert.equal(name, 'window_click')
    if (!rejectTransfer) server.acceptClick({ ...packet, item: server.slots[packet.slot] })
    if (sendContent) emitContent()
    if (mutateRevision) warehouse.warehouseState.chestRevisions.set('source', 99)
    if (dirtyCraftSlot && !server.selectedItem) {
      bot._client.emit('set_slot', { windowId: 0, slot: 1, item: Item.toNotch(new Item(catalog.mcData.itemsByName.stone.id, 1)) })
    }
  }
  injectInventory(bot, { hideErrors: false })
  const warehouse = new Warehouse(bot, db, catalog, config)
  const listenerCounts = () => Object.fromEntries(bot._client.eventNames().map(name => [name, bot._client.listenerCount(name)]))
  const initialListeners = listenerCounts()
  let openCalls = 0
  warehouse.openContainerAt = async () => {
    openCalls++
    bot._client.emit('open_window', { windowId: server.id, inventoryType: server.type, windowTitle: 'Barrel' })
    emitContent()
    return bot.currentWindow
  }
  return {
    warehouse, bot, db, server, catalog, stoneKey: stoneRow.itemKey,
    initialListeners, listenerCounts,
    get openCalls () { return openCalls }
  }
}

async function runBatch (options, verify) {
  const f = fixture(options)
  try {
    const result = await f.warehouse.withdrawCraftBatchAllocationsLocked([{
      itemKey: f.stoneKey,
      amount: 4,
      displayName: '石头'
    }], { requireServerEvidence: true })
    assert.deepEqual(result.withdrawn.map(value => [value.itemId, value.amount]), [['minecraft:stone', 4]])
    assert.deepEqual(f.bot.inventory.items().map(value => [value.name, value.count]), [['stone', 4]])
    assert.equal(f.db.listChestSlots().find(row => row.slot === 0).amount, 8)
    assert.equal(f.bot.currentWindow, null)
    assert.deepEqual(f.listenerCounts(), f.initialListeners)
    verify(f)
  } finally { f.db.close() }
}

test('craft batch reuses confirmed content with real clicks and inventory mirrored only on close', async () => {
  await runBatch({}, f => assert.equal(f.openCalls, 1))
})
test('craft batch reopens a barrel when its revision changes during transfer', async () => {
  await runBatch({ mutateRevision: true }, f => assert.equal(f.openCalls, 2))
})

test('craft batch confirms a transfer by reopening when clicks receive no full content', async () => {
  await runBatch({ sendContent: false }, f => assert.equal(f.openCalls, 2))
})

test('craft batch reuses one confirmed barrel for different materials', async () => {
  const f = fixture()
  try {
    const Item = require('prismarine-item')(f.catalog.mcData)
    const iron = new Item(f.catalog.mcData.itemsByName.iron_ingot.id, 4)
    const ironRow = f.catalog.fromPrismarineItem(iron)
    f.server.updateSlot(1, iron)
    f.db.replaceChestSlots('source', [
      { ...f.catalog.fromItemIdAmount('minecraft:stone', 12), slot: 0 },
      { ...ironRow, slot: 1, amount: 4 }
    ])
    const result = await f.warehouse.withdrawCraftBatchAllocationsLocked([
      { itemKey: f.stoneKey, amount: 4 }, { itemKey: ironRow.itemKey, amount: 2 }
    ], { requireServerEvidence: true })
    assert.deepEqual(result.withdrawn.map(value => [value.itemId, value.amount]).sort(), [['minecraft:iron_ingot', 2], ['minecraft:stone', 4]])
    assert.deepEqual(f.bot.inventory.items().map(value => [value.name, value.count]).sort(), [['iron_ingot', 2], ['stone', 4]])
    assert.equal(f.openCalls, 1)
    assert.deepEqual(f.db.listChestSlots().map(row => [row.slot, row.amount]), [[0, 8], [1, 2]])
    assert.deepEqual(f.listenerCounts(), f.initialListeners)
  } finally { f.db.close() }
})

test('craft batch refuses client-predicted transfers rejected by the reopened server snapshot', async () => {
  const f = fixture({ sendContent: false, rejectTransfer: true })
  try {
    await assert.rejects(f.warehouse.withdrawCraftBatchAllocationsLocked([
      { itemKey: f.stoneKey, amount: 4 }
    ], { requireServerEvidence: true }), error => error.uncertainTransfer === true)
    assert.equal(f.openCalls, 2)
    assert.deepEqual(f.bot.inventory.items(), [])
    assert.equal(f.db.listChestSlots().find(row => row.slot === 0).amount, 12)
    assert.equal(f.bot.currentWindow, null)
    assert.deepEqual(f.listenerCounts(), f.initialListeners)
  } finally { f.db.close() }
})

test('craft batch refuses to finish when the player crafting grid becomes occupied', async () => {
  const f = fixture({ dirtyCraftSlot: true })
  try {
    await assert.rejects(f.warehouse.withdrawCraftBatchAllocationsLocked([
      { itemKey: f.stoneKey, amount: 4 }
    ], { requireServerEvidence: true }), error => error.uncertainTransfer === true)
    assert.equal(f.bot.currentWindow, null)
    assert.deepEqual(f.listenerCounts(), f.initialListeners)
  } finally { f.db.close() }
})
