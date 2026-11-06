'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const CraftLedger = require('../../src/craft/ledger')
const CloudStoreService = require('../../src/service')
const { DEFAULT_CONFIG } = require('../../src/config')

function fixture () {
  const config = structuredClone(DEFAULT_CONFIG)
  const db = new StoreDb(':memory:', config)
  const catalog = new ItemCatalog(config.server.version, {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const Item = require('prismarine-item')(catalog.mcData)
  const planks = catalog.aggregatePrismarineItems([new Item(catalog.mcData.itemsByName.oak_planks.id, 2)])
  db.addBalanceItems('alice', planks)
  return { db, config, catalog, planks, close: () => db.close() }
}

function pendingJournal (f, botId) {
  const ledger = new CraftLedger(f.db)
  const id = `craft:${botId}`
  const data = { held: [], pending: null, physicalTotals: f.planks, stepIndex: 0 }
  ledger.begin({ id, botId, owner: { uuid: 'alice', username: 'Alice' }, allocations: f.planks, data })
  ledger.markRecovery(id, 'interrupted craft', data)
  return id
}

test('a journal owned by another bot is visible globally but not per bot', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    assert.equal(f.db.hasPendingCraft(), true)
    assert.equal(f.db.hasPendingCraft('bot-a'), false)
    assert.equal(f.db.hasPendingCraft('bot-b'), true)
    assert.deepEqual(f.db.pendingCraftBotIds(), ['bot-b'])
  } finally { f.close() }
})

test('assertNoPendingCraft names the bot that owns the journal', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    assert.throws(() => f.db.assertNoPendingCraft(), error => {
      assert.match(error.message, /合成仍在进行或等待恢复/)
      assert.match(error.message, /bot-b/)
      return true
    })
  } finally { f.close() }
})

test('assertNoPendingCraft keeps its original message when there is no journal', async () => {
  const f = fixture()
  try {
    assert.doesNotThrow(() => f.db.assertNoPendingCraft())
    assert.deepEqual(f.db.pendingCraftBotIds(), [])
  } finally { f.close() }
})

test('flushResidual keeps the upstream bot-specific journal guard', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    const service = Object.create(CloudStoreService.prototype)
    service.db = f.db
    service.botId = 'bot-a'
    service.catalog = f.catalog
    service.bot = { inventory: { items: () => [] } }
    await service.flushResidual()
    service.botId = 'bot-b'
    await assert.rejects(service.flushResidual(), /合成恢复记录/)
  } finally { f.close() }
})

function recoveryService (f, result) {
  const messages = []
  const owner = { botId: 'bot-b', getCraftController: () => ({ recover: async () => result }) }
  const service = Object.assign(Object.create(CloudStoreService.prototype), {
    botId: 'receiver', db: f.db,
    isAdmin: () => true,
    msg: (_user, text) => messages.push(text),
    taskPool: { workers: new Set([owner]), eligibleWorkerForTask: () => owner },
    enqueueTask: (username, type, run, options) => {
      assert.equal(type, 'craft_recovery')
      assert.equal(options.exclusive, true)
      assert.equal(options.stickyWorker, owner)
      return run(owner)
    }
  })
  return { service, messages }
}

test('craft recovery on another bot routes to the journal owner', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    const { service, messages } = recoveryService(f, { status: 'empty' })
    await service.handleCraftRecovery('kelemiao')
    assert.equal(messages.length, 1)
    assert.match(messages[0], /没有待恢复/)
    assert.match(messages[0], /bot-b/)
  } finally { f.close() }
})

test('craft recovery keeps the original empty reply when no journal exists anywhere', async () => {
  const f = fixture()
  try {
    const { service, messages } = recoveryService(f, { status: 'empty' })
    await service.handleCraftRecovery('kelemiao')
    assert.deepEqual(messages, ['本机器人没有待恢复的合成任务。'])
  } finally { f.close() }
})

test('manual recovery tells the admin to review registered inventory diffs', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    const { service, messages } = recoveryService(f, { status: 'recovered', diffRegistered: true })
    await service.handleCraftRecovery('kelemiao')
    assert.equal(messages.length, 1)
    assert.match(messages[0], /差异已登记库存异常/)
    assert.match(messages[0], /Web 管理页复核/)
  } finally { f.close() }
})

test('manual recovery keeps the plain success reply when no diff was registered', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    const { service, messages } = recoveryService(f, { status: 'recovered', diffRegistered: false })
    await service.handleCraftRecovery('kelemiao')
    assert.deepEqual(messages, ['合成中断状态已核验，物品已回云仓；可重新提交合成。'])
  } finally { f.close() }
})
