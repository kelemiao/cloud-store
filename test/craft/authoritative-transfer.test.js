'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const Warehouse = require('../../src/warehouse')
const CraftLedger = require('../../src/craft/ledger')
const { CraftController } = require('../../src/craft/controller')
const { DEFAULT_CONFIG } = require('../../src/config')

function fixture (options = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.timing.containerSettleMs = 0
  config.debug = false
  const catalog = new ItemCatalog(config.server.version, {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const Item = require('prismarine-item')(catalog.mcData)
  const windows = require('prismarine-windows')(config.server.version)
  const make = (count) => new Item(catalog.mcData.itemsByName.stick.id, count)
  const db = new StoreDb(':memory:', config)
  const chest = { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' }
  db.upsertChest(chest)
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  if (!options.withdraw) bot.inventory.updateSlot(9, make(4))
  bot.username = 'CraftBot'
  const server = options.withdraw ? { chest: make(4), player: null } : { chest: null, player: make(4) }
  let packetMode = options.packetMode
  if (options.withdraw) db.replaceChestSlots(chest.chestId, [{ ...catalog.fromPrismarineItem(server.chest), slot: 0, amount: 4 }])
  let opens = 0
  let withdrawals = 0
  let current
  bot.clickWindow = async (slot, mouseButton, mode) => {
    current.acceptClick({ slot, mouseButton, mode, item: current.slots[slot] })
    if (options.accepted !== false) {
      server.chest = make(4)
      server.player = null
    }
  }
  const warehouse = new Warehouse(bot, db, catalog, config)
  if (options.withdraw) warehouse.tryWithdrawExactFrom = async container => {
    withdrawals++
    if (options.uncertain) {
      const error = new Error('uncertain withdraw')
      error.uncertainTransfer = true
      throw error
    }
    container.updateSlot(0, null)
    container.updateSlot(container.inventoryStart, make(4))
    if (options.accepted !== false) {
      server.chest = null
      server.player = make(4)
    }
    return 4
  }
  warehouse.openContainerAt = async () => {
    opens++
    current = windows.createWindow(7 + opens, 'minecraft:generic_9x3', 'Barrel')
    current.updateSlot(0, server.chest)
    current.updateSlot(current.inventoryStart, server.player)
    bot.currentWindow = current
    current.close = () => {
      for (let slot = current.inventoryStart; slot < current.inventoryEnd; slot++) {
        bot.inventory.updateSlot(slot - current.inventoryStart + 9, current.slots[slot])
      }
      bot.currentWindow = null
    }
    const items = current.slots.map(item => Item.toNotch(item))
    const packet = { windowId: current.id, items, carriedItem: Item.toNotch(options.carried && opens > 1 ? make(1) : null) }
    if (options.omitCursor && opens > 1) delete packet.carriedItem
    if (options.noFirstPacket && opens === 1) {
      bot._client.emit('open_window', { windowId: current.id })
    } else if (opens === 1 || packetMode === 'valid' || !packetMode) {
      bot._client.emit(opens > 1 && options.alias ? 'open_screen' : 'open_window', { windowId: current.id })
      bot._client.emit(opens > 1 && options.alias ? 'container_set_content' : 'window_items', packet)
    } else if (packetMode === 'wrong') {
      bot._client.emit('open_window', { windowId: current.id })
      bot._client.emit('window_items', { ...packet, windowId: current.id + 1 })
    } else if (packetMode === 'stale') {
      bot._client.emit('window_items', packet)
      bot._client.emit('open_window', { windowId: current.id })
    } else if (packetMode === 'reused') {
      bot._client.emit('open_window', { windowId: current.id })
      bot._client.emit('window_items', packet)
      bot._client.emit('open_window', { windowId: current.id })
    } else if (packetMode === 'missing') {
      bot._client.emit('open_window', { windowId: current.id })
    }
    return current
  }
  return { db, bot, warehouse, catalog, config, chest, server, opens: () => opens,
    withdrawals: () => withdrawals, setPacketMode: value => { packetMode = value }, close: () => db.close() }
}

function storingOperation (f) {
  const held = f.catalog.aggregatePrismarineItems(f.bot.inventory.items())
  const ledger = new CraftLedger(f.db)
  const operation = ledger.begin({ id: 'craft:strict-deposit', botId: 'bot-a', owner: { uuid: 'alice' },
    allocations: [], data: { held, pending: null, physicalTotals: held, stepIndex: 0 } })
  const controller = new CraftController({ ...f, ledger, executor: { isBusy: () => false }, botId: 'bot-a' })
  return { controller, operation, ledger }
}

test('strict deposit confirms a fresh server container and player snapshot', async () => {
  const f = fixture()
  try {
    await f.warehouse.depositAllPossible({ requireServerEvidence: true })
    assert.equal(f.opens(), 2)
    assert.deepEqual(f.bot.inventory.items(), [])
    assert.equal(f.db.listChestSlots().find(row => row.slot === 0)?.amount, 4)
  } finally { f.close() }
})

for (const packetMode of ['missing', 'wrong', 'stale', 'reused']) {
  test(`strict deposit retains uncertainty after ${packetMode} server packet`, async () => {
    const f = fixture({ packetMode })
    try {
      await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /服务端|server|快照/)
      assert.equal(f.opens(), 2)
      assert.equal(f.bot._client.listenerCount('window_items'), 0)
      assert.equal(f.bot._client.listenerCount('open_window'), 0)
    } finally { f.close() }
  })
}

test('strict deposit rejects a server transfer refusal', async () => {
  const f = fixture({ accepted: false })
  try {
    await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /服务端|server|快照/)
    assert.equal(f.bot.inventory.items()[0].count, 4)
  } finally { f.close() }
})

test('strict deposit rejects a nonempty server cursor', async () => {
  const f = fixture({ carried: true })
  try {
    await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /光标|cursor/)
  } finally { f.close() }
})

test('strict deposit fails closed when the protocol snapshot omits cursor evidence', async () => {
  const f = fixture({ omitCursor: true })
  try {
    await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /光标|cursor/)
  } finally { f.close() }
})

test('strict deposit verifies a predicted transfer even when the helper reports zero progress', async () => {
  const f = fixture({ packetMode: 'missing' })
  try {
    const deposit = f.warehouse.tryDepositInto.bind(f.warehouse)
    f.warehouse.tryDepositInto = async (...args) => { await deposit(...args); return 0 }
    await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /服务端|server|快照/)
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('strict deposit accepts equivalent container packet event names', async () => {
  const f = fixture({ alias: true })
  try {
    await f.warehouse.depositAllPossible({ requireServerEvidence: true })
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('controller store cannot mark ready without a fresh server deposit snapshot', async () => {
  const f = fixture({ packetMode: 'missing' })
  try {
    const { controller, operation, ledger } = storingOperation(f)
    await assert.rejects(controller.store(operation), /服务端|server|快照/)
    assert.equal(ledger.get(operation.id).phase, 'storing')
    assert.equal(ledger.pending().length, 1)
  } finally { f.close() }
})

test('controller store marks ready after a matching server deposit snapshot', async () => {
  const f = fixture()
  try {
    const { controller, operation } = storingOperation(f)
    assert.equal((await controller.store(operation)).phase, 'ready')
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('recovery completes a deposit whose first confirmation packet was missing', async () => {
  const f = fixture({ packetMode: 'missing' })
  try {
    const { controller, operation, ledger } = storingOperation(f)
    await assert.rejects(controller.store(operation), /服务端|server|快照/)
    assert.equal(ledger.pending().length, 1)
    f.setPacketMode('valid')
    f.warehouse.goHomeIfAway = async () => {}
    const result = await controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(ledger.pending().length, 0)
    assert.equal(f.db.listChestSlots().find(row => row.slot === 0)?.amount, 4)
  } finally { f.close() }
})

test('a pending craft prevents sync from rewriting chest slots before reconciliation', async () => {
  const f = fixture()
  try {
    storingOperation(f)
    const scan = { blocks: [], snapshots: [] }
    await assert.rejects(f.warehouse.applyWarehouseScan(scan, 1, { allowShrink: true }), /合成|craft/)
    assert.equal(f.db.listChests().length, 1)
  } finally { f.close() }
})

test('strict withdrawal verifies the server chest and player after the local click', async () => {
  const f = fixture({ withdraw: true })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    const result = await f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true })
    assert.equal(result.withdrawn[0].amount, 4)
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('strict withdrawal rejects a predicted transfer refused by the server', async () => {
  const f = fixture({ withdraw: true, accepted: false })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    await assert.rejects(f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true }), /服务端|server|快照/)
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('strict withdrawal propagates an uncertain click instead of trying another barrel', async () => {
  const f = fixture({ withdraw: true, uncertain: true })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    await assert.rejects(f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true }), error => error.uncertainTransfer)
  } finally { f.close() }
})

test('strict withdrawal never clicks without a complete initial server snapshot', async () => {
  const f = fixture({ withdraw: true, noFirstPacket: true })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    await assert.rejects(f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true }), error => error.uncertainTransfer)
    assert.equal(f.withdrawals(), 0)
  } finally { f.close() }
})

test('strict withdrawal does not credit unexplained extra stock to momo', async () => {
  const f = fixture({ withdraw: true })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    f.server.chest.count = 5
    await assert.rejects(f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true }), /服务端|人工核对/)
    assert.equal(f.withdrawals(), 0)
    assert.equal(f.db.getOwnerBalances(f.config.momoOwner).length, 0)
  } finally { f.close() }
})


test('recovery does not rescan after a completed deposit leaves a storing journal', async () => {
  const f = fixture({ packetMode: 'missing' })
  try {
    const { controller, operation, ledger } = storingOperation(f)
    await assert.rejects(controller.store(operation), /服务端|server|快照/)
    f.warehouse.goHomeIfAway = async () => {}
    assert.equal((await controller.recover()).status, 'recovered')
    assert.equal(ledger.pending().length, 0)
    assert.equal(f.opens(), 2, 'recovery must not reopen every registered barrel')
  } finally { f.close() }
})
