'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { BotTaskPool } = require('../../src/taskPool')
const Service = require('../../src/service')

test('a craft task keeps its global lease until its promise drains, including worker unregister', async () => {
  const pool = new BotTaskPool()
  let release
  let started
  const entered = new Promise(resolve => { started = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const worker = {
    bot: { username: 'A' }, ready: true, active: null,
    runExclusive: async function (username, type, fn, extra) {
      this.active = { username, type, ...extra }
      try { return await fn() } finally { this.active = null }
    },
    handleCommandError: error => { throw error }
  }
  const other = { ...worker, bot: { username: 'B' } }
  pool.register(worker)
  pool.register(other)
  const first = pool.enqueue({ username: 'Alice', type: 'craft', exclusive: true, run: async () => { started(); await pending } })
  await entered
  worker.active = null
  pool.unregister(worker)
  let secondStarted = false
  const second = pool.enqueue({ username: 'Alice', type: 'withdraw', run: async () => { secondStarted = true } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondStarted, false)
  assert.equal(pool.hasInFlightCraft(), true)
  release()
  await first
  await second
  assert.equal(secondStarted, true)
  assert.equal(pool.hasInFlightCraft(), false)
})

test('generic residual cleanup refuses inventory belonging to a pending craft', async () => {
  let moved = false
  const context = {
    botId: 'a', db: { hasPendingCraft: () => true },
    catalog: { aggregatePrismarineItems: () => [] }, bot: { inventory: { items: () => [] } },
    warehouse: { depositInventoryWithoutBalance: async () => { moved = true } }
  }
  await assert.rejects(Service.prototype.flushResidual.call(context), /合成恢复|momo/)
  assert.equal(moved, false)
})

test('service refuses a new asset task while durable craft recovery is pending', async () => {
  let ran = false
  const service = { db: { assertNoPendingCraft: () => { throw new Error('pending craft recovery') } }, active: null }
  await assert.rejects(Service.prototype.runExclusive.call(service, 'Alice', 'withdraw', async () => { ran = true }), /pending craft/)
  assert.equal(ran, false)
  assert.equal(service.active, null)
})

test('asset tasks retry deferred migrations and refuse mutation while migration fails', async () => {
  let fail = true
  let ran = false
  let attempts = 0
  const service = { active: null, db: {
    assertNoPendingCraft: () => {},
    runDeferredMigrations: () => { attempts++; return fail ? { catalogError: new Error('migration failed') } : {} },
    runWithCommandContext: async (id, fn) => fn()
  }, withBotContext: fn => fn() }
  await assert.rejects(Service.prototype.runExclusive.call(service, 'Alice', 'withdraw', async () => { ran = true }), /库存身份迁移/)
  assert.equal(ran, false)
  fail = false
  await Service.prototype.runExclusive.call(service, 'Alice', 'withdraw', async () => { ran = true })
  assert.equal(ran, true)
  assert.equal(attempts, 2)
})

test('StoreDb blocks balance writes and sync while a craft operation is pending, including reopen', () => {
  const StoreDb = require('../../src/db')
  const CraftLedger = require('../../src/craft/ledger')
  const { DEFAULT_CONFIG } = require('../../src/config')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-craft-guard-'))
  const filename = path.join(directory, 'warehouse.sqlite')
  let db = new StoreDb(filename, structuredClone(DEFAULT_CONFIG))
  try {
    const plank = { itemKey: 'minecraft:oak_planks|guard', itemId: 'minecraft:oak_planks', displayName: 'oak planks', nbtJson: 'null', metaJson: 'null', amount: 2 }
    db.addBalanceItems('alice', [plank])
    const ledger = new CraftLedger(db)
    ledger.begin({ id: 'craft:guard', botId: 'bot-a', actor: 'Alice', owner: { uuid: 'alice' }, target: { name: 'stick', quantity: 4 }, allocations: [plank] })
    assert.equal(db.hasPendingCraft(), true)
    assert.throws(() => db.addBalanceItems('bob', [plank]), /合成|craft/i)
    assert.throws(() => db.reconcileTotalsToMomo(new Map()), /合成|craft/i)
    db.close()
    db = new StoreDb(filename, structuredClone(DEFAULT_CONFIG))
    assert.equal(db.hasPendingCraft(), true)
    assert.equal(db.db.prepare("SELECT amount FROM inventory_reservations WHERE reservation_id='craft:guard'").get().amount, 2)
    assert.throws(() => db.addBalanceItems('bob', [plank]), /合成|craft/i)
  } finally {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('death during craft recovery cancels that recovery without generic asset cleanup', async () => {
  let cancelled = false
  let moved = false
  const service = {
    recoveringFromDeath: false, deathContext: { type: 'craft_recovery' },
    bot: { health: 20 }, db: { hasPendingCraft: () => true },
    craftController: { cancel: () => { cancelled = true }, isBusy: () => true },
    warehouse: { goHomeIfAway: () => { moved = true } }
  }
  await Service.prototype.handleRespawn.call(service)
  assert.equal(cancelled, true)
  assert.equal(moved, false)
  assert.equal(service.recoveringFromDeath, false)
})

test('respawn waits for the cancelled craft lease and then attempts recovery', async () => {
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let recovered = false
  let cancelled = false
  const service = {
    recoveringFromDeath: false, deathContext: { type: 'craft' }, botId: 'A',
    bot: { health: 20, _craftingExecutor: { isBusy: () => false } },
    db: { hasPendingCraft: () => true },
    taskPool: { hasInFlightCraft: () => true, waitForCraftDrain: async () => { entered(); await gate }, dispatch: () => {} },
    craftController: { cancel: () => { cancelled = true }, isBusy: () => false },
    getCraftController: () => ({ recover: async () => { recovered = true } })
  }
  const respawning = Service.prototype.handleRespawn.call(service)
  await waiting
  assert.equal(cancelled, true)
  assert.equal(recovered, false)
  release()
  await respawning
  assert.equal(recovered, true)
  assert.equal(service.recoveringFromDeath, false)
})

test('respawn completion dispatches a queued task after the craft lease has drained', async () => {
  const pool = new BotTaskPool()
  const service = {
    botId: 'A', ready: true, bot: { username: 'A' }, deathContext: { type: 'craft' },
    db: { hasPendingCraft: () => true }, taskPool: pool,
    craftController: { cancel: () => {}, isBusy: () => false },
    getCraftController: () => ({ recover: async () => {} }),
    runExclusive: async (username, type, fn) => fn(), handleCommandError: () => {}
  }
  pool.register(service)
  service.recoveringFromDeath = true
  let ran = false
  const next = pool.enqueue({ type: 'withdraw', run: () => { ran = true } })
  assert.equal(ran, false)
  service.recoveringFromDeath = false
  await Service.prototype.handleRespawn.call(service)
  await next
  assert.equal(ran, true)
  assert.equal(service.recoveringFromDeath, false)
})

test('queued craft recovery waits for the same bot after reconnect and never falls back', async () => {
  const pool = new BotTaskPool()
  const worker = botId => ({
    botId, bot: { username: botId }, ready: true, active: null,
    runExclusive: async (username, type, fn) => fn(),
    handleCommandError: (username, error) => { throw error }
  })
  const original = worker('A')
  const other = worker('B')
  pool.register(original)
  pool.register(other)
  original.ready = false
  const executedOn = []
  const recovery = pool.enqueue({ username: 'Admin', type: 'craft_recovery', exclusive: true,
    stickyWorker: original, run: current => { executedOn.push(current.botId) } })
  pool.unregister(original)
  pool.dispatch()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(executedOn, [])
  const replacement = worker('A')
  pool.register(replacement)
  await recovery
  assert.deepEqual(executedOn, ['A'])
})

test('spawn recovery waits for its old craft promise to drain before recovering', async () => {
  const pool = new BotTaskPool()
  let release, started
  const entered = new Promise(resolve => { started = resolve })
  const draining = new Promise(resolve => { release = resolve })
  const old = { botId: 'A', bot: { username: 'A' }, ready: true,
    runExclusive: async (username, type, fn) => fn(), handleCommandError: () => {} }
  pool.register(old)
  const craft = pool.enqueue({ type: 'craft', exclusive: true, run: async () => { started(); await draining } })
  await entered
  pool.unregister(old)
  let recovered = false
  const service = { botId: 'A', db: { hasPendingCraft: () => true }, taskPool: pool,
    getCraftController: () => ({ recover: async () => { recovered = true } }) }
  const recovering = Service.prototype.recoverPersistedTaskOnSpawn.call(service)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(recovered, false)
  release()
  await Promise.all([craft, recovering])
  assert.equal(recovered, true)
  assert.equal(pool.drainWaiters.size, 0)
})

test('another bot craft does not skip this bot spawn recovery', async () => {
  const pool = new BotTaskPool()
  pool.inFlight.set({ botId: 'B' }, { type: 'craft', exclusive: true })
  let recovered = false
  const service = { botId: 'A', db: { hasPendingCraft: () => true }, taskPool: pool,
    getCraftController: () => ({ recover: async () => { recovered = true } }) }
  await Service.prototype.recoverPersistedTaskOnSpawn.call(service)
  assert.equal(recovered, true)
  assert.equal(pool.drainWaiters.size, 0)
})

test('disabling a bot cancels its queued recovery while later tasks already reach their normal guards', async () => {
  const pool = new BotTaskPool()
  const original = { botId: 'A', ready: false }
  const other = { botId: 'B', bot: { username: 'B' }, ready: true,
    runExclusive: async (username, type, fn) => fn(), handleCommandError: () => {} }
  pool.register(other)
  const recovery = pool.enqueue({ type: 'craft_recovery', exclusive: true, stickyWorker: original,
    run: () => { throw new Error('disabled bot must not recover') } })
  let ran = false
  const next = pool.enqueue({ type: 'withdraw', run: () => { ran = true } })
  assert.equal(ran, true)
  assert.equal(pool.cancelQueuedCraftRecovery('A'), 1)
  assert.equal(await recovery, null)
  await next
  assert.equal(ran, true)
})

test('a connection invalidated during drain wait cannot start spawn recovery', async () => {
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let recovered = false
  const service = { botId: 'A', db: { hasPendingCraft: () => true },
    taskPool: { hasInFlightCraft: () => true, waitForCraftDrain: async () => { entered(); await gate } },
    getCraftController: () => ({ recover: async () => { recovered = true } }) }
  const recovery = Service.prototype.recoverPersistedTaskOnSpawn.call(service)
  await waiting
  service.connectionInvalidated = true
  release()
  await assert.rejects(recovery, /连接已失效/)
  assert.equal(recovered, false)
})
