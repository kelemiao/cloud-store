'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const windows = require('prismarine-windows')('1.21.11')
const ItemCatalog = require('../../src/itemCatalog')
const { canReuseCraftWindow, openServerContainer } = require('../../src/craft/server-container-evidence')

function evidenceFixture () {
  const container = { id: 5, selectedItem: null }
  const bot = { currentWindow: container, inventory: { selectedItem: null } }
  const snapshot = {
    chestSlots: [{ slot: 0, itemKey: 'minecraft:stone|plain', amount: 12 }],
    playerItems: [{ itemKey: 'minecraft:oak_planks|plain', amount: 4 }],
    cursorEmpty: true
  }
  return { container, bot, snapshot, serverSnapshot: snapshot, local: structuredClone(snapshot) }
}

test('craft window evidence can be reused only while revision, owner, cursor and contents stay unchanged', () => {
  const f = evidenceFixture()
  assert.equal(canReuseCraftWindow({
    expectedRevision: 7,
    currentRevision: 7,
    bot: f.bot,
    container: f.container,
    serverSnapshot: f.snapshot,
    localSnapshot: f.local
  }), true)

  for (const mutate of [
    value => { value.currentRevision = 8 },
    value => { value.bot.currentWindow = { id: 5 } },
    value => { value.container.selectedItem = { name: 'stone', count: 1 } },
    value => { value.bot.inventory.selectedItem = { name: 'stone', count: 1 } },
    value => { value.bot.inventory.slots = [null, { name: 'stone', count: 1 }] },
    value => { value.serverSnapshot.chestSlots[0].amount = 11 },
    value => { value.local.playerItems[0].amount = 3 },
    value => { value.serverSnapshot.cursorEmpty = false }
  ]) {
    const value = evidenceFixture()
    mutate(value)
    assert.equal(canReuseCraftWindow({
      expectedRevision: value.expectedRevision ?? 7,
      currentRevision: value.currentRevision ?? 7,
      bot: value.bot,
      container: value.container,
      serverSnapshot: value.serverSnapshot,
      localSnapshot: value.local
    }), false)
  }
})

async function retainedFixture (afterContent) {
  const catalog = new ItemCatalog('1.21.11')
  const Item = require('prismarine-item')(catalog.mcData)
  const container = windows.createWindow(5, 'minecraft:generic_9x3', 'Barrel')
  const bot = {
    registry: catalog.mcData,
    _client: new EventEmitter(),
    currentWindow: container,
    inventory: windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  }
  const content = { windowId: 5, stateId: 1, items: container.slots.map(Item.toNotch), carriedItem: Item.toNotch(null) }
  const warehouse = {
    openContainerAt: async () => {
      bot._client.emit('open_window', { windowId: 5 })
      bot._client.emit('window_items', content)
      afterContent?.(bot._client, content)
      return container
    },
    closeContainerQuietly: () => {}
  }
  const { evidence } = await openServerContainer(warehouse, { chestId: 'source' }, catalog, bot, { keepEvidence: true })
  return { bot, evidence, content, held: Item.toNotch(new Item(catalog.mcData.itemsByName.stone.id, 1)) }
}

for (const [label, name, packet] of [
  ['legacy cursor update', 'set_slot', f => ({ windowId: -1, slot: -1, item: f.held })],
  ['unsigned cursor update', 'set_slot', f => ({ windowId: 255, slot: -1, item: f.held })],
  ['container slot update', 'container_set_slot', f => ({ containerId: 5, slot: 0, item: f.held })],
  ['cursor update', 'set_cursor_item', f => ({ contents: f.held })],
  ['cursor update alias', 'container_set_cursor_item', f => ({ contents: f.held })],
  ['player inventory update', 'set_player_inventory', f => ({ slotId: 9, contents: f.held })],
  ['player slot update', 'set_slot', f => ({ windowId: 0, slot: 9, item: f.held })],
  ['player window content', 'window_items', f => ({ ...f.content, windowId: 0 })],
  ['undefined cursor', 'window_items', f => ({ ...f.content, carriedItem: undefined })],
  ['missing cursor', 'window_items', f => ({ windowId: 5, items: f.content.items })],
  ['incomplete content', 'window_items', f => ({ ...f.content, items: [] })]
]) {
  test(`retained evidence requires new full content after ${label}`, async () => {
    const f = await retainedFixture()
    try {
      assert.equal(f.evidence.isReusable(), true)
      f.bot._client.emit(name, packet(f))
      assert.equal(f.evidence.isReusable(), false)
    } finally {
      f.evidence.dispose()
      assert.equal(f.bot._client.eventNames().length, 0)
    }
  })
}

test('a fresh full owned-window snapshot restores evidence invalidated by a cursor packet', async () => {
  const f = await retainedFixture()
  try {
    f.bot._client.emit('set_cursor_item', { contents: f.held })
    assert.equal(f.evidence.isReusable(), false)
    f.bot._client.emit('window_items', { ...f.content, stateId: 3 })
    assert.equal(f.evidence.isReusable(), true)
  } finally { f.evidence.dispose() }
})

for (const [label, name, packet] of [
  ['cursor update', 'set_cursor_item', () => ({})],
  ['incomplete content', 'window_items', () => ({ windowId: 5, items: [] })],
  ['missing cursor', 'window_items', content => ({ windowId: 5, items: content.items })]
]) {
  test(`opening evidence cannot use a full snapshot superseded by ${label}`, async () => {
    await assert.rejects(retainedFixture((client, content) => client.emit(name, packet(content))))
  })
}
