'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { BotTaskPool } = require('../../src/taskPool')
const Service = require('../../src/service')
const tick = () => new Promise(resolve => setImmediate(resolve))

function worker (botId) {
  return {
    botId, bot: { username: botId }, ready: true, active: null,
    async runExclusive (_username, type, fn, extra) {
      this.active = { type, ...extra }
      try { return await fn() } finally { this.active = null }
    },
    handleCommandError (_username, error) { throw error }
  }
}

test('unstarted offline recovery is not a queue barrier, while running recovery stays exclusive', async () => {
  const pool = new BotTaskPool()
  const healthy = worker('healthy')
  pool.register(healthy)
  const waiting = pool.enqueue({ type: 'craft_recovery', exclusive: true, stickyWorker: { botId: 'offline' }, run: () => assert.fail('offline recovery ran') })
  let ordinaryStarted = false
  pool.enqueue({ type: 'withdraw', run: () => { ordinaryStarted = true } })
  await tick()
  assert.equal(ordinaryStarted, true)
  const owner = worker('offline')
  let release
  pool.queue[0].run = () => new Promise(resolve => { release = resolve })
  pool.register(owner)
  let laterStarted = false
  const later = pool.enqueue({ type: 'withdraw', run: () => { laterStarted = true } })
  await tick()
  assert.equal(laterStarted, false)
  assert.equal(pool.inFlight.get(owner).exclusive, true)
  release()
  await Promise.all([waiting, later])
  assert.equal(laterStarted, true)
})

test('replacement bot cannot recover while the original instance still has a craft lease', () => {
  const pool = new BotTaskPool()
  const old = worker('owner'), replacement = worker('owner')
  pool.inFlight.set(old, { type: 'craft', exclusive: true })
  pool.register(replacement)
  assert.equal(pool.eligibleWorkerForTask({ type: 'craft_recovery', stickyWorker: replacement }), null)
  pool.inFlight.delete(old)
  assert.equal(pool.eligibleWorkerForTask({ type: 'craft_recovery', stickyWorker: old }), replacement)
})

test('manual recovery routes every journal to its bot and reports offline owners as waiting', async () => {
  const pool = new BotTaskPool()
  const receiver = worker('receiver'), first = worker('first'), second = worker('second')
  const recovered = []
  receiver.getCraftController = () => { assert.fail('receiving bot must not recover another bot inventory') }
  for (const owner of [first, second]) {
    owner.getCraftController = () => ({ recover: async () => { recovered.push(owner.botId); return { status: 'recovered', diffRegistered: owner === first } } })
  }
  pool.register(receiver); pool.register(first); pool.register(second)
  const messages = []
  const service = Object.assign(Object.create(Service.prototype), {
    botId: 'receiver', bot: receiver.bot, taskPool: pool,
    db: { pendingCraftBotIds: () => ['first', 'offline', 'second'], currentCommandLogId: () => 0 },
    isAdmin: () => true, msg: (_username, message) => messages.push(message)
  })
  await service.handleCraftRecovery('Admin')
  assert.deepEqual(recovered, ['first', 'second'])
  assert.equal(pool.queue.length, 1)
  assert.equal(pool.queue[0].stickyWorker.botId, 'offline')
  assert.ok(messages.some(message => /offline/.test(message) && /等待|离线/.test(message)))
  assert.ok(messages.some(message => /库存异常/.test(message) && /复核/.test(message)))
  pool.cancelQueuedCraftRecovery('offline')
})

test('a new craft first recovers its own pending journal before the upstream global guard', async () => {
  let pending = true, recovered = 0, ran = false
  const service = Object.assign(Object.create(Service.prototype), {
    botId: 'owner', bot: { username: 'owner' }, db: {
      hasPendingCraft: id => pending && id === 'owner',
      assertNoPendingCraft: () => { if (pending) throw new Error('pending craft recovery owner') },
      runWithCommandContext: (_id, fn) => fn(), runWithBotContext: (_context, fn) => fn()
    },
    getCraftController: () => ({ recover: async () => { assert.equal(service.active, undefined); recovered++; pending = false } })
  })
  await service.runExclusive('Alice', 'craft', () => { ran = true }, { exclusive: true })
  assert.equal(recovered, 1)
  assert.equal(ran, true)
})

test('ordinary tasks still respect upstream global pending protection', async () => {
  let recovered = false, ran = false
  const service = Object.assign(Object.create(Service.prototype), {
    botId: 'healthy', db: { assertNoPendingCraft: () => { throw new Error('pending craft owned by offline') } },
    getCraftController: () => ({ recover: async () => { recovered = true } })
  })
  await assert.rejects(service.runExclusive('Alice', 'withdraw', () => { ran = true }), /offline/)
  assert.equal(recovered, false)
  assert.equal(ran, false)
})


test('the real service and pool return the recovery result used by completion notices', async () => {
  const pool = new BotTaskPool()
  const service = Object.assign(Object.create(Service.prototype), {
    botId: 'owner', bot: { username: 'owner' }, ready: true, taskPool: pool,
    db: {
      assertNoPendingCraft: () => {}, currentCommandLogId: () => 0,
      runWithCommandContext: (_id, fn) => fn(), runWithBotContext: (_context, fn) => fn()
    }, msg: () => {}, handleCommandError: (_username, error) => { throw error }
  })
  pool.register(service)
  const result = await service.enqueueTask('Admin', 'craft_recovery', async () => ({ status: 'recovered', diffRegistered: true }),
    { exclusive: true, stickyWorker: service })
  assert.deepEqual(result, { status: 'recovered', diffRegistered: true })
  assert.equal(service.active, null)
})
