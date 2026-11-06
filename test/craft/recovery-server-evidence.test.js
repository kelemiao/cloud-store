'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const CraftLedger = require('../../src/craft/ledger')
const { CraftController } = require('../../src/craft/controller')
const { DEFAULT_CONFIG } = require('../../src/config')

// Recovery now mirrors withdraw interruption recovery: park the interrupted
// backpack into the warehouse first (depositAllPossible), then reconcile the
// craft journal against the combined physical totals. These tests stub the
// deposit as a plain chest-slot write and assert the reconciliation branch.

function fixture (options = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  const catalog = new ItemCatalog(config.server.version, {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const Item = require('prismarine-item')(catalog.mcData)
  const make = (name, count) => new Item(catalog.mcData.itemsByName[name].id, count)
  const before = catalog.aggregatePrismarineItems([make('oak_planks', 2)])
  const products = catalog.aggregatePrismarineItems([make('stick', 4)])
  let inventory = options.ready ? [] : (options.held ? options.held.map(value => make(value.name, value.count)) : [make('stick', 4)])
  let stored = options.ready ? [make('oak_planks', 2)] : []
  const db = new StoreDb(':memory:', config)
  const chest = { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' }
  db.upsertChest(chest)
  db.addBalanceItems('alice', before)
  const ledger = new CraftLedger(db)
  const id = 'craft:server-evidence'
  ledger.begin({ id, botId: 'bot-a', owner: { uuid: 'alice', username: 'Alice' }, actor: 'Alice', allocations: before,
    data: options.ready ? { held: [], pending: null, physicalTotals: before, stepIndex: 0 } : undefined })
  const data = {
    held: products, pending: { stepId: '0:0', before, expectedConsumed: before, expectedProduced: products },
    physicalTotals: options.physicalTotals || before, stepIndex: 0
  }
  if (!options.ready) {
    ledger.checkpoint(id, 'crafting', { ...data, held: before })
    ledger.markRecovery(id, 'craft output lacked server confirmation', data)
  }
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = catalog.mcData
  bot.inventory = { items: () => inventory, selectedItem: null, slots: [] }
  let deposits = 0
  let depositOptions = null
  let openAttempts = 0
  const refresh = () => db.replaceChestSlots(chest.chestId, stored.map((value, slot) => ({ ...catalog.fromPrismarineItem(value), slot })))
  refresh()
  const warehouse = {
    withWarehouseLock: fn => fn(),
    goHomeIfAway: async () => {},
    openContainerAt: async () => {
      openAttempts++
      throw new Error('recovery must not scan unrelated registered chests')
    },
    closeContainerQuietly: () => {},
    // The deposit stub moves the whole backpack into the chest-slot ledger
    // exactly like depositAllPossible + refreshChestSnapshot does in production.
    depositAllPossible: async options => {
      deposits++
      depositOptions = options
      stored.push(...inventory)
      inventory = []
      refresh()
      return { deposited: stored, leftover: [], stopReason: '' }
    }
  }
  const controller = new CraftController({ bot, db, catalog, config, warehouse, ledger, executor: { isBusy: () => false, cancel: () => {} }, botId: 'bot-a' })
  return {
    db, bot, ledger, controller, before, products, chest, warehouse,
    deposits: () => deposits,
    depositOptions: () => depositOptions,
    openAttempts: () => openAttempts,
    serverItems: () => stored,
    confirmed: () => db.db.prepare('SELECT COUNT(*) AS n FROM craft_batches').get().n,
    close: () => db.close()
  }
}

test('recovery parks the backpack first, then confirms the interrupted conversion exactly once', async () => {
  const f = fixture({})
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.deposits(), 1)
    assert.deepEqual(f.depositOptions(), { requireServerEvidence: true })
    assert.equal(f.openAttempts(), 0, 'recovery relies on server evidence collected while depositing')
    assert.equal(f.confirmed(), 1)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 0)
    assert.equal(f.db.getBalance('alice', f.products[0].itemKey), 4)
    assert.equal(f.ledger.pending().length, 0)
    assert.equal((await f.controller.recover()).status, 'empty')
    assert.equal(f.confirmed(), 1)
  } finally { f.close() }
})

test('a retry after a completed deposit retains the original conversion intent', async () => {
  const f = fixture({})
  try {
    const deposit = f.warehouse.depositAllPossible
    let first = true
    f.warehouse.depositAllPossible = async (...args) => {
      const result = await deposit(...args)
      if (first) { first = false; throw new Error('temporary confirmation failure') }
      return result
    }
    assert.equal((await f.controller.recover()).status, 'recovered')
    assert.equal(f.confirmed(), 1)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 0)
    assert.equal(f.db.getBalance('alice', f.products[0].itemKey), 4)
  } finally { f.close() }
})

test('a finish failure cannot commit a conversion or invent duplicate recovery differences', async () => {
  const f = fixture({})
  try {
    const finish = f.ledger.finish.bind(f.ledger)
    let first = true
    f.ledger.finish = (...args) => {
      if (first) { first = false; throw new Error('temporary finish failure') }
      return finish(...args)
    }
    assert.equal((await f.controller.recover()).status, 'recovered')
    assert.equal(f.confirmed(), 1)
    assert.equal(f.db.getBalance('alice', f.products[0].itemKey), 4)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_mismatches').get().n, 0)
    assert.equal(f.ledger.pending().length, 0)
  } finally { f.close() }
})

test('recovery returns unchanged inputs without a conversion when nothing reached the table', async () => {
  // Server truth: the withdrawal never happened, backpack holds the inputs.
  const f = fixture({ held: [{ name: 'oak_planks', count: 2 }] })
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.deposits(), 1)
    assert.equal(f.confirmed(), 0)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
    assert.equal(f.ledger.pending().length, 0)
  } finally { f.close() }
})

test('a mismatched backpack settles through registered diff instead of locking the whole store', async () => {
  // Backpack holds sticks x1: neither the raw inputs nor the full conversion.
  // 旧行为：对账失败 → 抛错 + 保留记录锁全库等人工（2026-11-05 生产事故路径）。
  // 新行为：3 次重试后按中断基线登记逐 key 差异（2 planks missing、1 stick
  // extra）+ 失败销账闭环：实物已回仓、归属与异常都留痕，管理员可在 Web 复核。
  const f = fixture({ held: [{ name: 'stick', count: 1 }] })
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(result.diffRegistered, true)
    assert.equal(f.deposits(), 3, 'each retry attempt parks the backpack once')
    assert.equal(f.confirmed(), 0)
    // Journal closed: no more global lock on deposits/withdraws.
    assert.equal(f.ledger.pending().length, 0)
    // The diff is registered as an inventory mismatch for admin review.
    const mismatches = f.db.db.prepare('SELECT * FROM inventory_mismatches WHERE status = ? ORDER BY kind').all('open')
    assert.equal(mismatches.length, 2)
    const missing = mismatches.find(row => row.kind === 'missing')
    const excess = mismatches.find(row => row.kind === 'extra')
    assert.equal(missing.item_key, f.before[0].itemKey)
    assert.equal(missing.amount, 2)
    assert.equal(excess.item_key, f.products[0].itemKey)
    assert.equal(excess.amount, 1)
    // Existing sync rules deduct missing stock and credit extras to momo.
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 0)
    assert.equal(f.db.getBalance(f.db.momoOwner, f.products[0].itemKey), 1)
  } finally { f.close() }
})

test('recovery fails closed with no registered containers', async () => {
  const f = fixture({})
  f.db.listChests = () => []
  try {
    await assert.rejects(f.controller.recover(), /木桶|容器/)
    assert.equal(f.deposits(), 0)
    assert.equal(f.ledger.pending().length, 1)
  } finally { f.close() }
})

test('an interrupted ready operation with a recorded baseline can close without conversion', async () => {
  const f = fixture({ ready: true })
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.confirmed(), 0)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
    assert.equal(f.ledger.pending().length, 0)
  } finally { f.close() }
})

test('recovery self-heals an open window before parking the backpack', async () => {
  const f = fixture({})
  try {
    // Simulate a mid-click abort: a crafting window left open. Closing it
    // returns grid items to the backpack server-side, so the recovery must
    // park and settle without human intervention.
    f.bot.closeWindow = () => { f.bot.currentWindow = null }
    f.bot.currentWindow = { id: 3, type: 'minecraft:crafting' }
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.confirmed(), 1)
    assert.equal(f.ledger.pending().length, 0)
  } finally { f.close() }
})

test('recovery parks a cursor holding a crafted stack into a backpack slot first', async () => {
  const f = fixture({})
  try {
    const catalog = f.controller.catalog
    const Item = require('prismarine-item')(catalog.mcData)
    // Mid-pickup abort: cursor holds the crafted sticks, backpack empty.
    // Parking merges the cursor into a backpack slot, then the deposit path
    // returns them to the warehouse and the conversion confirms.
    const cursorStack = new Item(catalog.mcData.itemsByName.stick.id, 4)
    let backpack = []
    f.bot.inventory = {
      items: () => backpack,
      selectedItem: cursorStack,
      slots: new Array(46).fill(null)
    }
    f.bot.clickWindow = async slot => {
      f.bot.inventory.slots[slot] = f.bot.inventory.selectedItem
      backpack = [f.bot.inventory.selectedItem]
      f.bot.inventory.selectedItem = null
    }
    f.bot.closeWindow = () => {}
    let returned = []
    f.warehouse.depositAllPossible = async () => {
      returned = [...backpack]
      const rows = backpack.map((value, index) => ({ ...catalog.fromPrismarineItem(value), slot: index }))
      backpack = []
      f.db.db.transaction(() => {
        f.db.db.prepare('DELETE FROM chest_slots WHERE chest_id = ?').run(f.chest.chestId)
        for (const row of rows) {
          f.db.upsertItem({ itemKey: row.itemKey, itemId: row.itemId, displayName: row.displayName, nbtJson: row.nbtJson ?? '', metaJson: row.metaJson ?? '' })
          f.db.db.prepare('INSERT INTO chest_slots (chest_id, slot, item_key, amount) VALUES (?, ?, ?, ?)')
            .run(f.chest.chestId, row.slot, row.itemKey, row.amount)
        }
      })()
      return { deposited: rows, leftover: [], stopReason: '' }
    }
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.bot.inventory.selectedItem, null)
    assert.ok(f.bot.inventory.slots.some(Boolean))
    assert.equal(f.ledger.pending().length, 0)
    assert.equal(f.db.getBalance('alice', f.products[0].itemKey), 4)
  } finally { f.close() }
})

test('recovery keeps the journal when the deposit leaves items behind (full warehouse)', async () => {
  const f = fixture({})
  try {
    // Warehouse cannot take anything: deposit is a no-op with leftovers.
    f.warehouse.depositAllPossible = async () => ({ deposited: [], leftover: [], stopReason: 'full' })
    await assert.rejects(f.controller.recover(), /空间不足/)
    assert.equal(f.confirmed(), 0)
    assert.equal(f.ledger.pending().length, 1)
  } finally { f.close() }
})


test('fallback sync fixes balances before releasing the recovery journal', async () => {
  const f = fixture({ held: [{ name: 'stick', count: 1 }] })
  try {
    f.db.upsertChest({ chestId: '1,64,0', x: 1, y: 64, z: 0, blockName: 'barrel' })
    assert.equal((await f.controller.recover()).status, 'recovered')
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 0)
    assert.equal(f.db.getBalance(f.db.momoOwner, f.products[0].itemKey), 1)
    assert.equal(f.ledger.pending().length, 0)
    assert.equal(f.openAttempts(), 0, 'fallback reconciliation must not rescan unrelated registered chests')
    assert.doesNotThrow(() => f.db.assertNoPendingCraft())
  } finally { f.close() }
})

test('fallback sync and finish roll back together and a retry does not duplicate differences', async () => {
  const f = fixture({ held: [{ name: 'stick', count: 1 }] })
  try {
    const finish = f.ledger.finish.bind(f.ledger)
    let first = true
    f.ledger.finish = (...args) => {
      if (first) { first = false; throw new Error('finish unavailable') }
      return finish(...args)
    }
    await assert.rejects(f.controller.recover(), /finish unavailable/)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_mismatches').get().n, 0)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
    assert.equal(f.ledger.pending().length, 1)
    assert.equal((await f.controller.recover()).status, 'recovered')
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_mismatches').get().n, 2)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 0)
  } finally { f.close() }
})

test('missing original evidence cannot be mistaken for a completed reconciliation', async () => {
  const f = fixture({ ready: true })
  try {
    f.ledger.checkpoint('craft:server-evidence', 'ready', { held: [], pending: null, stepIndex: 0 })
    await assert.rejects(f.controller.recover(), /缺少实物基线/)
    assert.equal(f.ledger.pending().length, 1)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_mismatches').get().n, 0)
  } finally { f.close() }
})


test('recovery does not reopen an unrelated registered chest', async () => {
  const f = fixture({})
  try {
    const second = { chestId: '1,64,0', x: 1, y: 64, z: 0, blockName: 'barrel' }
    f.db.upsertChest(second)
    assert.equal((await f.controller.recover()).status, 'recovered')
    assert.equal(f.confirmed(), 1)
    assert.equal(f.db.getBalance('alice', f.products[0].itemKey), 4)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_mismatches').get().n, 0)
    assert.equal(f.openAttempts(), 0)
  } finally { f.close() }
})

test('the warehouse mutex remains owned throughout retries and fallback settlement', async () => {
  const f = fixture({ held: [{ name: 'stick', count: 1 }] })
  try {
    const { AsyncMutex } = require('../../src/taskPool')
    const mutex = new AsyncMutex()
    f.warehouse.withWarehouseLock = fn => mutex.run(fn)
    let signal
    const firstDeposit = new Promise(resolve => { signal = resolve })
    const deposit = f.warehouse.depositAllPossible
    f.warehouse.depositAllPossible = async () => { const result = await deposit(); signal(); return result }
    const recovery = f.controller.recover()
    await firstDeposit
    let entered = false
    const next = f.warehouse.withWarehouseLock(() => {
      entered = true
      assert.equal(f.ledger.pending().length, 0, 'next inventory task sees the settled journal')
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(entered, false)
    assert.equal((await recovery).status, 'recovered')
    await next
    assert.equal(entered, true)
  } finally { f.close() }
})

test('cancellation between recovery attempts never reaches the fallback balance sync', async () => {
  const f = fixture({ held: [{ name: 'stick', count: 1 }] })
  try {
    const deposit = f.warehouse.depositAllPossible
    f.warehouse.depositAllPossible = async () => {
      const result = await deposit()
      setImmediate(() => f.controller.cancel('disconnected during retry'))
      return result
    }
    await assert.rejects(f.controller.recover(), /disconnected during retry/)
    assert.equal(f.ledger.pending().length, 1)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_mismatches').get().n, 0)
    assert.equal(f.controller.isBusy(), false)
  } finally { f.close() }
})


test('cancelling while closing a recovery window prevents a later cursor click', async () => {
  const f = fixture({})
  try {
    const Item = require('prismarine-item')(f.controller.catalog.mcData)
    f.bot.currentWindow = { id: 3 }
    f.bot.inventory.selectedItem = new Item(f.controller.catalog.mcData.itemsByName.stick.id, 1)
    f.bot.inventory.slots = new Array(46).fill(null)
    let clicks = 0
    f.bot.clickWindow = async () => { clicks++; f.bot.inventory.selectedItem = null }
    f.bot.closeWindow = () => {
      f.bot.currentWindow = null
      f.controller.cancel('cancelled during window close')
    }
    await assert.rejects(f.controller.recover(), /cancelled during window close/)
    assert.equal(clicks, 0)
    assert.equal(f.ledger.pending().length, 1)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
  } finally { f.close() }
})
