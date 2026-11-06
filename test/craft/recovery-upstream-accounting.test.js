const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const StoreDb = require('../../src/db')
const CraftLedger = require('../../src/craft/ledger')
const CloudStoreWebServer = require('../../src/webServer')
const { DEFAULT_CONFIG } = require('../../src/config')

const diamond = { itemKey: 'diamond|plain', itemId: 'minecraft:diamond', displayName: 'Diamond', nbtJson: '', metaJson: '' }
const stick = { itemKey: 'stick|plain', itemId: 'minecraft:stick', displayName: 'Stick', nbtJson: '', metaJson: '' }
const qty = (item, amount) => ({ ...item, amount })

function fixture (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-recovery-accounting-'))
  const dbPath = path.join(directory, 'store.sqlite')
  const config = structuredClone(DEFAULT_CONFIG)
  let db = new StoreDb(dbPath, config)
  const ledger = new CraftLedger(db)
  const server = new CloudStoreWebServer(db, config, () => null)
  server.requireAdmin = () => ({ username: 'Admin' })
  db.addBalanceItems('alice', [qty(diamond, 10)])
  t.after(() => { if (db.db.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return {
    get db () { return db }, ledger, server,
    begin (id = 'craft:a', botId = 'bot-a') {
      return ledger.begin({ id, botId, owner: { uuid: 'alice', username: 'Alice' }, target: {}, allocations: [],
        data: { held: [], pending: null, stepIndex: 0 } })
    },
    reopen () { db.close(); db = new StoreDb(dbPath, config); server.db = db }
  }
}

test('recovery reconciles its own journal with upstream extra and missing allocation policy', t => {
  const f = fixture(t)
  f.begin()
  assert.throws(() => f.db.reconcileTotalsToMomo([qty(diamond, 8), qty(stick, 4)]), /合成|pending/i)
  const result = f.db.reconcileTotalsToMomo([qty(diamond, 8), qty(stick, 4)], 'craft:a')
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 8)
  assert.equal(f.db.getBalance(f.db.momoOwner, stick.itemKey), 4)
  assert.equal(result.unresolved[0].amount, 2)
  assert.equal(result.addedToMomo[0].amount, 4)
  const missing = f.db.db.prepare("SELECT amount, balance_adjusted FROM inventory_mismatches WHERE kind = 'missing'").get()
  assert.deepEqual(missing, { amount: 2, balance_adjusted: 2 })
  assert.throws(() => f.db.adjustBalance('alice', diamond.itemKey, 1), /合成|pending/i, 'recovery exemption does not escape its context')
})

test('recovery delta sync does not deduct unrelated stock omitted by a stale chest cache', t => {
  const f = fixture(t)
  f.begin()
  f.db.addInventoryMismatch('missing', 'alice', 'Alice', diamond, 1, 'pre-existing shortage')
  const staleCache = [qty(diamond, 8)]
  const result = f.db.reconcileRecoveryDeltaToMomo(staleCache, staleCache, 'craft:a')
  assert.deepEqual(result, { addedToMomo: [], removedFromMomo: [], unresolved: [] })
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 10)
  assert.equal(f.db.db.prepare("SELECT status FROM inventory_mismatches WHERE note = 'pre-existing shortage'").get().status, 'open')
})

test('recovery delta sync applies existing extra and missing policies only to changed totals', t => {
  const f = fixture(t)
  f.begin()
  const result = f.db.reconcileRecoveryDeltaToMomo(
    [qty(diamond, 10)], [qty(diamond, 8), qty(stick, 3)], 'craft:a'
  )
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 8)
  assert.equal(f.db.getBalance(f.db.momoOwner, stick.itemKey), 3)
  assert.equal(result.unresolved[0].amount, 2)
  assert.equal(result.addedToMomo[0].amount, 3)
  const missing = f.db.db.prepare("SELECT amount, balance_adjusted FROM inventory_mismatches WHERE kind = 'missing'").get()
  assert.deepEqual(missing, { amount: 2, balance_adjusted: 2 })
})

test('a recovery exemption never bypasses another unfinished journal', t => {
  const f = fixture(t)
  f.begin()
  f.begin('craft:b', 'bot-b')
  assert.throws(() => f.db.reconcileTotalsToMomo([], 'craft:a'), /合成|pending/i)
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 10)
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_mismatches').get().n, 0)
})

test('a failed recovery transaction rolls back upstream reconciliation and mismatch notes together', t => {
  const f = fixture(t)
  f.begin()
  assert.throws(() => f.db.transaction(() => {
    f.db.reconcileTotalsToMomo([qty(diamond, 8)], 'craft:a')
    throw new Error('finish failed')
  }), /finish failed/)
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 10)
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_mismatches').get().n, 0)
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'sync_deduct'").get().n, 0)
})

test('Web closes an already adjusted sync shortage without deducting surviving stock again', t => {
  const f = fixture(t)
  f.db.reconcileTotalsToMomo([qty(diamond, 8)])
  const row = f.db.db.prepare("SELECT id FROM inventory_mismatches WHERE kind = 'missing'").get()
  f.server.apiAdminMismatchDeduct({}, { id: row.id })
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 8)
  assert.equal(f.db.db.prepare('SELECT status FROM inventory_mismatches WHERE id = ?').get(row.id).status, 'resolved')
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'web_admin_mismatch_deduct'").get().n, 0)
})

test('Web deducts only the unadjusted part and repeated handling cannot deduct twice', t => {
  const f = fixture(t)
  f.db.addInventoryMismatch('missing', 'alice', 'Alice', diamond, 5, 'partly adjusted', 2)
  const row = f.db.db.prepare('SELECT id FROM inventory_mismatches').get()
  f.server.apiAdminMismatchDeduct({}, { id: row.id })
  f.server.apiAdminMismatchDeduct({}, { id: row.id })
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 7)
  assert.equal(f.db.db.prepare('SELECT balance_adjusted FROM inventory_mismatches WHERE id = ?').get(row.id).balance_adjusted, 5)
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'web_admin_mismatch_deduct'").get().n, 1)
})

test('manual missing rows keep the legacy default of no prior deduction', t => {
  const f = fixture(t)
  f.db.addInventoryMismatch('missing', 'alice', 'Alice', diamond, 3)
  const row = f.db.db.prepare('SELECT id, balance_adjusted FROM inventory_mismatches').get()
  assert.equal(row.balance_adjusted, 0)
  f.server.apiAdminMismatchDeduct({}, { id: row.id })
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 7)
})

test('confirmed withdrawal shortages record their automatic deduction for later Web review', t => {
  const f = fixture(t)
  f.db.deductConfirmedMissing('alice', 'Alice', [qty(diamond, 2)])
  const row = f.db.db.prepare('SELECT id, balance_adjusted FROM inventory_mismatches').get()
  assert.equal(row.balance_adjusted, 2)
  f.server.apiAdminMismatchDeduct({}, { id: row.id })
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 8)
})

test('upgrading old sync shortage notes prevents a second deduction while unrelated old notes stay unadjusted', t => {
  const f = fixture(t)
  f.db.addInventoryMismatch('missing', 'alice', 'Alice', diamond, 2, '同步发现仓库实物少于账本，已自动扣除账面 x2；留痕待管理员复核。')
  f.db.addInventoryMismatch('missing', 'alice', 'Alice', diamond, 1, 'manual review')
  if (f.db.db.prepare('PRAGMA table_info(inventory_mismatches)').all().some(column => column.name === 'balance_adjusted')) {
    f.db.db.exec('ALTER TABLE inventory_mismatches DROP COLUMN balance_adjusted')
  }
  f.reopen()
  const rows = f.db.db.prepare('SELECT id, balance_adjusted FROM inventory_mismatches ORDER BY id').all()
  assert.deepEqual(rows.map(row => row.balance_adjusted), [2, 0])
  f.server.apiAdminMismatchDeduct({}, { id: rows[0].id })
  assert.equal(f.db.getBalance('alice', diamond.itemKey), 10)
})

test('a failed historical adjustment migration rolls back its new column and can safely retry', t => {
  const f = fixture(t)
  f.db.addInventoryMismatch('missing', 'alice', 'Alice', diamond, 2, '同步发现仓库实物少于账本，已自动扣除账面 x2；留痕待管理员复核。')
  f.db.db.exec('ALTER TABLE inventory_mismatches DROP COLUMN balance_adjusted')
  f.db.db.exec("CREATE TRIGGER fail_adjustment_migration BEFORE UPDATE ON inventory_mismatches BEGIN SELECT RAISE(ABORT, 'migration backfill failed'); END")
  assert.throws(() => f.db.init(), /migration backfill failed/)
  assert.equal(f.db.db.prepare('PRAGMA table_info(inventory_mismatches)').all().some(column => column.name === 'balance_adjusted'), false,
    'the column must not signal a completed migration when its historical backfill failed')
  f.db.db.exec('DROP TRIGGER fail_adjustment_migration')
  f.db.init()
  assert.equal(f.db.db.prepare('SELECT balance_adjusted FROM inventory_mismatches').get().balance_adjusted, 2)
  f.reopen()
  assert.equal(f.db.db.prepare('SELECT balance_adjusted FROM inventory_mismatches').get().balance_adjusted, 2)
})
