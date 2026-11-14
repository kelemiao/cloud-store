const { GoalBlock, GoalNear } = require('mineflayer-pathfinder').goals
const warehouseMovements = require('./warehouseMovements')
const Vec3 = require('vec3')
const { sleep, sumBy, notchYawDeg, notchPitchDeg } = require('./utils')
const { logLocalError } = require('./localErrorLog')
const { isFatalProtocolReadError } = require('./botConnection')
const { traceEvent, shortKey } = require('./traceLog')
const { openServerContainer, readServerContainer, snapshotCraftWindow } = require('./craft/server-container-evidence')
const { createConfirmedDepositor } = require('./craft/confirmed-deposit')
const { planCraftChestRoute } = require('./craft/withdraw-route')

class Warehouse {
  constructor (bot, db, catalog, config, warehouseMutex = null, warehouseState = null) {
    this.bot = bot
    this.db = db
    this.catalog = catalog
    this.config = config
    this.warehouseMutex = warehouseMutex
    this.warehouseState = warehouseState || { revision: 0, chestRevisions: new Map() }
    this.botId = String(config.server?.botName || config.server?.username || bot.username || 'bot').toLowerCase()
    this.chestNames = new Set(config.warehouse.chestBlockNames || ['barrel'])
    this.homePosition = null
    this.openingChest = null
    this.connectionAbortController = new AbortController()
    this.mutationSeq = 0
    this.chestMutationSeqs = new Map()
    // 当前取货/同步任务的链路日志上下文（由 service 挂载）；仓库操作都经仓库锁串行执行。
    this.activeTrace = null
  }

  withWarehouseLock (fn) {
    return this.warehouseMutex ? this.warehouseMutex.run(fn) : fn()
  }

  debug (message) {
    if (this.config.debug) console.log(`[warehouse] ${message}`)
  }

  attachTrace (trace) {
    this.activeTrace = trace || null
    return this.activeTrace
  }

  detachTrace () {
    const trace = this.activeTrace
    this.activeTrace = null
    return trace
  }

  trace (phase, event, data = {}) {
    traceEvent(this.activeTrace, phase, event, data)
  }

  // 快照一个容器的实际内容（“打开后是什么样”），条目精简便于日志阅读与回传分析。
  snapshotContainerContents (container) {
    try {
      return this.containerContentItems(container).map(item => {
        const normalized = this.catalog.fromPrismarineItem(item)
        return {
          slot: item.slot,
          id: normalized.itemId,
          name: normalized.displayName || normalized.itemId,
          n: item.count,
          key: shortKey(normalized.itemKey)
        }
      })
    } catch (error) {
      return [{ error: String(error?.message || error) }]
    }
  }

  // 从物品档案（NBT）提取潜影盒内容摘要，用于“取完后盒子是什么样”。
  snapshotShulkerContents (normalized) {
    try {
      if (!this.catalog.isShulkerBox(normalized?.itemId)) return null
      return this.catalog.extractShulkerContents(normalized).map(entry => ({
        id: entry.item.itemId,
        name: entry.item.displayName || entry.item.itemId,
        n: entry.amount,
        slots: entry.slotCount,
        key: shortKey(entry.item.itemKey)
      }))
    } catch (error) {
      return [{ error: String(error?.message || error) }]
    }
  }

  async goHome (options = {}) {
    const command = this.config.commands.home
    const requireWarehouse = Boolean(options.requireWarehouse && this.db.listChests().length)
    this.bot.chat(command)

    if (requireWarehouse) {
      await this.waitUntilNearKnownWarehouse(command)
    } else {
      await sleep(this.config.timing.homeWaitMs)
    }

    this.captureHomePosition()
  }

  async waitUntilNearKnownWarehouse (command) {
    const minWaitMs = Number(this.config.timing.homeWaitMs || 3500)
    const timeoutMs = Number(this.config.timing.homeTimeoutMs || Math.max(30000, minWaitMs))
    const startedAt = Date.now()
    let lastPosition = this.bot.entity?.position ? this.describePosition(this.bot.entity.position) : '?'

    while (Date.now() - startedAt < timeoutMs) {
      if (this.isClientClosed()) {
        throw new Error(`${command} 等待过程中连接已断开，将由重连流程继续处理。`)
      }
      const pos = this.bot.entity?.position
      if (pos) lastPosition = this.describePosition(pos)
      if (Date.now() - startedAt >= minWaitMs && this.isNearKnownWarehouse()) return
      await sleep(250)
    }

    if (this.isNearKnownWarehouse()) return
    throw new Error(`${command} 后 ${timeoutMs}ms 内没有回到仓库附近，当前坐标 ${lastPosition}。请检查 home 点或服务器传送是否失败。`)
  }

  isClientClosed () {
    const client = this.bot._client
    return Boolean(client?.ended || client?.socket?.destroyed || client?.socket?._writableState?.destroyed)
  }

  captureHomePosition () {
    const pos = this.bot.entity?.position
    if (!pos) return
    this.homePosition = pos.clone()
    this.debug(`home position ${this.describePosition(this.homePosition)}`)
  }

  async goHomeIfAway () {
    if (this.isNearKnownWarehouse()) {
      this.debug('already near known warehouse, skip home command')
      return false
    }
    await this.goHome({ requireWarehouse: true })
    return true
  }

  isNearKnownWarehouse () {
    const pos = this.bot.entity?.position
    if (!pos) return false
    const radius = Number(this.config.warehouse?.homeSkipRadius || 8)
    const radiusSq = radius * radius
    for (const chest of this.db.listChests()) {
      const dx = pos.x - chest.x
      const dy = pos.y - chest.y
      const dz = pos.z - chest.z
      if ((dx * dx) + (dy * dy) + (dz * dz) <= radiusSq) return true
    }
    return false
  }

  async settleResidualToMomo () {
    const items = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    if (!items.length) return { deposited: [], leftover: [] }
    return this.depositInventoryForOwner(this.config.momoOwner, 'momo')
  }

  async depositInventoryForOwner (ownerUuid, username) {
    return this.withWarehouseLock(() => this.depositInventoryForOwnerLocked(ownerUuid, username))
  }

  async depositInventoryForOwnerLocked (ownerUuid, username) {
    const before = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    if (!before.length) return { deposited: [], leftover: [] }

    this.trace('deposit', 'deposit_start', {
      ownerUuid,
      username,
      held: before.map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
      decision: `开始入库：背包共 ${before.reduce((sum, item) => sum + item.amount, 0)} 个`
    })

    const depositResult = await this.depositAllPossible()

    const after = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    this.debug(`deposit inventory result owner=${username} before=${before.reduce((sum, item) => sum + item.amount, 0)} after=${after.reduce((sum, item) => sum + item.amount, 0)}`)
    const afterByKey = new Map(after.map(item => [item.itemKey, item.amount]))
    const deposited = []

    for (const item of before) {
      const left = afterByKey.get(item.itemKey) || 0
      const amount = item.amount - left
      if (amount > 0) deposited.push({ ...item, amount })
    }

    this.trace('deposit', 'deposit_result', {
      ownerUuid,
      deposited: deposited.map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
      leftover: after.map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
      stopReason: depositResult.stopReason || '',
      decision: deposited.length
        ? `入库完成：${deposited.reduce((sum, item) => sum + item.amount, 0)} 个已记入账本`
        : '没有物品成功入库'
    })

    if (deposited.length) {
      this.db.addBalanceItems(ownerUuid, deposited)
      const status = after.length ? 'partial' : 'ok'
      const message = after.length
        ? `leftover_items=${after.length}, leftover_amount=${after.reduce((sum, item) => sum + item.amount, 0)}`
        : ''
      this.db.addTransaction('deposit', status, ownerUuid, username, deposited, message)
    }

    return { deposited, leftover: after, stopReason: depositResult.stopReason || '' }
  }

  async depositInventoryWithoutBalance (type = 'recovery', message = '') {
    return this.withWarehouseLock(() => this.depositInventoryWithoutBalanceLocked(type, message))
  }

  async depositInventoryWithoutBalanceLocked (type = 'recovery', message = '') {
    const before = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    if (!before.length) return { deposited: [], leftover: [] }

    const depositResult = await this.depositAllPossible()

    const after = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    this.debug(`deposit inventory without balance result type=${type} before=${before.reduce((sum, item) => sum + item.amount, 0)} after=${after.reduce((sum, item) => sum + item.amount, 0)}`)
    const afterByKey = new Map(after.map(item => [item.itemKey, item.amount]))
    const deposited = []

    for (const item of before) {
      const left = afterByKey.get(item.itemKey) || 0
      const amount = item.amount - left
      if (amount > 0) deposited.push({ ...item, amount })
    }

    if (deposited.length) {
      this.db.addTransaction(type, 'ok', this.config.momoOwner, 'recovery', deposited, message)
    }

    return { deposited, leftover: after, stopReason: depositResult.stopReason || '' }
  }

  async depositAllPossible (options = {}) {
    options.check?.()
    const chests = this.db.listChests()
    if (!chests.length) {
      this.trace('error', 'deposit_no_registered_chests', {
        decision: '没有任何已登记的木桶，无法入库'
      })
      throw new Error('没有已登记的箱子，请管理员先执行 !同步仓库 半径')
    }

    const skippedNoProgress = new Set()
    const maxEmptyAttempts = Number.isInteger(this.config.warehouse?.maxEmptyDepositAttempts)
      ? this.config.warehouse.maxEmptyDepositAttempts
      : 3
    const maxFullAttempts = Number.isInteger(this.config.warehouse?.maxFullDepositAttempts)
      ? this.config.warehouse.maxFullDepositAttempts
      : 8
    let emptyAttempts = 0
    let fullAttempts = 0
    let stopReason = ''

    while (this.bot.inventory.items().length) {
      const chest = this.nextDepositChest(skippedNoProgress, {
        allowEmpty: emptyAttempts < maxEmptyAttempts,
        allowFull: fullAttempts < maxFullAttempts
      })
      if (!chest) {
        stopReason = `没有本地记录可用的入库木桶；已尝试空槽木桶 ${emptyAttempts} 个、满记录木桶 ${fullAttempts} 个。请管理员执行 !同步 后再试。`
        this.debug('deposit no local candidate chest left')
        this.trace('decision', 'deposit_stop', {
          stopReason,
          emptyAttempts,
          fullAttempts,
          decision: '找不到可用的入库木桶，停止入库'
        })
        break
      }

      const emptyOnlyCandidate = chest.sameItemFree <= 0
      const fullRecordCandidate = chest.sameItemFree <= 0 && chest.emptySlots <= 0
      this.trace('deposit', 'deposit_candidate', {
        chest: this.describeChest(chest),
        sameItemFree: chest.sameItemFree,
        emptySlots: chest.emptySlots,
        decision: `选择木桶 ${this.describeChest(chest)} 入库（同类可叠加 ${chest.sameItemFree}，空槽 ${chest.emptySlots}）`
      })
      const container = await this.openContainerAt(chest)
      let movedInChest = 0
      const noSpaceKeys = new Set()
      try {
        const confirmedDeposit = options.requireServerEvidence ? createConfirmedDepositor(this, options.check, container) : null
        let progress = true
        while (progress && this.bot.inventory.items().length) {
          progress = false
          // The bot inventory snapshot can lag behind the open window after a
          // shift-click. Use the window's live player-inventory slots so a
          // moved item is not clicked again through its stale slot number.
          const items = this.currentDepositItemsFromContainer(container)
          if (!items.length) break
          for (const item of items) {
            if (options.requireServerEvidence) {
              const key = this.catalog.fromPrismarineItem(item).itemKey
              if (noSpaceKeys.has(key)) continue
              if (this.containerFreeSpaceFor(container, key, item) <= 0) {
                noSpaceKeys.add(key)
                continue
              }
            }
            const moved = confirmedDeposit ? await confirmedDeposit(container, item) : await this.tryDepositInto(container, item)
            // Reuse a negative capacity result only across synchronous checks.
            // Any awaited transfer may deliver a new window state, even if it
            // reports no movement. It must invalidate all skipped identities.
            noSpaceKeys.clear()
            if (moved > 0) {
              progress = true
              movedInChest += moved
              this.debug(`deposited ${moved} ${item.name} into ${this.describeChest(chest)}`)
              this.trace('deposit', 'deposit_item', {
                chest: this.describeChest(chest),
                slot: item.slot,
                moved,
                decision: `存入 ${moved} 个 ${item.name}`
              })
              if (!confirmedDeposit) await sleep(this.config.timing.containerSettleMs)
            }
          }
        }
        this.refreshChestSnapshot(chest, container)
      } finally {
        this.closeContainerQuietly(container)
      }

      if (options.requireServerEvidence) await this.verifyCraftContainer(chest)
      options.check?.()

      if (movedInChest <= 0) {
        skippedNoProgress.add(chest.chestId)
        if (fullRecordCandidate) fullAttempts++
        else if (emptyOnlyCandidate) emptyAttempts++
        this.trace('decision', 'deposit_no_progress', {
          chest: this.describeChest(chest),
          decision: '该木桶没有存入任何物品，跳过并尝试下一个'
        })
      } else {
        this.trace('deposit', 'deposit_barrel_result', {
          chest: this.describeChest(chest),
          moved: movedInChest,
          decision: `该木桶共存入 ${movedInChest} 个`
        })
        skippedNoProgress.clear()
        emptyAttempts = 0
        fullAttempts = 0
      }
    }

    return { stopReason }
  }

  async verifyCraftContainer (chest) {
    try {
      const expectedChest = this.db.listChestSlots().filter(row => row.chestId === chest.chestId && row.slot !== null)
        .map(row => ({ slot: row.slot, itemKey: row.itemKey, amount: row.amount }))
      const expectedPlayer = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      const snapshot = await readServerContainer(this, chest, this.catalog, this.bot)
      this.db.replaceChestSlots(chest.chestId, snapshot.chestSlots)
      const localPlayer = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      if (!this.sameCraftChestSlots(snapshot.chestSlots, expectedChest) || !this.sameCraftItems(snapshot.playerItems, expectedPlayer) ||
        !this.sameCraftItems(snapshot.playerItems, localPlayer) || this.bot.currentWindow || this.bot.inventory.selectedItem ||
        this.bot.inventory.slots?.slice(0, 5).some(Boolean)) {
        throw new Error('取存后的服务端箱子或背包快照与预测结果不一致，等待合成恢复。')
      }
    } catch (error) {
      error.uncertainTransfer = true
      throw error
    }
  }

  // Reuse the already confirmed craft barrel window when every piece of
  // evidence still lines up. If anything changed, close it and take one fresh
  // authoritative snapshot before continuing; an uncertain transfer never
  // proceeds on a stale client window.
  async reuseOrReopenCraftContainer (chest, container, evidence) {
    if (evidence?.isReusable?.()) return { container, evidence }

    const local = snapshotCraftWindow(container, this.catalog, this.bot)
    evidence?.dispose?.()
    this.closeContainerQuietly(container)
    // Mineflayer copies the window's player slots into bot.inventory on close.
    const closedPlayer = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())

    let reopened
    try {
      reopened = await openServerContainer(this, chest, this.catalog, this.bot, { keepEvidence: true })
    } catch (error) {
      error.uncertainTransfer = true
      throw error
    }
    const botMatches = this.sameCraftItems(reopened.playerItems, closedPlayer) &&
      this.sameCraftItems(reopened.playerItems, this.catalog.aggregatePrismarineItems(this.bot.inventory.items()))
    const matches = local && this.sameCraftChestSlots(reopened.chestSlots, local.chestSlots) &&
      this.sameCraftItems(reopened.playerItems, local.playerItems) && botMatches &&
      !reopened.container.selectedItem && !this.bot.inventory.selectedItem &&
      !this.bot.inventory.slots?.slice(0, 5).some(Boolean)
    if (!matches) {
      this.closeContainerQuietly(reopened.container)
      reopened.evidence?.dispose?.()
      const error = new Error('合成取料窗口失去服务端证据，重开后的木桶或背包快照仍不一致。')
      error.uncertainTransfer = true
      throw error
    }
    return reopened
  }

  sameCraftChestSlots (left, right) {
    const entries = values => JSON.stringify(values.map(value => [value.slot, value.itemKey, value.amount]).sort((a, b) => a[0] - b[0]))
    return entries(left) === entries(right)
  }

  sameCraftItems (left, right) {
    const totals = values => JSON.stringify(values.map(value => [value.itemKey, value.amount]).sort((a, b) => a[0].localeCompare(b[0])))
    return totals(left) === totals(right)
  }

  nextDepositChest (skipped = new Set(), options = {}) {
    const containerSlots = this.config.warehouse?.containerSlots || 27
    const inventorySpace = this.currentDepositSpaceByItemKey()
    if (!inventorySpace.size) return null

    const chestRows = this.db.listChestSlots()
    const chests = new Map()
    for (const row of chestRows) {
      let chest = chests.get(row.chestId)
      if (!chest) {
        chest = {
          chestId: row.chestId,
          x: row.x,
          y: row.y,
          z: row.z,
          blockName: row.blockName,
          usedSlots: new Set(),
          sameItemFree: 0
        }
        chests.set(row.chestId, chest)
      }
      if (row.slot === null || row.slot === undefined || row.slot < 0 || row.slot >= containerSlots) continue
      chest.usedSlots.add(row.slot)
      const info = inventorySpace.get(row.itemKey)
      if (info) {
        chest.sameItemFree += Math.max(0, info.stackSize - Number(row.amount || 0))
      }
    }

    const candidates = [...chests.values()]
      .filter(chest => !skipped.has(chest.chestId))
      .map(chest => {
        const emptySlots = Math.max(0, containerSlots - chest.usedSlots.size)
        return {
          ...chest,
          emptySlots,
          score: chest.sameItemFree > 0 ? 1000000 + chest.sameItemFree : emptySlots
        }
      })
      .filter(chest => chest.sameItemFree > 0 || chest.emptySlots > 0)
    const fullRecordCandidates = [...chests.values()]
      .filter(chest => !skipped.has(chest.chestId))
      .map(chest => {
        const emptySlots = Math.max(0, containerSlots - chest.usedSlots.size)
        return { ...chest, emptySlots, score: 0 }
      })
      .filter(chest => chest.sameItemFree <= 0 && chest.emptySlots <= 0)

    const sameItemCandidates = candidates.filter(chest => chest.sameItemFree > 0)
    const candidatePool = sameItemCandidates.length
      ? sameItemCandidates
      : (options.allowEmpty !== false && candidates.some(chest => chest.emptySlots > 0)
          ? candidates.filter(chest => chest.emptySlots > 0)
          : (options.allowFull ? fullRecordCandidates : []))

    const best = candidatePool
      .sort((a, b) => b.score - a.score || b.sameItemFree - a.sameItemFree || b.emptySlots - a.emptySlots || a.chestId.localeCompare(b.chestId))[0] || null
    if (best) {
      this.debug(`deposit candidate ${this.describeChest(best)} sameFree=${best.sameItemFree} emptySlots=${best.emptySlots}`)
    }
    return best
  }

  currentDepositSpaceByItemKey () {
    const map = new Map()
    for (const item of this.bot.inventory.items()) {
      const normalized = this.catalog.fromPrismarineItem(item)
      const stackSize = item.stackSize || this.catalog.getStackSize(`minecraft:${item.name}`)
      const existing = map.get(normalized.itemKey)
      if (existing) {
        existing.amount += item.count
        existing.stackSize = Math.max(existing.stackSize, stackSize)
      } else {
        map.set(normalized.itemKey, { itemKey: normalized.itemKey, stackSize, amount: item.count })
      }
    }
    return map
  }

  currentDepositItemsFromContainer (container) {
    const items = []
    const start = Number(container?.inventoryStart)
    const end = Number(container?.inventoryEnd)
    if (!Array.isArray(container?.slots) || !Number.isInteger(start) || !Number.isInteger(end)) return items
    for (let slot = start; slot < end; slot++) {
      const item = container.slots[slot]
      if (item) items.push({ ...item, windowSlot: slot })
    }
    return items
  }

  async tryDepositInto (container, item) {
    const normalized = this.catalog.fromPrismarineItem(item)
    const free = this.containerFreeSpaceFor(container, normalized.itemKey, item)
    if (free <= 0) {
      this.debug(`deposit no actual space for ${item.name} key=${normalized.itemKey}`)
      return 0
    }

    const windowSlot = Number.isInteger(item.windowSlot)
      ? item.windowSlot
      : this.windowSlotFromBotInventorySlot(container, item.slot)
    if (windowSlot === null) return 0
    const sourceWindowItem = container.slots?.[windowSlot] || null
    if (!sourceWindowItem) {
      this.debug(`deposit skip stale inventory slot ${item.name}@${item.slot}: window slot ${windowSlot} is empty`)
      return 0
    }
    const sourceCount = Math.max(0, Number(sourceWindowItem.count || item.count || 0))
    const canObserveContainerContents = typeof container.containerItems === 'function' || typeof container.items === 'function'
    const beforeContainerCount = canObserveContainerContents ? this.countContainerItem(container, normalized.itemKey) : 0

    try {
      await this.bot.clickWindow(windowSlot, 0, 1)
      const timeoutMs = Math.max(
        Number(this.config.timing?.containerSettleMs || 0),
        Number(this.config.timing?.inventoryUpdateTimeoutMs || 2000),
        500
      )
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const currentSlotItem = container.slots?.[windowSlot] || null
        const currentContainerCount = canObserveContainerContents
          ? this.countContainerItem(container, normalized.itemKey)
          : beforeContainerCount
        const sourceDecrease = currentSlotItem
          ? Math.max(0, sourceCount - Number(currentSlotItem.count || 0))
          : sourceCount
        const containerIncrease = canObserveContainerContents
          ? Math.max(0, currentContainerCount - beforeContainerCount)
          : sourceDecrease
        const moved = Math.min(sourceDecrease, containerIncrease, free)
        if (moved > 0) {
          if (!container.selectedItem && (sourceDecrease >= moved || !currentSlotItem)) return moved
        }
        await sleep(50)
      }
      // A predicted inventory decrease without a matching container increase is
      // not a successful deposit. Do not credit the owner's balance for it.
      return 0
    } catch (error) {
      this.debug(`deposit exact slot ${item.name}@${item.slot} failed: ${error.message}`)
      return 0
    }
  }

  inventoryCountByItemKey (itemKey) {
    let total = 0
    for (const item of this.bot.inventory.items()) {
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey === itemKey) total += item.count
    }
    return total
  }

  containerFreeSpaceFor (container, itemKey, inventoryItem) {
    const stackSize = inventoryItem.stackSize || this.catalog.getStackSize(`minecraft:${inventoryItem.name}`)
    let free = 0

    for (let slot = 0; slot < this.expectedContainerSlots(); slot++) {
      const item = container.slots[slot]
      if (!item) {
        free += stackSize
        continue
      }
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey === itemKey) {
        free += Math.max(0, (item.stackSize || stackSize) - item.count)
      }
    }

    return free
  }

  windowSlotFromBotInventorySlot (window, botInventorySlot) {
    if (!Number.isInteger(botInventorySlot)) return null
    const offset = window.inventoryStart - this.bot.inventory.inventoryStart
    const slot = botInventorySlot + offset
    if (slot < window.inventoryStart || slot >= window.inventoryEnd) return null
    return slot
  }

  firstEmptyWindowInventorySlot (window) {
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      if (!window.slots[slot]) return slot
    }
    return null
  }

  // 窗口背包区里同类型的未满堆：找能整份收下 amount 个的堆（余量最大者优先）。
  // 左键把光标上的同类型物品点上去、右键逐个放上去，服务器都按合并处理。
  windowMergeSlotForItem (window, itemKey, amount) {
    if (!Number.isFinite(amount) || amount <= 0) return null
    let bestSlot = null
    let bestFree = 0
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      const item = window.slots[slot]
      if (!item) continue
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey !== itemKey) continue
      const stackSize = item.stackSize || this.catalog.getStackSize(`minecraft:${item.name}`)
      const free = Math.max(0, stackSize - Number(item.count || 0))
      if (free >= amount && free > bestFree) {
        bestSlot = slot
        bestFree = free
      }
    }
    return bestSlot
  }

  // 取物落点：优先并入背包里同类型未满堆，并不下整份再占空格。
  // 桶里的库存常是 39/38/29 这种碎片堆，不并堆的话每取一个碎片就多占一格，
  // 实际占格会远超分批预算的 ceil(数量/堆叠上限)，把背包提前撑满。
  withdrawDestinationSlot (window, sourceItem, amount) {
    const normalized = this.catalog.fromPrismarineItem(sourceItem)
    const mergeSlot = this.windowMergeSlotForItem(window, normalized.itemKey, amount)
    if (mergeSlot !== null) return mergeSlot
    return this.firstEmptyWindowInventorySlot(window)
  }

  emptyInventorySlotCount () {
    const slots = this.bot.inventory?.slots
    if (!Array.isArray(slots)) return 0
    let count = 0
    for (let slot = 9; slot < 45; slot++) {
      if (!slots[slot]) count++
    }
    return count
  }

  // 背包对某物品的剩余可收容量：空格 × 堆叠上限 + 同类型未满堆余量。
  // 取物并堆后这就是"还能再取多少个"的真实上限。无法观测背包槽位（测试桩等）
  // 时返回 Infinity，调用方按"还有容量"处理。
  inventoryFreeCapacityForItem (itemKey) {
    const slots = this.bot.inventory?.slots
    if (!Array.isArray(slots)) return Number.POSITIVE_INFINITY
    const itemId = String(itemKey || '').split('|')[0]
    const stackSize = Math.max(1, Number(this.catalog.getStackSize(itemId) || 64))
    let free = this.emptyInventorySlotCount() * stackSize
    for (const item of this.bot.inventory.items()) {
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey !== itemKey) continue
      const size = Number(item.stackSize) > 0 ? Number(item.stackSize) : stackSize
      free += Math.max(0, size - Number(item.count || 0))
    }
    return free
  }

  async withdrawAllocations (allocations) {
    return this.withWarehouseLock(() => this.withdrawAllocationsLocked(allocations))
  }

  async withdrawAllocationsLocked (allocations, options = {}) {
    if (options.craftBatch) return this.withdrawCraftBatchAllocationsLocked(allocations, options)
    let packingSources = null
    if (Object.hasOwn(options, 'packingSourceChestIds')) {
      const ids = options.packingSourceChestIds
      const registered = new Set(this.db.listChests().map(chest => chest.chestId))
      if (!options.requireServerEvidence || !Array.isArray(ids) || !ids.length ||
        new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !registered.has(id))) {
        throw new Error('Invalid packing source whitelist; registered IDs and strict server evidence required')
      }
      packingSources = new Set(ids)
    }
    const withdrawn = []
    const missing = []
    const unlocated = []
    let searchedUnlocatedBarrels = 0

    for (const allocation of allocations) {
      if (allocation.withdrawMode === 'shulker_extract') {
        if (options.requireServerEvidence) throw new Error('合成取料只支持已登记的散装库存。')
        const result = await this.withdrawFromShulkerBoxes(allocation)
        withdrawn.push(...result.withdrawn)
        missing.push(...result.missing)
        continue
      }

      let remaining = allocation.amount
      // 背包对该物品装不下时（空格与同类型半堆余量都为 0），剩余数量按"背包已满"
      // 计入缺失——这不是仓库缺货，不参与确认缺失自动修账。
      let inventoryFull = false
      const itemInfo = this.db.getItemByKey(allocation.itemKey)
      if (!itemInfo) {
        this.trace('plan', 'allocate_item_unknown', {
          item: allocation.displayName || allocation.itemKey,
          key: allocation.itemKey,
          keyTail: shortKey(allocation.itemKey),
          need: allocation.amount,
          decision: '账本里找不到该物品档案，直接计入缺失'
        })
        missing.push({ ...allocation })
        continue
      }

      const slots = this.db.listSlotsForItemKey(allocation.itemKey)
      let chestGroups = this.groupSlotsForWithdrawal(slots)
      if (packingSources) chestGroups = chestGroups.filter(group => packingSources.has(group.chestId))
      this.debug(`withdraw plan ${itemInfo.displayName || allocation.itemKey} need=${allocation.amount} chests=${chestGroups.map(group => `${group.chestId}:${group.recordedAmount}`).join(' | ') || 'none'}`)

      // 账本有量但一个槽位记录都没有（物品被人工移动/记录漂移）：登记库存异常，
      // 但不再直接判死——按距离由近到远打开已登记木桶现场找货，
      // 读到什么就用实测内容刷新该桶记录，凑够或搜完为止。
      let searchBarrels = false
      if (!chestGroups.length) {
        if (options.requireServerEvidence) throw new Error('合成取料缺少已登记的箱子槽位，等待人工核对。')
        this.reportMissingLooseRecord(allocation, itemInfo)
        unlocated.push({ ...itemInfo, amount: allocation.amount })
        chestGroups = this.buildUnlocatedSearchGroups()
        searchBarrels = chestGroups.length > 0
        this.trace('plan', 'unlocated_search_start', {
          item: itemInfo.displayName || allocation.itemKey,
          keyTail: shortKey(allocation.itemKey),
          need: allocation.amount,
          candidates: chestGroups.length,
          limit: this.unlocatedSearchLimit(),
          decision: searchBarrels
            ? `账本有库存但无位置记录，按距离由近到远最多打开 ${this.unlocatedSearchLimit()} 个木桶现场找货`
            : '账本有库存但无位置记录，且没有可搜索的木桶'
        })
      }

      // 链路日志：这次要取什么、账本说这些货放在哪些木桶。
      this.trace('plan', 'allocate_start', {
        item: itemInfo.displayName || allocation.itemKey,
        key: allocation.itemKey,
        keyTail: shortKey(allocation.itemKey),
        need: allocation.amount,
        ownerUuid: allocation.ownerUuid || '',
        barrelPlan: chestGroups.map(group => ({
          chest: group.chestId,
          recorded: group.recordedAmount,
          slots: group.slots.map(row => row.slot)
        })),
        decision: chestGroups.length
          ? `要取 ${allocation.amount} 个，按账本记录依次开 ${chestGroups.length} 个木桶`
          : '账本有库存但没有任何木桶位置记录'
      })

      // 记录说这个桶有货、实际却没取到（含整桶读空疑似卡顿）时，就地同步这一个桶的记录，
      // 然后换下一个有记录的桶接着找；这样的“缺货换桶”最多 maxMissingBarrels 次（可配置），
      // 账实相符的桶不计数。
      let missingBarrelHops = 0
      const maxMissingBarrels = Math.max(1, Number(this.config.timing?.withdrawMaxMissingBarrels ?? 5))
      let searchedBarrels = 0
      let refusedBarrels = 0
      let emptyBarrels = 0
      let timeoutBarrels = 0
      for (const group of chestGroups) {
        if (remaining <= 0) break
        // 容量兜底：并堆后背包对该物品已经装不下时，不再白跑木桶（每桶都会
        // 因"没有空槽"空手而归），直接按背包已满结算剩余数量。
        if (this.inventoryFreeCapacityForItem(allocation.itemKey) <= 0) {
          inventoryFull = true
          this.debug(`withdraw ${itemInfo.displayName || allocation.itemKey} 背包已满（无空格且无可并半堆），停止取该物品 remaining=${remaining}`)
          this.trace('decision', 'withdraw_inventory_full', {
            item: itemInfo.displayName || allocation.itemKey,
            keyTail: shortKey(allocation.itemKey),
            remaining,
            decision: `背包已满且无同类型可并堆位，停止取该物品，剩余 ${remaining} 个按背包已满计入缺失`
          })
          break
        }
        if (searchBarrels) {
          // 无记录搜索：额度独立于缺货换桶，按单桶 5 秒上限逐个开。
          if (searchedBarrels >= this.unlocatedSearchLimit()) break
          searchedBarrels++
          searchedUnlocatedBarrels++
          const result = await this.searchUnlocatedBarrel(group, allocation, itemInfo, remaining)
          if (result.refused || result.empty || result.timeout) {
            if (result.refused) refusedBarrels++
            else if (result.empty) emptyBarrels++
            else timeoutBarrels++
            continue
          }
          if (result.moved > 0) {
            withdrawn.push({ ...itemInfo, amount: result.moved })
            remaining -= result.moved
          }
          continue
        }
        if (missingBarrelHops >= maxMissingBarrels) {
          this.debug(`withdraw ${itemInfo.displayName || allocation.itemKey} 缺货换桶已达上限 ${missingBarrelHops}/${maxMissingBarrels}，停止继续找桶，剩余计入缺失`)
          this.trace('decision', 'barrel_hops_exhausted', {
            item: itemInfo.displayName || allocation.itemKey,
            hops: missingBarrelHops,
            max: maxMissingBarrels,
            remaining,
            decision: `连续 ${missingBarrelHops} 个木桶实物少于账本，停止换桶，剩余 ${remaining} 计入缺失`
          })
          break
        }
        const slot = group.slots[0]
        const chestId = group.chestId
        const chest = { chestId, x: slot.x, y: slot.y, z: slot.z, blockName: slot.blockName }
        const maxReadAttempts = Math.max(1, Number(this.config.timing?.barrelEmptyRereadAttempts ?? 3))
        this.trace('locate', 'barrel_locate', {
          item: itemInfo.displayName || allocation.itemKey,
          chest: this.describeChest(chest),
          chestId,
          recorded: group.recordedAmount,
          slots: group.slots.map(row => row.slot),
          need: remaining,
          hop: missingBarrelHops,
          decision: `定位到木桶 ${this.describeChest(chest)}（账本 ${group.recordedAmount} 个），走去打开`
        })
        let container
        if (options.requireServerEvidence) {
          let snapshot
          try { snapshot = await openServerContainer(this, chest, this.catalog, this.bot) } catch (error) {
            error.uncertainTransfer = true
            throw error
          }
          container = snapshot.container
          const recorded = this.db.listChestSlots().filter(row => row.chestId === chest.chestId && Number.isInteger(row.slot))
            .map(row => ({ slot: row.slot, itemKey: row.itemKey, amount: Number(row.amount) }))
          const localChest = this.containerContentItems(container).map(item => ({
            ...this.catalog.fromPrismarineItem(item), slot: item.slot, amount: item.count
          }))
          const windowPlayer = this.catalog.aggregatePrismarineItems(container.items())
          if (!this.sameCraftChestSlots(snapshot.chestSlots, recorded) || !this.sameCraftChestSlots(snapshot.chestSlots, localChest) ||
            !this.sameCraftItems(snapshot.playerItems, windowPlayer) || !this.sameCraftItems(snapshot.playerItems, this.catalog.aggregatePrismarineItems(this.bot.inventory.items())) ||
            container.selectedItem || this.bot.currentWindow !== container) {
            this.closeContainerQuietly(container)
            const error = new Error('合成取料开箱时服务端实物与背包记录不一致，等待人工核对。')
            error.uncertainTransfer = true
            throw error
          }
        } else container = await this.openContainerAt(chest)
        let transferAttempted = false
        // 开窗前的该桶 revision：读窗期间若被其他流程改写（如紧急救援直写库存），
        // 多出部分可能是在途物品，跳过自动入账留给 !同步，避免双重记账。
        const revisionBeforeOpen = this.warehouseState?.chestRevisions?.get(chestId) || 0
        try {
          // 木桶整个读出来一个物品都没有，多半是服务器卡顿返回了空窗口，而不是真实缺货：
          // 关窗重开重读确认；重读仍为空就保留原记录并跳过该木桶，与真实缺货区分开。
          let available = 0
          let trustedRead = false
          for (let readAttempt = 1; readAttempt <= maxReadAttempts; readAttempt++) {
            available = this.countContainerItem(container, allocation.itemKey)
            const totalInChest = this.containerContentItems(container).reduce((sum, item) => sum + Number(item.count || 0), 0)
            if (totalInChest > 0) {
              trustedRead = true
              break
            }
            this.debug(`withdraw empty window read attempt=${readAttempt}/${maxReadAttempts} ${this.describeChest(chest)} recorded=${group.recordedAmount} item=${allocation.itemKey}`)
            this.trace('open', 'barrel_read_empty_retry', {
              chest: this.describeChest(chest),
              attempt: readAttempt,
              max: maxReadAttempts,
              recorded: group.recordedAmount,
              contents: this.snapshotContainerContents(container),
              decision: `第 ${readAttempt} 次读到的木桶是空的，疑似服务器卡顿，关窗重开确认`
            })
            if (readAttempt === maxReadAttempts) break
            this.closeContainerQuietly(container)
            await sleep(Math.max(0, Number(this.config.timing.containerSettleMs ?? 250)))
            container = await this.openContainerAt(chest)
          }
          if (!trustedRead) {
            console.warn(`[withdraw] ${this.describeChest(chest)} 连续 ${maxReadAttempts} 次读到空木桶，疑似服务器卡顿；跳过该木桶并保留原记录 item=${allocation.itemKey} recorded=${group.recordedAmount}`)
            this.trace('decision', 'barrel_read_empty_skip', {
              chest: this.describeChest(chest),
              attempts: maxReadAttempts,
              recorded: group.recordedAmount,
              decision: `连续 ${maxReadAttempts} 次读到空桶，按服务器卡顿处理：保留原记录，跳过该木桶`
            })
            missingBarrelHops++
            continue
          }
          this.debug(`window slots container=0..${container.inventoryStart - 1} inventory=${container.inventoryStart}..${container.inventoryEnd - 1}`)
          const toTake = Math.min(remaining, available)
          if (options.requireServerEvidence && available !== group.recordedAmount) {
            const error = new Error('合成取料时箱子实物与记录不一致，等待人工核对。')
            error.uncertainTransfer = true
            throw error
          }
          this.debug(`withdraw open ${this.describeChest(chest)} recorded=${group.recordedAmount} actual=${available} need=${remaining}`)
          this.trace('open', 'barrel_open', {
            chest: this.describeChest(chest),
            recorded: group.recordedAmount,
            actual: available,
            need: remaining,
            toTake,
            contents: this.snapshotContainerContents(container),
            decision: `打开木桶：目标物品实际 ${available} 个（账本 ${group.recordedAmount}），本次计划取 ${toTake}`
          })
          transferAttempted = true
          const moved = await this.tryWithdrawExactFrom(container, allocation.itemKey, toTake, group.slots.map(row => row.slot), options)
          if (moved > 0) {
            withdrawn.push({ ...itemInfo, amount: moved })
            remaining -= moved
            await sleep(this.config.timing.containerSettleMs)
            this.debug(`withdraw moved ${moved} ${itemInfo.displayName || allocation.itemKey} from ${this.describeChest(chest)} remaining=${remaining}`)
            this.trace('take', 'barrel_take_result', {
              chest: this.describeChest(chest),
              planned: toTake,
              moved,
              remaining,
              decision: `从该木桶取出 ${moved} 个，还差 ${remaining} 个`
            })
          } else {
            this.trace('take', 'barrel_take_none', {
              chest: this.describeChest(chest),
              planned: toTake,
              actual: available,
              decision: '点击后没有确认到任何物品进入背包'
            })
          }
          // 实物比记录少（含物品被换成别的东西）时，当场把这一个木桶的记录刷新成实际内容
          this.refreshChestSnapshot(chest, container)
          if (available < group.recordedAmount) {
            missingBarrelHops++
            this.debug(`withdraw ${this.describeChest(chest)} 实际少于记录 recorded=${group.recordedAmount} actual=${available} 缺货换桶 ${missingBarrelHops}/${maxMissingBarrels}`)
            this.trace('decision', 'barrel_shortage_skip', {
              chest: this.describeChest(chest),
              recorded: group.recordedAmount,
              actual: available,
              hops: missingBarrelHops,
              max: maxMissingBarrels,
              decision: `实物(${available})比账本(${group.recordedAmount})少，已刷新该桶记录，换下一个木桶`
            })
          } else if (available > group.recordedAmount) {
            // 实物比记录多：多出部分归属未知（人工放入/历史漂移），当场按 !同步 的
            // extra 语义划入 momo 并登记异常，供管理员在 Web 页转移给正确归属——
            // 取货任务结束时账本即与实物一致，不必等管理员手动 !同步。
            const extra = available - group.recordedAmount
            const revisionNow = this.warehouseState?.chestRevisions?.get(chestId) || 0
            if (revisionNow !== revisionBeforeOpen) {
              this.trace('decision', 'barrel_extra_skip', {
                chest: this.describeChest(chest),
                extra,
                decision: '读窗期间该木桶被其他流程改动，多出部分可能是在途物品：跳过自动入账，留给 !同步 对账'
              })
            } else if (typeof this.db.creditExtraToMomo === 'function') {
              const credited = this.db.creditExtraToMomo(itemInfo, extra, `withdraw_barrel_extra; chest=${chestId}`)
              this.trace('record', 'barrel_extra_credited', {
                chest: this.describeChest(chest),
                extra,
                credited,
                decision: `实物比记录多 ${extra} 个，已划入 momo 并登记异常留痕`
              })
            }
          }
        } catch (error) {
          if (options.requireServerEvidence && transferAttempted) {
            error.uncertainTransfer = true
            throw error
          }
          if (error?.uncertainTransfer) {
            if (options.requireServerEvidence) throw error
            // 点击级重试已用尽仍无法确认实物状态：不刷新该桶记录（窗口内容存疑，避免写入过期状态），
            // 保留原记录并换下一个木桶，任务继续，剩余数量最终计入缺失。
            missingBarrelHops++
            this.trace('decision', 'barrel_uncertain_skip', {
              chest: this.describeChest(chest),
              item: itemInfo.displayName || allocation.itemKey,
              remaining,
              hops: missingBarrelHops,
              max: maxMissingBarrels,
              message: error.message,
              decision: '重试后仍无法确认实物状态：保留该木桶原记录，换下一个木桶继续'
            })
            continue
          }
          this.trace('error', 'barrel_error', {
            chest: this.describeChest(chest),
            message: error?.message || String(error),
            decision: '该木桶处理中断'
          })
          throw error
        } finally {
          this.closeContainerQuietly(container)
        }
        if (options.requireServerEvidence && transferAttempted) await this.verifyCraftContainer(chest)
      }

      if (remaining > 0) {
        if (searchBarrels) {
          this.trace('decision', 'unlocated_search_exhausted', {
            item: itemInfo.displayName || allocation.itemKey,
            keyTail: shortKey(allocation.itemKey),
            searched: searchedBarrels,
            limit: this.unlocatedSearchLimit(),
            refusedCount: refusedBarrels,
            emptyCount: emptyBarrels,
            timeoutCount: timeoutBarrels,
            remaining,
            decision: `已打开 ${searchedBarrels} 个木桶仍未凑够，剩余 ${remaining} 计入缺失`
          })
        }
        this.trace('result', 'allocate_missing', {
          item: itemInfo.displayName || allocation.itemKey,
          keyTail: shortKey(allocation.itemKey),
          missing: remaining,
          inventoryFull,
          decision: inventoryFull
            ? `背包已满，该物品还有 ${remaining} 个装不下，按背包已满计入缺失（不修账）`
            : `该物品最终还有 ${remaining} 个没有取到，计入缺失`
        })
        missing.push({ ...itemInfo, amount: remaining, ...(inventoryFull ? { inventoryFull: true } : {}) })
      }
    }

    return {
      withdrawn: this.mergeItems(withdrawn),
      missing: this.mergeItems(missing),
      unlocated: this.mergeItems(unlocated),
      searchedUnlocatedBarrels
    }
  }

  async withdrawCraftBatchAllocationsLocked (allocations, options = {}) {
    if (!options.requireServerEvidence) throw new Error('合成批次取料必须使用服务端实物证据。')

    const entries = []
    const missing = []
    for (const allocation of allocations || []) {
      if (allocation.withdrawMode === 'shulker_extract') throw new Error('合成取料只支持已登记的散装库存。')
      const amount = Number(allocation.amount || 0)
      if (amount <= 0) continue
      const itemInfo = this.db.getItemByKey(allocation.itemKey)
      if (!itemInfo) {
        missing.push({ ...allocation })
        continue
      }
      const groups = this.groupSlotsForWithdrawal(this.db.listSlotsForItemKey(allocation.itemKey))
      if (!groups.length) throw new Error('合成取料缺少已登记的箱子槽位，等待人工核对。')
      let remaining = amount
      for (const group of groups) {
        if (remaining <= 0) break
        const planned = Math.min(remaining, group.recordedAmount)
        if (planned <= 0) continue
        entries.push({ allocation: { ...allocation }, itemInfo, group, remaining: planned })
        remaining -= planned
      }
      if (remaining > 0) missing.push({ ...itemInfo, amount: remaining })
    }

    const route = planCraftChestRoute(entries, this.bot.entity?.position || this.homePosition)
    const withdrawn = []
    for (const routeGroup of route) {
      const slot = routeGroup.slots[0]
      const chest = { chestId: routeGroup.chestId, x: slot.x, y: slot.y, z: slot.z, blockName: slot.blockName }
      this.trace('locate', 'craft_route_chest', {
        chest: this.describeChest(chest),
        itemCount: routeGroup.entries.length,
        items: routeGroup.entries.map(entry => ({ item: entry.allocation.itemKey, amount: entry.remaining })),
        decision: '合成批次按当前位置路线合并同一木桶访问'
      })
      let container
      let evidence
      let transferAttempted = false
      try {
        let snapshot
        try { snapshot = await openServerContainer(this, chest, this.catalog, this.bot, { keepEvidence: true }) } catch (error) {
          error.uncertainTransfer = true
          throw error
        }
        container = snapshot.container
        evidence = snapshot.evidence
        const recorded = this.db.listChestSlots().filter(row => row.chestId === chest.chestId && Number.isInteger(row.slot))
          .map(row => ({ slot: row.slot, itemKey: row.itemKey, amount: Number(row.amount) }))
        const localChest = this.containerContentItems(container).map(item => ({
          ...this.catalog.fromPrismarineItem(item), slot: item.slot, amount: item.count
        }))
        const windowPlayer = this.catalog.aggregatePrismarineItems(container.items())
        if (!this.sameCraftChestSlots(snapshot.chestSlots, recorded) || !this.sameCraftChestSlots(snapshot.chestSlots, localChest) ||
          !this.sameCraftItems(snapshot.playerItems, windowPlayer) ||
          !this.sameCraftItems(snapshot.playerItems, this.catalog.aggregatePrismarineItems(this.bot.inventory.items())) ||
          container.selectedItem || this.bot.currentWindow !== container) {
          this.closeContainerQuietly(container)
          const error = new Error('合成取料开箱时服务端实物与背包记录不一致，等待人工核对。')
          error.uncertainTransfer = true
          throw error
        }

        for (const entry of routeGroup.entries) {
          if (entry.remaining <= 0) continue
          const ready = await this.reuseOrReopenCraftContainer(chest, container, evidence)
          container = ready.container
          evidence = ready.evidence
          const itemKey = entry.allocation.itemKey
          const available = this.countContainerItem(container, itemKey)
          if (available !== entry.group.recordedAmount) {
            const error = new Error('合成取料时箱子实物与记录不一致，等待人工核对。')
            error.uncertainTransfer = true
            throw error
          }
          const toTake = Math.min(entry.remaining, available)
          if (toTake <= 0) continue
          transferAttempted = true
          const moved = await this.tryWithdrawExactFrom(container, itemKey, toTake, entry.group.slots.map(row => row.slot), options)
          if (moved > 0) {
            entry.remaining -= moved
            withdrawn.push({ ...entry.itemInfo, amount: moved })
          }
        }
        if (transferAttempted) {
          const ready = await this.reuseOrReopenCraftContainer(chest, container, evidence)
          container = ready.container
          evidence = ready.evidence
          this.refreshChestSnapshot(chest, container)
        }
      } catch (error) {
        if (transferAttempted) error.uncertainTransfer = true
        throw error
      } finally {
        evidence?.dispose?.()
        if (this.bot.currentWindow === container) this.closeContainerQuietly(container)
      }
    }

    for (const entry of entries) {
      if (entry.remaining > 0) missing.push({ ...entry.itemInfo, amount: entry.remaining })
    }
    return {
      withdrawn: this.mergeItems(withdrawn),
      missing: this.mergeItems(missing),
      unlocated: [],
      searchedUnlocatedBarrels: 0
    }
  }

  // 无记录搜索的桶数上限。0 表示不搜，回到旧的"直接判定找不到位置"行为。
  unlocatedSearchLimit () {
    const raw = Number(this.config.timing?.withdrawMaxUnlocatedBarrels ?? 12)
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  }

  // 账本没有槽位记录时的候选桶：取已登记的完整木桶列表，按距离 bot /home 落点
  // 由近到远排序，近的先搜、凑够就停。
  buildUnlocatedSearchGroups () {
    const limit = this.unlocatedSearchLimit()
    if (!limit) return []
    let chests = []
    try {
      chests = this.db.listChests() || []
    } catch (error) {
      this.debug(`list chests for unlocated search failed: ${error?.message || error}`)
      return []
    }
    const origin = this.homePosition || this.bot.entity?.position
    const distanceOf = chest => {
      if (!origin) return 0
      const dx = Number(chest.x) - origin.x
      const dy = Number(chest.y) - origin.y
      const dz = Number(chest.z) - origin.z
      return (dx * dx) + (dy * dy) + (dz * dz)
    }
    return chests
      .map(chest => ({ chest, distance: distanceOf(chest) }))
      .sort((a, b) => a.distance - b.distance || String(a.chest.chestId).localeCompare(String(b.chest.chestId)))
      .slice(0, limit)
      .map(({ chest }) => ({
        chestId: chest.chestId,
        // 没有账本记录，不能假装是 0 个——用 null 表示"未知"，
        // 避免下游把它当成"账本说这个桶是空的"。
        recordedAmount: null,
        unknown: true,
        slots: [{ x: chest.x, y: chest.y, z: chest.z, blockName: chest.blockName }]
      }))
  }

  // 搜一个没有槽位记录的木桶：单次尝试、最多等 unlocatedBarrelWaitMs，
  // 容器内容一到就结束等待并继续后续动作。
  // 返回 { refused } / { empty } / { timeout } / { moved, contents }。
  async searchUnlocatedBarrel (group, allocation, itemInfo, remaining) {
    const slot = group.slots[0]
    const chest = { chestId: group.chestId, x: slot.x, y: slot.y, z: slot.z, blockName: slot.blockName }
    const waitMs = Math.max(500, Number(this.config.timing?.unlocatedBarrelWaitMs ?? 5000))
    const startedAt = Date.now()

    this.trace('locate', 'unlocated_search_chest', {
      item: itemInfo.displayName || allocation.itemKey,
      chest: this.describeChest(chest),
      chestId: chest.chestId,
      need: remaining,
      waitMs
    })

    const block = this.bot.blockAt(new Vec3(chest.x, chest.y, chest.z))
    if (!block || !this.chestNames.has(block.name)) {
      // 桶被拆掉或换成了别的方块：跳过这个坐标，继续下一个。
      this.trace('decision', 'unlocated_search_not_barrel', {
        chest: this.describeChest(chest),
        actualBlock: block?.name || 'none',
        decision: '该坐标不是可打开的木桶，跳过继续搜索'
      })
      return { refused: false, empty: true, timeout: false, moved: 0, notBarrel: true }
    }

    let container = null
    try {
      container = await this.openContainerBlock(block, waitMs)
    } catch (error) {
      if (error?.code === 'FATAL_PROTOCOL_READ' || this.connectionAbortController.signal.aborted) throw error
      if (error?.openResult === 'refused') {
        // 只收到 close_window：服务器拒绝了这次开箱，和桶里有多少东西无关，
        // 不能当成空桶去写记录。
        this.trace('open', 'unlocated_search_open_refused', {
          chest: this.describeChest(chest),
          message: error.message,
          decision: '只收到 close_window，服务器拒绝开箱，不计空桶、不写记录，继续下一个'
        })
        this.closeLingeringWindow()
        return { refused: true, empty: false, timeout: false, moved: 0 }
      }
      this.trace('open', 'unlocated_search_open_timeout', {
        chest: this.describeChest(chest),
        waitedMs: Date.now() - startedAt,
        message: error?.message || String(error),
        decision: '等待容器内容超时，按约定认定该木桶为空，继续下一个'
      })
      this.closeLingeringWindow()
      return { refused: false, empty: false, timeout: true, moved: 0 }
    }

    if (!container) {
      this.trace('open', 'unlocated_search_open_timeout', {
        chest: this.describeChest(chest),
        waitedMs: Date.now() - startedAt,
        decision: '没有拿到容器窗口，按约定认定该木桶为空，继续下一个'
      })
      this.closeLingeringWindow()
      return { refused: false, empty: false, timeout: true, moved: 0 }
    }

    try {
      const contents = this.containerContentItems(container)
      if (!contents.length) {
        // 拿到了窗口但内容为空：真空桶。保留原记录，不做空读重读（省时间）。
        this.trace('decision', 'unlocated_search_empty_barrel', {
          chest: this.describeChest(chest),
          decision: '木桶实测为空，保留原记录跳过'
        })
        return { refused: false, empty: true, timeout: false, moved: 0 }
      }

      const available = this.countContainerItem(container, allocation.itemKey)
      const toTake = Math.min(remaining, available)
      let moved = 0
      if (toTake > 0) {
        moved = await this.tryWithdrawExactFrom(container, allocation.itemKey, toTake)
        await sleep(Math.max(0, Number(this.config.timing.containerSettleMs ?? 250)))
        this.trace('take', 'unlocated_search_take', {
          chest: this.describeChest(chest),
          planned: toTake,
          moved,
          remaining: remaining - moved,
          contents: this.snapshotContainerContents(container),
          decision: `搜到目标物品 ${available} 个，本次取 ${moved} 个`
        })
      }

      // 读到可信内容就按实测刷新该桶记录（先取后刷，写入的是取完后的真实剩余量）。
      this.refreshChestSnapshot(chest, container)
      this.trace('record', 'unlocated_search_refresh', {
        chest: this.describeChest(chest),
        contents: this.snapshotContainerContents(container),
        decision: '已用实测内容刷新该木桶的本地槽位记录'
      })
      return { refused: false, empty: false, timeout: false, moved }
    } finally {
      this.closeContainerQuietly(container)
    }
  }

  // 账本有余额、但没有任何木桶槽位记录的散装物品：登记库存异常供 Web 管理页展示与对账，
  // 同 owner+itemKey 只保留一条 open，避免重复刷屏。
  reportMissingLooseRecord (allocation, itemInfo) {
    try {
      const ownerUuid = allocation.ownerUuid
      if (!ownerUuid) return
      if (typeof this.db.addInventoryMismatch !== 'function' || typeof this.db.hasOpenInventoryMismatch !== 'function') return
      this.trace('decision', 'unlocated_recorded', {
        item: itemInfo.displayName || itemInfo.itemKey,
        keyTail: shortKey(itemInfo.itemKey),
        ownerUuid,
        amount: allocation.amount,
        decision: '账本有库存但无位置记录：登记库存异常，请管理员 !同步 对账'
      })
      if (this.db.hasOpenInventoryMismatch(ownerUuid, itemInfo.itemKey)) return
      this.db.addInventoryMismatch(
        'missing',
        ownerUuid,
        allocation.ownerUsername || '',
        itemInfo,
        allocation.amount,
        '取货时发现：账本有库存但木桶位置记录中没有任何实物（可能被人工移动或账实漂移）；请择机 !同步 对账。'
      )
    } catch (error) {
      this.debug(`report missing loose record failed: ${error?.message || error}`)
    }
  }

  resolveStuckShulkerRepackSelfHeal (pending, sourceKey) {
    if (pending?.state !== 'physical_changed' || typeof this.db.resolveStuckShulkerRepack !== 'function') return false
    try {
      const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      const resolved = this.db.resolveStuckShulkerRepack(this.botId, held, `extraction self-heal, old_box=${sourceKey}`)
      if (!resolved) return false
      console.warn(`[shulker-repack-recovery] auto-resolved stuck physical_changed record before extraction: bot=${this.botId} old=${pending.oldBoxItemKey} committed=${resolved.committed}${resolved.committed ? '' : `, cleared with mismatch (${resolved.error})`}`)
      return true
    } catch (error) {
      logLocalError('shulker-repack-self-heal', error, {
        botId: this.botId,
        oldBoxItemKey: pending.oldBoxItemKey
      }, { directory: this.config.localLogDirectory })
      return false
    }
  }

  async withdrawFromShulkerBoxes (allocation) {
    const targetItem = this.db.getItemByKey(allocation.itemKey)
    if (!targetItem) return { withdrawn: [], missing: [{ ...allocation }] }
    if (!allocation.ownerUuid) throw new Error('拆潜影盒取货缺少库存所有者。')

    const sourceKey = String(allocation.sourceShulkerItemKey || '')
    const sourceItem = this.db.getItemByKey(sourceKey)
    if (!sourceKey || !sourceItem) {
      return { withdrawn: [], missing: [{ ...targetItem, amount: Number(allocation.amount || 0) }] }
    }

    let remaining = Number(allocation.amount || 0)
    let boxesRemaining = Math.max(0, Number(allocation.sourceBoxCount || 0))
    const withdrawn = []
    // 背包装不下目标物品或放不下源盒时停止拆盒，剩余按"背包已满"计入缺失（不修账）
    let inventoryFull = false

    this.trace('plan', 'shulker_extract_start', {
      item: targetItem.displayName || allocation.itemKey,
      key: allocation.itemKey,
      keyTail: shortKey(allocation.itemKey),
      need: Number(allocation.amount || 0),
      boxes: boxesRemaining,
      sourceBox: {
        name: sourceItem.displayName || sourceKey,
        key: sourceKey,
        keyTail: shortKey(sourceKey)
      },
      ownerUuid: allocation.ownerUuid || '',
      perBox: Number(allocation.sourceContainedAmountPerBox || 0),
      decision: `盒装取货：拆${sourceItem.displayName || sourceKey}（短码 ${shortKey(sourceKey)}）×${boxesRemaining} 取 ${allocation.amount} 个${targetItem.displayName || allocation.itemKey}`
    })

    // 同一个取盒流程可能换源盒 key 执行多次：计划源盒在木桶记录里没有实物时，
    // 会回退到其他"账本有、木桶也有记录"的同内容盒子，避免账实漂移直接导致取货失败。
    const extractFromSource = async (sourceKey, sourceItem) => {
      const slots = this.db.listSlotsForItemKey(sourceKey)
      const chestGroups = this.groupSlotsForWithdrawal(slots)

      this.debug(`shulker extract ${targetItem.displayName || allocation.itemKey} need=${remaining} boxes=${boxesRemaining} source=${sourceItem.displayName || sourceKey}`)
      this.trace('locate', 'shulker_box_locate', {
        sourceBox: { name: sourceItem.displayName || sourceKey, key: sourceKey, keyTail: shortKey(sourceKey) },
        need: remaining,
        boxes: boxesRemaining,
        barrelPlan: chestGroups.map(group => ({
          chest: group.chestId,
          recordedBoxes: group.recordedAmount,
          slots: group.slots.map(row => row.slot)
        })),
        decision: chestGroups.length
          ? `账本显示源盒放在 ${chestGroups.length} 个木桶，依次去取盒`
          : '账本显示有源盒，但没有任何木桶位置记录（盒子可能被人工移动）'
      })

      for (const group of chestGroups) {
        if (remaining <= 0 || boxesRemaining <= 0) break
        if (inventoryFull) break
        const slot = group.slots[0]
        const chest = { chestId: group.chestId, x: slot.x, y: slot.y, z: slot.z, blockName: slot.blockName }

        while (remaining > 0 && boxesRemaining > 0) {
          // 容量兜底：目标物品装不下、或没有格子放源盒（潜影盒带指纹基本不可并堆）
          // 时停止拆盒——继续拿盒只会以"取潜影盒失败，实际取出 0 个"整单报错。
          if (this.inventoryFreeCapacityForItem(allocation.itemKey) <= 0 ||
              this.inventoryFreeCapacityForItem(sourceKey) < 1) {
            inventoryFull = true
            this.debug(`shulker extract ${targetItem.displayName || allocation.itemKey} 背包已满，停止拆盒 remaining=${remaining}`)
            this.trace('decision', 'shulker_extract_inventory_full', {
              item: targetItem.displayName || allocation.itemKey,
              keyTail: shortKey(allocation.itemKey),
              sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
              remaining,
              decision: `背包已满（目标物品或源盒都放不下），停止拆盒，剩余 ${remaining} 个按背包已满计入缺失`
            })
            break
          }
          const sourceBox = await this.takeOneShulkerFromChest(chest, sourceKey, group.slots.map(row => row.slot))
          if (!sourceBox) {
            this.trace('decision', 'shulker_take_box_none', {
              chest: this.describeChest(chest),
              sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey), name: sourceItem.displayName || sourceKey },
              boxesLeft: boxesRemaining,
              decision: '木桶里实际没有该源盒，已刷新桶记录，停止从该桶取盒'
            })
            break
          }
          boxesRemaining--
          this.trace('locate', 'shulker_take_box', {
            chest: this.describeChest(chest),
            sourceBox: {
              name: sourceItem.displayName || sourceKey,
              key: sourceKey,
              keyTail: shortKey(sourceKey),
              slot: sourceBox.slot
            },
            boxesLeft: boxesRemaining,
            decision: `从 ${this.describeChest(chest)} 取出 1 个源盒（短码 ${shortKey(sourceKey)}）到手上`
          })

          let quickWindow = null
          let boxToReturn = sourceBox
          let returned = false
          let repackState = ''
          try {
            this.trace('open', 'shulker_click_open', {
              sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey), slot: sourceBox.slot },
              decision: '源盒留在背包格，光标为空右键点击盒子快捷开盒'
            })
            // 服务器偶尔会在快捷开盒后返回空窗口（数量 0），与盒内应有物品对不上；
            // 关窗重开最多 quickShulkerOpenAttempts 次，仍为 0 才跳过该盒。
            let available = 0
            const maxOpenAttempts = Math.max(1, Number(this.config.timing?.quickShulkerOpenAttempts ?? 3))
            for (let openAttempt = 1; openAttempt <= maxOpenAttempts; openAttempt++) {
              quickWindow = await this.openQuickShulkerWindow(sourceKey)
              available = await this.waitForContainerItemCount(quickWindow, allocation.itemKey)
              if (available > 0) break
              this.debug(`quick shulker window empty (attempt ${openAttempt}/${maxOpenAttempts}) source=${sourceKey} target=${allocation.itemKey}`)
              this.trace('open', 'shulker_open_empty_retry', {
                attempt: openAttempt,
                max: maxOpenAttempts,
                sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
                contents: this.snapshotContainerContents(quickWindow),
                decision: `第 ${openAttempt} 次开盒没读到目标物品（疑似卡顿空窗口），关窗重开`
              })
              quickWindow.close()
              quickWindow = null
              if (openAttempt < maxOpenAttempts) await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
            }
            if (available <= 0) {
              console.warn(`[shulker-extract] 快捷开盒连续 ${maxOpenAttempts} 次读取数量为 0：source=${sourceKey}，本次跳过该盒。`)
              this.trace('decision', 'shulker_open_empty_skip', {
                attempts: maxOpenAttempts,
                sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
                decision: `连续 ${maxOpenAttempts} 次开盒都读不到目标物品，跳过该盒放回`
              })
            } else {
              this.trace('open', 'shulker_open', {
                sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey), name: sourceItem.displayName || sourceKey },
                targetAvailable: available,
                contents: this.snapshotContainerContents(quickWindow),
                decision: `打开盒子：目标物品 ${available} 个，本次计划取 ${Math.min(remaining, available)} 个`
              })
            }
            const toTake = Math.min(remaining, available)
            this.trace('decision', 'shulker_take_plan', {
              sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
              available,
              need: remaining,
              toTake,
              decision: `盒内有 ${available} 个，计划取 ${toTake} 个`
            })
            if (toTake > 0) {
              const pending = this.db.getShulkerRepackRecovery?.(this.botId)
              if (pending) {
                if (pending.state === 'prepared' && pending.oldBoxItemKey === sourceKey) {
                  this.db.clearShulkerRepackRecovery(this.botId)
                  console.warn(`[shulker-repack-recovery] cleared unchanged stale prepared record before retry: bot=${this.botId} old=${sourceKey}`)
                  this.trace('decision', 'repack_stale_prepared_cleared', {
                    oldBox: sourceKey,
                    decision: '发现上次遗留的未变化 prepared 记录且源盒相同，清空后重试拆盒'
                  })
                } else if (this.resolveStuckShulkerRepackSelfHeal(pending, sourceKey)) {
                  // 上次换盒已实际完成，这里补账后继续本次拆盒
                  this.trace('decision', 'repack_self_heal', {
                    oldBox: pending.oldBoxItemKey,
                    decision: '上次换盒实际已完成，自动补账后继续本次拆盒'
                  })
                } else {
                  const conflict = new Error(`bot ${this.botId} has an unresolved shulker repack recovery`)
                  logLocalError('shulker-repack-conflict', conflict, {
                    botId: this.botId,
                    sourceChestId: chest.chestId,
                    sourceKey,
                    pendingState: pending.state,
                    pendingOldBoxItemKey: pending.oldBoxItemKey,
                    ownerUuid: allocation.ownerUuid
                  }, { directory: this.config.localLogDirectory })
                  console.error(`[shulker-repack-recovery] unresolved record blocks extraction; returning box and continuing: bot=${this.botId} state=${pending.state} old=${pending.oldBoxItemKey}`)
                  this.trace('decision', 'repack_conflict_return_box', {
                    pendingState: pending.state,
                    oldBox: pending.oldBoxItemKey,
                    decision: '存在未决的重打包恢复记录，为安全起见放回盒子跳过本次拆盒'
                  })
                  quickWindow.close()
                  quickWindow = null
                  boxToReturn = this.findInventoryItemByKey(sourceKey) || sourceBox
                  await this.returnShulkerToChest(chest, boxToReturn)
                  returned = true
                  continue
                }
              }
              this.db.beginShulkerRepackRecovery(this.botId, {
                ownerUuid: allocation.ownerUuid,
                ownerUsername: allocation.ownerUsername || '',
                oldBoxItemKey: sourceKey,
                sourceChestId: chest.chestId,
                targetItem,
                beforeAmount: available,
                requestedAmount: toTake,
                message: `source_chest=${chest.chestId}, old_box=${sourceKey}`
              })
              repackState = 'prepared'
              this.trace('ledger', 'repack_prepared', {
                oldBox: sourceKey,
                chest: this.describeChest(chest),
                beforeAmount: available,
                requestedAmount: toTake,
                decision: '已写入重打包恢复记录（防断线丢账），开始从盒内取物'
              })
            }
            // 拆盒前的背包基线：恢复复核时用来判断目标物品是否真的进了背包
            const inventoryBaseline = this.inventoryCountByItemKey(allocation.itemKey)
            let moved = await this.tryWithdrawExactFrom(quickWindow, allocation.itemKey, toTake)
            this.debug(`shulker extract open source=${sourceKey} available=${available} moved=${moved} remaining=${remaining}`)
            this.trace('take', 'shulker_take_result', {
              sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
              planned: toTake,
              moved,
              remainingBefore: remaining,
              decision: moved > 0
                ? `从盒内取出 ${moved}/${toTake} 个${targetItem.displayName || allocation.itemKey}`
                : '点击后没有确认到物品从盒内进入背包'
            })

            // 连续开盒读到 0 时 quickWindow 已在上面重开循环里关掉置空，这里不能再重复关
            if (quickWindow) {
              quickWindow.close()
              quickWindow = null
            }
            await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))

            if (moved <= 0) {
              if (repackState) this.db.clearShulkerRepackRecovery(this.botId)
              repackState = ''
              boxToReturn = this.findInventoryItemByKey(sourceKey) || sourceBox
              // 盒里实际取不到目标物品：用手上盒子的真实 NBT 重建这个盒的内容记录，
              // 让记录与实物对齐，后续任务不再按旧记录扑空；
              // 若只是卡顿误读（盒里其实有），NBT 同样能还原正确记录，不会误清。
              this.trace('decision', 'shulker_take_none_return_box', {
                sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
                boxContents: this.snapshotShulkerContents(this.catalog.fromPrismarineItem(boxToReturn)),
                decision: '盒内取物失败：按盒子真实 NBT 重建内容记录后原样放回木桶'
              })
              this.syncShulkerBoxContents(boxToReturn)
              await this.returnShulkerToChest(chest, boxToReturn)
              returned = true
              continue
            }

            boxToReturn = await this.waitForChangedShulkerItem(
              sourceKey,
              sourceItem.itemId,
              allocation.itemKey,
              Math.max(0, Number(available) - Number(moved))
            )
            let newBox = this.catalog.fromPrismarineItem(boxToReturn)
            this.trace('result', 'shulker_box_after', {
              oldBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
              newBox: { key: newBox.itemKey, keyTail: shortKey(newBox.itemKey), name: newBox.displayName || newBox.itemId },
              contents: this.snapshotShulkerContents(newBox),
              decision: `取完后盒子内容已变化（新短码 ${shortKey(newBox.itemKey)}），按 NBT 校验剩余数量`
            })
            try {
              this.verifyShulkerExtraction(newBox, allocation.itemKey, available, moved)
            } catch (verifyError) {
              // NBT 校验失败不代表实物一定出错：关所有容器、重开该盒、按窗口实物
              // 复核盒内数量与背包到手量，能对账就按复核结果继续，救不回来才报错。
              const recovery = await this.recoverShulkerExtractionMismatch({
                chest,
                allocation,
                targetItem,
                sourceKey,
                sourceItem,
                available,
                planned: toTake,
                moved,
                inventoryBaseline
              })
              if (!recovery.resolved) {
                // 确定异常：把背包中的该批物品放进木桶空槽位并刷新桶记录（库存与 Web 同步）
                await this.dumpInventoryItemsToChest(chest, allocation, recovery.reason)
                throw verifyError
              }
              moved = recovery.moved
              boxToReturn = recovery.boxToReturn
              newBox = recovery.newBox
            }

            this.db.markShulkerRepackPhysicalChange(
              this.botId,
              { ...newBox, amount: 1 },
              [{ ...targetItem, amount: moved }],
              `source_chest=${chest.chestId}, old_box=${sourceKey}, new_box=${newBox.itemKey}`
            )
            repackState = 'physical_changed'

            await this.returnShulkerToChest(chest, boxToReturn)
            returned = true
            this.db.commitShulkerRepackRecovery(this.botId)
            repackState = ''
            this.trace('ledger', 'repack_committed', {
              oldBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
              newBox: { key: newBox.itemKey, keyTail: shortKey(newBox.itemKey) },
              moved,
              decision: `盒子已放回木桶，账本换盒并扣除 ${moved} 个目标物品`
            })

            withdrawn.push({ ...targetItem, amount: moved })
            remaining -= moved
          } catch (error) {
            this.trace('error', 'shulker_error', {
              sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
              chest: this.describeChest(chest),
              repackState,
              returned,
              message: error?.message || String(error),
              decision: '拆盒过程出错，按恢复流程兜底后终止/继续'
            })
            if (repackState || /shulker repack recovery/i.test(String(error?.message || ''))) {
              logLocalError('shulker-repack-error', error, {
                botId: this.botId,
                sourceChestId: chest.chestId,
                sourceKey,
                targetKey: allocation.itemKey,
                recoveryState: repackState
              }, { directory: this.config.localLogDirectory })
            }
            if (quickWindow) {
              try { quickWindow.close() } catch {}
              quickWindow = null
            }
            if (/already has a pending shulker repack recovery|unresolved shulker repack recovery/i.test(String(error?.message || ''))) {
              const recoverableBox = this.findInventoryShulker(sourceItem.itemId, sourceKey) || boxToReturn
              try {
                await this.returnShulkerToChest(chest, recoverableBox)
                returned = true
                continue
              } catch (returnError) {
                error.message += `；潜影盒冲突后放回失败：${returnError.message}`
              }
            }
            if (repackState === 'prepared') {
              const changedBox = this.findInventoryShulker(sourceItem.itemId, sourceKey) || boxToReturn
              try {
                const recovery = this.db.getShulkerRepackRecovery(this.botId)
                if (recovery) {
                  this.resolvePreparedShulkerRepackFromItem(recovery, changedBox)
                  repackState = this.db.getShulkerRepackRecovery(this.botId)?.state || ''
                }
              } catch (recoveryError) {
                error.message += `；潜影盒重打包状态记录失败：${recoveryError.message}`
              }
            }
            if (!returned) {
              const recoverableBox = this.findInventoryShulker(sourceItem.itemId, sourceKey) || boxToReturn
              try {
                await this.returnShulkerToChest(chest, recoverableBox)
              } catch (returnError) {
                error.message += `；潜影盒放回失败：${returnError.message}`
              }
            }
            throw error
          }
        }
      }

      return chestGroups.length
    }

    const plannedGroupCount = await extractFromSource(sourceKey, sourceItem)

    if (remaining > 0) {
      // 计划源盒没取够：按账本内容索引找同属该所有者、含目标物品的其他盒子，
      // 且必须真的有木桶位置记录，逐个回退直至取够或用尽。
      const fallbackRows = (typeof this.db.getOwnerShulkersContainingItemKey === 'function'
        ? this.db.getOwnerShulkersContainingItemKey(allocation.ownerUuid, allocation.itemKey)
        : []) || []
      this.trace('decision', 'shulker_fallback_search', {
        sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
        remaining,
        fallbackCandidates: fallbackRows.length,
        decision: `计划源盒没取够（还差 ${remaining}），在账本里找含该物品的其他盒子回退`
      })
      for (const row of fallbackRows) {
        if (remaining <= 0) break
        if (inventoryFull) break
        const fallbackKey = String(row.shulkerItemKey || '')
        if (!fallbackKey || fallbackKey === sourceKey) continue
        if (!this.db.listSlotsForItemKey(fallbackKey).length) continue
        const fallbackItem = this.db.getItemByKey(fallbackKey)
        if (!fallbackItem) continue
        const perBox = Math.max(1, Number(row.containedAmount || 0))
        const extraBoxes = Math.min(Math.max(0, Number(row.shulkerAmount || 0)), Math.ceil(remaining / perBox))
        if (extraBoxes <= 0) continue
        boxesRemaining += extraBoxes
        console.warn(`[shulker-extract] 计划源盒 ${sourceKey}（${sourceItem.displayName || sourceKey}）在木桶记录中无实物，回退改用 ${fallbackKey}（${fallbackItem.displayName || fallbackKey}）`)
        this.trace('decision', 'shulker_source_fallback', {
          from: { key: sourceKey, keyTail: shortKey(sourceKey) },
          to: { key: fallbackKey, keyTail: shortKey(fallbackKey), name: fallbackItem.displayName || fallbackKey },
          extraBoxes,
          perBox,
          decision: `源盒记录无实物，改用同内容盒子（短码 ${shortKey(fallbackKey)}）×${extraBoxes} 继续取`
        })
        await extractFromSource(fallbackKey, fallbackItem)
      }
      if (plannedGroupCount === 0) this.reportMissingSourceBoxRecord(allocation, sourceItem)
    }

    this.trace('result', 'shulker_extract_result', {
      item: targetItem.displayName || allocation.itemKey,
      withdrawn: withdrawn.reduce((sum, item) => sum + Number(item.amount || 0), 0),
      missing: Math.max(0, remaining),
      inventoryFull,
      decision: remaining > 0
        ? (inventoryFull
            ? `背包已满，仍有 ${remaining} 个装不下，按背包已满计入缺失（不修账）`
            : `盒装取货结束，仍有 ${remaining} 个没取到`)
        : '盒装取货结束，数量已取够'
    })

    return {
      withdrawn: this.mergeItems(withdrawn),
      missing: remaining > 0
        ? [{ ...targetItem, amount: remaining, ...(inventoryFull ? { inventoryFull: true } : {}) }]
        : []
    }
  }

  syncShulkerBoxContents (item) {
    try {
      const normalized = this.catalog.fromPrismarineItem(item)
      if (!this.catalog.isShulkerBox(normalized.itemId)) return
      this.db.upsertItem(normalized)
    } catch (error) {
      this.debug(`sync shulker contents failed: ${error?.message || error}`)
    }
  }

  // 账本显示所有者拥有某 key 的潜影盒，但木桶位置记录里一个都没有（典型：盒子被人工移动）。
  // 记一条库存异常（同一所有者+盒子 key 只记一条 open），供管理员在 Web 管理页看到并择机 !同步 对账。
  reportMissingSourceBoxRecord (allocation, sourceItem) {
    try {
      if (typeof this.db.addInventoryMismatch !== 'function' || typeof this.db.getBalance !== 'function') return
      const balance = Number(this.db.getBalance(allocation.ownerUuid, sourceItem.itemKey) || 0)
      if (balance <= 0) return
      if (typeof this.db.hasOpenInventoryMismatch === 'function' &&
          this.db.hasOpenInventoryMismatch(allocation.ownerUuid, sourceItem.itemKey)) return
      this.db.addInventoryMismatch(
        'missing',
        allocation.ownerUuid,
        allocation.ownerUsername || '',
        sourceItem,
        balance,
        '取货时发现：账本显示该潜影盒有库存，但木桶位置记录中没有任何实物（可能被人工移动或记录漂移）；系统已自动改用其他盒子取货。请择机执行 !同步 对账。'
      )
      console.warn(`[shulker-extract] 账本有 ${balance} 个 ${sourceItem.displayName || sourceItem.itemKey}（${sourceItem.itemKey}）但木桶记录中无实物，已记入库存异常。`)
    } catch (error) {
      this.debug(`report missing source box failed: ${error?.message || error}`)
    }
  }

  async takeOneShulkerFromChest (chest, itemKey, preferredSlots = []) {
    const container = await this.openContainerAt(chest)
    let moved = 0
    try {
      const available = this.countContainerItem(container, itemKey)
      this.trace('open', 'shulker_source_barrel_open', {
        chest: this.describeChest(chest),
        sourceBox: { key: itemKey, keyTail: shortKey(itemKey) },
        availableBoxes: available,
        contents: this.snapshotContainerContents(container),
        decision: available > 0
          ? `打开木桶：里面有 ${available} 个该源盒`
          : '打开木桶：里面没有该源盒'
      })
      if (available <= 0) {
        this.refreshChestSnapshot(chest, container)
        return null
      }
      moved = await this.tryWithdrawExactFrom(container, itemKey, 1, preferredSlots)
      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
      this.refreshChestSnapshot(chest, container)
    } finally {
      this.closeContainerQuietly(container)
      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
    }

    if (moved !== 1) {
      // 背包满时给直白的原因，而不是"实际取出 0 个"这种费解的报错
      const inventoryFull = this.inventoryFreeCapacityForItem(itemKey) < 1
      this.trace('error', 'shulker_take_box_failed', {
        chest: this.describeChest(chest),
        sourceBox: { key: itemKey, keyTail: shortKey(itemKey) },
        moved,
        inventoryFull,
        decision: inventoryFull
          ? '背包已满且无同 key 可并堆位，放不下潜影盒'
          : '取盒点击未确认成功'
      })
      throw new Error(inventoryFull
        ? `机器人背包已满，没有空槽从 ${this.describeChest(chest)} 取潜影盒。`
        : `从 ${this.describeChest(chest)} 取潜影盒失败，实际取出 ${moved} 个。`)
    }
    const item = await this.waitForInventoryItemByKey(itemKey)
    if (!item) {
      this.trace('error', 'shulker_take_box_failed', {
        chest: this.describeChest(chest),
        sourceBox: { key: itemKey, keyTail: shortKey(itemKey) },
        decision: '点击已确认，但客户端背包没有收到该盒子'
      })
      throw new Error(`已从 ${this.describeChest(chest)} 取出潜影盒，但客户端背包没有收到该物品。`)
    }
    return item
  }

  async returnShulkerToChest (chest, item) {
    if (!item) throw new Error('机器人背包中找不到待放回的潜影盒。')
    const normalized = this.catalog.fromPrismarineItem(item)
    if (!this.catalog.isShulkerBox(normalized.itemId)) throw new Error(`待放回物品不是潜影盒：${normalized.displayName}`)

    this.trace('return', 'shulker_return_start', {
      chest: this.describeChest(chest),
      box: { key: normalized.itemKey, keyTail: shortKey(normalized.itemKey), name: normalized.displayName || normalized.itemId },
      boxContents: this.snapshotShulkerContents(normalized),
      decision: `把盒子（短码 ${shortKey(normalized.itemKey)}）放回 ${this.describeChest(chest)}`
    })
    const container = await this.openContainerAt(chest)
    try {
      let moved = await this.tryDepositInto(container, item)
      if (moved <= 0) {
        moved = await this.waitForInventorySlotDecrease(item.slot, normalized.itemId, item.count, {
          intervalMs: 50,
          timeoutMs: Math.max(500, Number(this.config.timing?.inventoryUpdateTimeoutMs || 2000))
        })
      }
      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
      this.refreshChestSnapshot(chest, container)
      if (moved !== 1) {
        this.trace('error', 'shulker_return_failed', {
          chest: this.describeChest(chest),
          box: { keyTail: shortKey(normalized.itemKey) },
          moved,
          decision: '放回点击未确认成功，盒子可能还在背包'
        })
        throw new Error(`放回 ${this.describeChest(chest)} 失败，实际放入 ${moved} 个潜影盒。`)
      }
      this.trace('return', 'shulker_return_done', {
        chest: this.describeChest(chest),
        box: { keyTail: shortKey(normalized.itemKey) },
        decision: '盒子已放回木桶（放回后的桶内内容见同 traceId 的 chest_record_refresh 事件）'
      })
      return normalized
    } finally {
      this.closeContainerQuietly(container)
      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
    }
  }

  findInventoryItemByKey (itemKey) {
    return this.bot.inventory.items().find(item => this.catalog.fromPrismarineItem(item).itemKey === itemKey) || null
  }

  async waitForInventoryItemByKey (itemKey, timeoutMs = null) {
    const timeout = Math.max(500, Number(timeoutMs ?? this.config.timing?.inventoryUpdateTimeoutMs ?? 2000))
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const item = this.findInventoryItemByKey(itemKey)
      if (item) return item
      await sleep(50)
    }
    return this.findInventoryItemByKey(itemKey)
  }

  async waitForInventorySlotDecrease (slot, itemId, before, options = {}) {
    if (!Number.isInteger(slot)) return 0
    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? this.config.timing?.inventoryUpdateTimeoutMs ?? 2000))
    const intervalMs = Math.max(10, Number(options.intervalMs ?? 50))
    const startingCount = Math.max(0, Number(before || 0))
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const current = this.bot.inventory.items().find(entry => entry.slot === slot) || null
      if (!current) return startingCount
      const normalized = this.catalog.fromPrismarineItem(current)
      if (normalized.itemId !== itemId) return startingCount
      const moved = Math.max(0, startingCount - Number(current.count || 0))
      if (moved > 0) return moved
      await sleep(intervalMs)
    }
    return 0
  }

  findAnyInventoryShulker () {
    return this.bot.inventory.items().find(item => {
      const normalized = this.catalog.fromPrismarineItem(item)
      return this.catalog.isShulkerBox(normalized.itemId)
    }) || null
  }

  findInventoryShulker (itemId, preferredItemKey = '') {
    const candidates = this.bot.inventory.items().filter(item => {
      const normalized = this.catalog.fromPrismarineItem(item)
      return normalized.itemId === itemId && this.catalog.isShulkerBox(normalized.itemId)
    })
    return candidates.find(item => this.catalog.fromPrismarineItem(item).itemKey !== preferredItemKey) ||
      candidates.find(item => this.catalog.fromPrismarineItem(item).itemKey === preferredItemKey) || null
  }

  async waitForChangedShulkerItem (oldItemKey, itemId, targetItemKey = '', expectedTargetAmount = null) {
    const timeoutMs = Math.max(500, Number(this.config.timing?.inventoryUpdateTimeoutMs || 2000))
    const deadline = Date.now() + timeoutMs
    let changedItem = null
    while (Date.now() < deadline) {
      const item = this.findInventoryShulker(itemId, oldItemKey)
      if (item && this.catalog.fromPrismarineItem(item).itemKey !== oldItemKey) {
        changedItem = item
        if (!targetItemKey || expectedTargetAmount === null) return item
        const normalized = this.catalog.fromPrismarineItem(item)
        const amount = this.catalog.extractShulkerContents(normalized)
          .filter(entry => entry.item.itemKey === targetItemKey)
          .reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
        if (amount === expectedTargetAmount) return item
      }
      await sleep(50)
    }
    if (changedItem) return changedItem
    throw new Error('快捷潜影盒内容已取出，但客户端没有收到盒子内容更新。')
  }

  verifyShulkerExtraction (newBox, targetItemKey, before, moved) {
    if (!newBox?.itemKey) throw new Error('无法读取变化后的潜影盒指纹。')
    const after = this.catalog.extractShulkerContents(newBox)
      .filter(entry => entry.item.itemKey === targetItemKey)
      .reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
    const expected = Math.max(0, Number(before || 0) - Number(moved || 0))
    if (after !== expected) {
      throw new Error(`潜影盒内容校验失败：目标物品应剩 ${expected} 个，实际索引为 ${after} 个。`)
    }
  }

  // 快捷开盒手势：光标为空时右键点击背包内的潜影盒（与玩家在物品栏 GUI 里
  // 空手右键盒子相同），由服务器的快捷开盒插件打开盒子窗口；
  // 关闭用 window.close()（即按 E/ESC 的关闭容器包）。
  async openQuickShulkerWindow (expectedItemKey = '') {
    if (this.bot.currentWindow) {
      this.bot.closeWindow(this.bot.currentWindow)
      await sleep(150)
    }
    const box = (expectedItemKey && this.findInventoryItemByKey(expectedItemKey)) ||
      this.findAnyInventoryShulker()
    if (!box) throw new Error('背包中找不到可快捷打开的潜影盒。')
    await this.clearCursorBeforeClick()
    const normalized = this.catalog.fromPrismarineItem(box)
    this.debug(`quick shulker click ${normalized.displayName || normalized.itemId} key=${normalized.itemKey.slice(-6)} slot=${box.slot}`)

    const timeoutMs = Math.max(500, Number(this.config.timing?.openContainerTimeoutMs || 8000))
    for (let attempt = 1; attempt <= 2; attempt++) {
      const windowPromise = this.waitForWindowOpen(timeoutMs)
      // 空光标右键背包格：普通点击 mode 0 + 右键 button 1
      await this.bot.clickWindow(box.slot, 1, 0)
      const window = await windowPromise
      if (window) {
        if (!this.isQuickShulkerWindow(window)) {
          try { window.close() } catch {}
          throw new Error(`快捷开盒返回了非潜影盒窗口：type=${window.type || 'unknown'} slots=${window.inventoryStart}`)
        }
        return window
      }
      // 手势没被服务器识别时，右键会把盒子拿到光标上；点回原格放回后重试
      if (this.bot.inventory?.selectedItem) {
        this.trace('decision', 'shulker_click_no_window_return_box', {
          sourceBox: { key: normalized.itemKey, keyTail: shortKey(normalized.itemKey), slot: box.slot },
          attempt,
          decision: '右键后没有收到潜影盒窗口，盒子可能停在光标上，先放回原格再重试'
        })
        await this.bot.clickWindow(box.slot, 0, 0)
        await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
      }
      if (attempt < 2) await sleep(250)
    }
    throw new Error('在背包内右键潜影盒后，没有收到潜影盒窗口。')
  }

  async clearCursorBeforeClick () {
    const cursor = this.bot.inventory?.selectedItem
    if (!cursor) return
    const slots = this.bot.inventory.slots || []
    const emptySlot = slots.findIndex((item, slot) => slot >= 9 && slot < 45 && !item)
    if (emptySlot < 0) throw new Error('光标上残留物品且背包没有空位，无法快捷打开潜影盒。')
    this.trace('decision', 'shulker_click_cursor_clear', {
      cursorItem: { name: cursor.name || cursor.itemId || 'unknown', slot: emptySlot },
      decision: '点击盒子前光标不为空，先把光标物品放回背包空格'
    })
    await this.bot.clickWindow(emptySlot, 0, 0)
    await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
  }

  // 快捷开盒取物后的 NBT 校验失败，先别急着报错：关闭所有容器，重新打开该盒，
  // 以服务器窗口实物复核盒内数量，并对照拆盒前的背包基线核对到手量；
  // 取多了放回盒内、取少了补取，复核闭合后按真实数量继续；仍对不上账才算确定异常。
  async recoverShulkerExtractionMismatch ({ allocation, sourceKey, sourceItem, available, planned, inventoryBaseline }) {
    const settleMs = Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250))
    this.trace('decision', 'shulker_verify_mismatch_recover', {
      sourceBox: { key: sourceKey, keyTail: shortKey(sourceKey) },
      available,
      planned,
      decision: '盒内容 NBT 校验失败：关闭所有容器后重新打开该盒，按窗口实物复核'
    })
    try {
      // 1. 关闭所有容器
      if (this.bot.currentWindow) {
        this.bot.closeWindow(this.bot.currentWindow)
        await sleep(settleMs)
      }
      // 2. 找到背包里的盒子（内容可能已变化）并重新打开
      let boxItem = this.findInventoryShulker(sourceItem.itemId, sourceKey)
      if (!boxItem) return { resolved: false, reason: '背包中找不到该潜影盒，无法复核' }
      const boxKey = this.catalog.fromPrismarineItem(boxItem).itemKey
      const window = await this.openQuickShulkerWindow(boxKey)
      try {
        await sleep(settleMs)
        // 3. 读盒内目标物品：实际取出 = 原有 - 盒内剩余
        const windowAmount = this.countContainerItem(window, allocation.itemKey)
        const actualMoved = Number(available) - windowAmount
        this.trace('open', 'shulker_recheck_window', {
          sourceBox: { key: boxKey, keyTail: shortKey(boxKey) },
          windowAmount,
          available,
          actualMoved,
          planned,
          decision: `重开盒复核：盒内剩 ${windowAmount}，实际取出 ${actualMoved}，本轮计划 ${planned}`
        })
        if (!(actualMoved >= 0 && actualMoved <= available)) {
          return { resolved: false, reason: `重开盒后数量对不上：盒内剩 ${windowAmount}，原记录 ${available}` }
        }
        // 4. 取多了：把多出的放回盒内（整格放回，最终以重读为准）
        if (actualMoved > planned) {
          const returnedBack = await this.returnItemsIntoContainer(window, allocation.itemKey, actualMoved - planned)
          this.trace('return', 'shulker_recheck_return_extra', {
            giveBack: actualMoved - planned,
            returnedBack,
            decision: `实际取出 ${actualMoved} 超过计划 ${planned}，已把多出的 ${returnedBack} 个放回盒内`
          })
        }
        // 5. 背包没到手：从盒内补取差额
        const expectedHold = inventoryBaseline + Math.min(actualMoved, planned)
        const holdNow = this.inventoryCountByItemKey(allocation.itemKey)
        if (holdNow < expectedHold) {
          const shortfall = expectedHold - holdNow
          const windowLeft = this.countContainerItem(window, allocation.itemKey)
          const topUp = Math.min(shortfall, windowLeft)
          if (topUp > 0) {
            const topped = await this.tryWithdrawExactFrom(window, allocation.itemKey, topUp)
            this.trace('take', 'shulker_recheck_topup', {
              shortfall,
              topUp,
              topped,
              decision: `背包到手量不足（差 ${shortfall}），已从盒内补取 ${topped} 个`
            })
          }
        }
        // 6. 最终对账：盒内剩余、实际取出、背包到手量必须闭合
        const finalWindowAmount = this.countContainerItem(window, allocation.itemKey)
        const finalMoved = Number(available) - finalWindowAmount
        const finalHold = this.inventoryCountByItemKey(allocation.itemKey)
        this.trace('result', 'shulker_recheck_final', {
          sourceBox: { key: boxKey, keyTail: shortKey(boxKey) },
          finalWindowAmount,
          finalMoved,
          finalHold,
          inventoryBaseline,
          planned,
          decision: `复核结束：盒内剩 ${finalWindowAmount}，实际取出 ${finalMoved}，背包 ${inventoryBaseline} → ${finalHold}`
        })
        if (!(finalMoved >= 0 && finalMoved <= available && finalMoved <= planned &&
              finalHold >= inventoryBaseline + finalMoved)) {
          return { resolved: false, reason: `复核后仍对不上账：盒内剩 ${finalWindowAmount}，背包 ${finalHold}（基线 ${inventoryBaseline}）` }
        }
        // 7. 关窗后重读盒子 NBT，与窗口读数一致才认可
        window.close()
        await sleep(settleMs)
        boxItem = this.findInventoryShulker(sourceItem.itemId, sourceKey)
        if (!boxItem) return { resolved: false, reason: '复核后背包中找不到该潜影盒' }
        const newBox = this.catalog.fromPrismarineItem(boxItem)
        const nbtAmount = this.catalog.extractShulkerContents(newBox)
          .filter(entry => entry.item.itemKey === allocation.itemKey)
          .reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
        if (nbtAmount !== finalWindowAmount) {
          return { resolved: false, reason: `复核后盒子 NBT 与窗口读数不一致：NBT ${nbtAmount}，窗口 ${finalWindowAmount}` }
        }
        this.trace('result', 'shulker_recheck_resolved', {
          sourceBox: { key: boxKey, keyTail: shortKey(boxKey) },
          newBox: { key: newBox.itemKey, keyTail: shortKey(newBox.itemKey) },
          moved: finalMoved,
          decision: `复核闭合：本轮实际取出 ${finalMoved} 个，按复核结果继续放回与记账`
        })
        return { resolved: true, moved: finalMoved, boxToReturn: boxItem, newBox }
      } finally {
        try { window.close() } catch {}
        await sleep(settleMs)
      }
    } catch (error) {
      return { resolved: false, reason: `复核流程出错：${error?.message || error}` }
    }
  }

  // 把背包内指定物品放进容器（整格 shift 放入），最多放 maxAmount 个，返回实际放入数
  async returnItemsIntoContainer (container, itemKey, maxAmount) {
    let remaining = Math.max(0, Number(maxAmount || 0))
    let returned = 0
    while (remaining > 0) {
      const item = this.bot.inventory.items()
        .find(entry => this.catalog.fromPrismarineItem(entry).itemKey === itemKey)
      if (!item) break
      const movedNow = await this.tryDepositInto(container, item)
      if (movedNow <= 0) break
      returned += movedNow
      remaining -= movedNow
      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
    }
    return returned
  }

  // 确定异常后的兜底：把背包中的该批目标物品放进木桶空槽位，并刷新桶记录，
  // 让库存记录（含 Web 展示）与实物同步，物品不再滞留在 bot 身上。
  async dumpInventoryItemsToChest (chest, allocation, reason = '') {
    try {
      const settleMs = Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250))
      const container = await this.openContainerAt(chest)
      try {
        const dumped = await this.returnItemsIntoContainer(container, allocation.itemKey, Infinity)
        await sleep(settleMs)
        this.refreshChestSnapshot(chest, container)
        this.trace('return', 'shulker_mismatch_dump_to_chest', {
          chest: this.describeChest(chest),
          item: { key: allocation.itemKey, keyTail: shortKey(allocation.itemKey), dumped },
          reason,
          decision: `确认异常：背包中该物品 ${dumped} 个已放进木桶空槽位并刷新库存记录（Web 同步）`
        })
        if (dumped > 0) this.debug(`shulker mismatch dumped ${dumped} ${allocation.itemKey} into chest ${chest.chestId}`)
      } finally {
        this.closeContainerQuietly(container)
        await sleep(settleMs)
      }
    } catch (error) {
      console.warn(`[shulker-recover] 异常物品回存木桶失败：${error?.message || error}`)
      this.trace('error', 'shulker_mismatch_dump_failed', {
        chest: chest?.chestId,
        reason: error?.message || String(error)
      })
    }
  }

  resolvePreparedShulkerRepackFromItem (recovery, item) {
    if (!recovery || recovery.state !== 'prepared') return recovery || null
    if (!item) throw new Error('找不到待恢复的潜影盒。')
    const normalized = this.catalog.fromPrismarineItem(item)
    if (!this.catalog.isShulkerBox(normalized.itemId)) throw new Error('待恢复物品不是潜影盒。')
    if (normalized.itemKey === recovery.oldBoxItemKey) {
      this.db.clearShulkerRepackRecovery(this.botId)
      return null
    }
    const targetItem = recovery.targetItem
    if (!targetItem?.itemKey) throw new Error('重打包恢复记录缺少目标物品。')
    const oldBox = this.db.getItemByKey(recovery.oldBoxItemKey)
    if (!oldBox) throw new Error(`找不到重打包恢复记录中的原潜影盒：${recovery.oldBoxItemKey}`)
    const moved = this.inferPreparedShulkerRepackAmount(recovery, oldBox, normalized)
    return this.db.markShulkerRepackPhysicalChange(
      this.botId,
      { ...normalized, amount: 1 },
      [{ ...targetItem, amount: moved }],
      `${recovery.message || ''}, recovery=inferred, new_box=${normalized.itemKey}`
    )
  }

  inferPreparedShulkerRepackAmount (recovery, oldBox, candidateBox) {
    const targetKey = recovery.targetItem?.itemKey
    const before = Number(recovery.beforeAmount || 0)
    const requested = Number(recovery.requestedAmount || 0)
    if (!targetKey || before <= 0 || requested <= 0) throw new Error('重打包恢复记录不完整。')

    const contentAmounts = box => new Map(this.catalog.extractShulkerContents(box)
      .map(entry => [entry.item.itemKey, Number(entry.amount || 0)]))
    const oldContents = contentAmounts(oldBox)
    const candidateContents = contentAmounts(candidateBox)
    const recordedBefore = Number(oldContents.get(targetKey) || 0)
    if (recordedBefore !== before) {
      throw new Error(`原潜影盒内容与恢复记录不一致：记录 ${before}，物品档案 ${recordedBefore}。`)
    }

    const after = Number(candidateContents.get(targetKey) || 0)
    const moved = before - after
    if (moved <= 0 || moved > requested) {
      throw new Error(`无法从盒内数量推断已取出物品：变化前 ${before}，当前 ${after}，计划最多 ${requested}。`)
    }

    const keys = new Set([...oldContents.keys(), ...candidateContents.keys()])
    keys.delete(targetKey)
    for (const key of keys) {
      if (Number(oldContents.get(key) || 0) !== Number(candidateContents.get(key) || 0)) {
        throw new Error('候选潜影盒除目标物品外还有其他内容变化。')
      }
    }
    return moved
  }

  resolvePreparedShulkerRepackFromInventory () {
    const recovery = this.db.getShulkerRepackRecovery(this.botId)
    if (!recovery || recovery.state !== 'prepared') return recovery || null
    const oldBox = this.db.getItemByKey(recovery.oldBoxItemKey)
    if (!oldBox) throw new Error(`找不到重打包恢复记录中的原潜影盒：${recovery.oldBoxItemKey}`)
    const candidates = this.bot.inventory.items().filter(item => {
      const normalized = this.catalog.fromPrismarineItem(item)
      return normalized.itemId === oldBox.itemId && this.catalog.isShulkerBox(normalized.itemId)
    })
    const unchanged = []
    const validChangedByKey = new Map()
    const rejected = []
    for (const candidate of candidates) {
      const normalized = this.catalog.fromPrismarineItem(candidate)
      if (normalized.itemKey === recovery.oldBoxItemKey) {
        unchanged.push(candidate)
        continue
      }
      try {
        this.inferPreparedShulkerRepackAmount(recovery, oldBox, normalized)
        if (!validChangedByKey.has(normalized.itemKey)) validChangedByKey.set(normalized.itemKey, candidate)
      } catch (error) {
        rejected.push(error.message)
      }
    }

    if (validChangedByKey.size === 1) {
      return this.resolvePreparedShulkerRepackFromItem(recovery, [...validChangedByKey.values()][0])
    }
    if (validChangedByKey.size > 1) {
      throw new Error('机器人背包中有多个可能的重打包潜影盒，无法安全判断；已保留恢复记录并停止后续任务。')
    }
    if (rejected.length) {
      throw new Error(`机器人背包中的同色潜影盒均不符合重打包记录；已保留恢复记录并停止后续任务。${rejected[0]}`)
    }
    if (unchanged.length) return this.resolvePreparedShulkerRepackFromItem(recovery, unchanged[0])
    console.warn(`[shulker-repack-recovery] prepared record is still pending; matching box is not currently in inventory, keeping the record and continuing bot tasks: bot=${this.botId} old=${recovery.oldBoxItemKey}`)
    return null
  }

  waitForWindowOpen (timeoutMs) {
    if (this.bot.currentWindow) return Promise.resolve(this.bot.currentWindow)
    return new Promise(resolve => {
      let timer
      const onOpen = window => {
        clearTimeout(timer)
        resolve(window)
      }
      this.bot.once('windowOpen', onOpen)
      timer = setTimeout(() => {
        this.bot.removeListener('windowOpen', onOpen)
        resolve(null)
      }, timeoutMs)
    })
  }

  isQuickShulkerWindow (window) {
    const type = String(window?.type || '')
    return Number(window?.inventoryStart) === 27 && /(?:^|:)shulker_box$/.test(type)
  }

  async waitForContainerItemCount (container, itemKey, timeoutMs = null) {
    const timeout = Math.max(500, Number(timeoutMs ?? this.config.timing?.inventoryUpdateTimeoutMs ?? 2000))
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const count = this.countContainerItem(container, itemKey)
      if (count > 0) return count
      await sleep(50)
    }
    const count = this.countContainerItem(container, itemKey)
    if (count <= 0) this.debug(`quick shulker target missing key=${itemKey.slice(-6)} contents=${this.containerContentsForDebug(container)}`)
    return count
  }

  containerContentsForDebug (container) {
    const contents = this.containerContentItems(container)
    if (!contents.length) return 'empty'
    return contents.map(item => {
      const normalized = this.catalog.fromPrismarineItem(item)
      return `${normalized.displayName || normalized.itemId} x${item.count} key=${normalized.itemKey.slice(-6)} slot=${item.slot}`
    }).join(', ')
  }

  groupSlotsForWithdrawal (slots) {
    const groups = new Map()
    for (const slot of slots) {
      let group = groups.get(slot.chestId)
      if (!group) {
        group = { chestId: slot.chestId, recordedAmount: 0, slots: [] }
        groups.set(slot.chestId, group)
      }
      group.recordedAmount += slot.amount
      group.slots.push(slot)
    }
    return [...groups.values()]
      .map(group => ({
        ...group,
        slots: group.slots.sort((a, b) => b.amount - a.amount || a.slot - b.slot)
      }))
      .sort((a, b) => b.recordedAmount - a.recordedAmount || a.chestId.localeCompare(b.chestId))
  }

  async tryWithdrawExactFrom (container, itemKey, amount, preferredSlots = [], options = {}) {
    let movedTotal = 0
    let remaining = amount
    let uncertainStreak = 0
    const preferredOrder = new Map(preferredSlots.map((slot, index) => [slot, index]))
    const maxPasses = Math.max(1, Number(this.config.timing?.withdrawConfirmPasses ?? 2))
    const maxUncertainRetries = Math.max(0, Number(this.config.timing?.withdrawUncertainRetries ?? 2))

    // 整批点击、末端一次确认：点击期间不等服务器逐条确认，
    // 少拿的数量在下一轮补取，避免逐次等待拖慢整批取货。
    for (let pass = 0; pass < maxPasses && remaining > 0; pass++) {
      const containerBefore = this.countContainerItem(container, itemKey)
      const expectedTake = Math.min(remaining, containerBefore)
      if (expectedTake <= 0) break

      let planned = 0
      while (planned < expectedTake) {
        const item = this.containerContentItems(container)
          .filter(entry => {
            const normalized = this.catalog.fromPrismarineItem(entry)
            return normalized.itemKey === itemKey
          })
          .sort((a, b) => {
            const ao = preferredOrder.has(a.slot) ? preferredOrder.get(a.slot) : Number.MAX_SAFE_INTEGER
            const bo = preferredOrder.has(b.slot) ? preferredOrder.get(b.slot) : Number.MAX_SAFE_INTEGER
            return ao - bo || b.count - a.count || a.slot - b.slot
          })[0]
        if (!item) break

        // mineflayer 会在点击后回写 item.slot（移动到窗口背包区），先快照真实来源槽位供日志使用。
        const sourceSlot = item.slot
        let take = Math.min(item.count, expectedTake - planned)
        // Craft batches budget fully packed inputs. Fill existing headroom
        // before opening another slot, even when the source does not fit whole.
        if (options.requireServerEvidence) {
          const mergeSlot = this.windowMergeSlotForItem(container, itemKey, 1)
          if (mergeSlot !== null) {
            const target = container.slots[mergeSlot]
            const stackSize = target.stackSize || this.catalog.getStackSize(`minecraft:${target.name}`)
            take = Math.min(take, stackSize - target.count)
          }
        }
        this.trace('take', 'slot_take_plan', {
          pass: pass + 1,
          slot: sourceSlot,
          slotCount: item.count,
          take,
          mode: take >= item.count ? 'whole_stack' : 'split_stack',
          keyTail: shortKey(itemKey),
          preferred: preferredOrder.has(sourceSlot),
          decision: `从槽位 ${sourceSlot} 取 ${take} 个（${take >= item.count ? '整组' : '拆分组'}）`
        })
        try {
          const inventoryBefore = this.hasInventoryItems() ? this.inventoryCountByItemKey(itemKey) : 0
          const windowInventoryBefore = this.hasWindowItems(container)
            ? this.windowInventoryCountByItemKey(container, itemKey)
            : 0
          if (take >= item.count) {
            await this.moveContainerSlotToInventory(container, sourceSlot)
          } else {
            await this.movePartialContainerSlotToInventory(container, sourceSlot, take, options)
          }
          const confirmed = await this.waitForInventoryTransfer(
            container,
            itemKey,
            inventoryBefore,
            windowInventoryBefore,
            take
          )
          if (confirmed < take) {
            uncertainStreak += 1
            const error = new Error(`取 ${itemKey} 后背包只确认增加 ${confirmed}/${take}，物理状态不确定。`)
            error.uncertainTransfer = true
            // 点击可能只是确认迟到（物品实际已移动）：清光标后重新按容器当前状态挑槽再点，
            // 已移动的物品重挑时自然消失，不会重复取；重试次数受 withdrawUncertainRetries 限制。
            if (uncertainStreak <= maxUncertainRetries) {
              this.debug(`withdraw exact slot ${sourceSlot} uncertain (${confirmed}/${take}, streak ${uncertainStreak}/${maxUncertainRetries + 1}), retrying`)
              this.trace('take', 'slot_take_uncertain_retry', {
                pass: pass + 1,
                slot: sourceSlot,
                take,
                confirmed,
                streak: uncertainStreak,
                maxRetries: maxUncertainRetries,
                decision: '点击未得到服务器确认，先清空光标再按当前实物状态重试（未确认不计成功）'
              })
              await this.ensureWindowCursorCleared(container)
              await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
              continue
            }
            throw error
          }
          uncertainStreak = 0
          this.trace('take', 'slot_take_confirmed', {
            pass: pass + 1,
            slot: sourceSlot,
            take,
            confirmed,
            decision: `槽位 ${sourceSlot} 取出 ${confirmed} 个已确认进入背包`
          })
        } catch (error) {
          this.debug(`withdraw exact slot ${sourceSlot} failed: ${error.message}`)
          this.trace('take', 'slot_take_failed', {
            pass: pass + 1,
            slot: sourceSlot,
            take,
            uncertain: Boolean(error?.uncertainTransfer),
            retriesExhausted: Boolean(error?.uncertainTransfer),
            message: error.message,
            decision: error?.uncertainTransfer
              ? `连续 ${uncertainStreak} 次点击都无法确认实物状态，交由上层跳过该木桶`
              : '该槽位取物失败，尝试下一槽位'
          })
          await this.ensureWindowCursorCleared(container)
          if (error?.uncertainTransfer) throw error
          break
        }
        if (!(await this.ensureWindowCursorCleared(container))) break
        planned += take
      }

      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
      const moved = Math.max(0, containerBefore - this.countContainerItem(container, itemKey))
      if (moved <= 0) {
        this.debug(`withdraw batch pass ${pass + 1} moved nothing for ${itemKey}`)
        this.trace('take', 'take_pass_no_progress', {
          pass: pass + 1,
          expectedTake,
          decision: pass + 1 < maxPasses ? '本轮点击没有任何数量变化，等待后重试一轮' : '重试后仍无变化，放弃本轮取物'
        })
        if (pass + 1 < maxPasses) {
          await sleep(Math.max(0, Number(this.config.timing?.inventoryUpdateTimeoutMs ?? 2000)))
          continue
        }
        break
      }
      movedTotal += moved
      remaining -= moved
      this.trace('take', 'take_pass_result', {
        pass: pass + 1,
        moved,
        remaining,
        decision: `第 ${pass + 1} 轮取走 ${moved} 个，还差 ${remaining} 个`
      })
    }

    return movedTotal
  }

  hasInventoryItems () {
    return Boolean(this.bot.inventory && typeof this.bot.inventory.items === 'function')
  }

  hasWindowItems (window) {
    return Boolean(window && typeof window.items === 'function')
  }

  async waitForInventoryTransfer (window, itemKey, inventoryBefore, windowInventoryBefore, expected, timeoutMs = null) {
    const timeout = Math.max(500, Number(timeoutMs ?? this.config.timing?.inventoryUpdateTimeoutMs ?? 2000))
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const inventoryIncrease = this.hasInventoryItems()
        ? Math.max(0, this.inventoryCountByItemKey(itemKey) - Number(inventoryBefore || 0))
        : 0
      const windowIncrease = this.hasWindowItems(window)
        ? Math.max(0, this.windowInventoryCountByItemKey(window, itemKey) - Number(windowInventoryBefore || 0))
        : 0
      if (Math.max(inventoryIncrease, windowIncrease) >= expected) return Math.max(inventoryIncrease, windowIncrease)
      await sleep(50)
    }
    const inventoryIncrease = this.hasInventoryItems()
      ? Math.max(0, this.inventoryCountByItemKey(itemKey) - Number(inventoryBefore || 0))
      : 0
    const windowIncrease = this.hasWindowItems(window)
      ? Math.max(0, this.windowInventoryCountByItemKey(window, itemKey) - Number(windowInventoryBefore || 0))
      : 0
    return Math.max(inventoryIncrease, windowIncrease)
  }

  async ensureWindowCursorCleared (container) {
    if (!container.selectedItem) return true
    // 光标物品优先并回同类型未满堆（整份收得下才点），其次找空格
    const cursor = this.catalog.fromPrismarineItem(container.selectedItem)
    let destSlot = this.windowMergeSlotForItem(container, cursor.itemKey, Number(container.selectedItem.count || 0))
    if (destSlot === null) destSlot = this.firstEmptyWindowInventorySlot(container)
    if (destSlot === null) return false
    try {
      await this.bot.clickWindow(destSlot, 0, 0)
    } catch {
      return false
    }
    await sleep(Math.max(0, Number(this.config.timing?.containerClickIntervalMs ?? 50)))
    return !container.selectedItem
  }

  windowInventoryCountByItemKey (window, itemKey) {
    let total = 0
    const inventoryStart = Number.isInteger(window.inventoryStart) ? window.inventoryStart : this.expectedContainerSlots()
    const inventoryEnd = Number.isInteger(window.inventoryEnd) ? window.inventoryEnd : Number.MAX_SAFE_INTEGER
    for (const item of window.items()) {
      if (!Number.isInteger(item.slot) || item.slot < inventoryStart || item.slot >= inventoryEnd) continue
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey === itemKey) total += item.count
    }
    return total
  }

  async waitForWindowInventoryIncrease (window, itemKey, before) {
    const timeoutMs = this.config.timing.inventoryUpdateTimeoutMs || 2000
    const intervalMs = 50
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(intervalMs)
      if (this.windowInventoryCountByItemKey(window, itemKey) > before) return
    }
  }

  async moveContainerSlotToInventory (container, sourceSlot) {
    const sourceItem = container.slots[sourceSlot]
    if (!sourceItem) throw new Error(`容器槽位 ${sourceSlot} 上没有物品，无法取物`)
    // 整堆搬运优先并入背包里同类型未满堆（余量收得下整份时左键点上去即全部合并）
    const destSlot = this.withdrawDestinationSlot(container, sourceItem, Number(sourceItem.count || 0))
    if (destSlot === null) throw new Error('机器人背包没有空槽，无法取物')

    await this.bot.clickWindow(sourceSlot, 0, 0)
    await sleep(Math.max(0, Number(this.config.timing?.containerClickIntervalMs ?? 50)))
    await this.bot.clickWindow(destSlot, 0, 0)
  }

  async movePartialContainerSlotToInventory (container, sourceSlot, count, options = {}) {
    const sourceItem = container.slots[sourceSlot]
    if (!sourceItem) throw new Error(`容器槽位 ${sourceSlot} 上没有物品，无法拆分取物`)
    // 右键逐个放入同类型半堆同样是合并语义：优先并堆，没有能整份收下的半堆再开新格
    const destSlot = this.withdrawDestinationSlot(container, sourceItem, count)
    if (destSlot === null) throw new Error('机器人背包没有空槽，无法拆分取物')
    const intervalMs = Math.max(0, Number(this.config.timing?.containerClickIntervalMs ?? 50))
    const target = container.slots[destSlot]
    const fillStack = options.requireServerEvidence && target &&
      (target.stackSize || this.catalog.getStackSize(`minecraft:${target.name}`)) - target.count === count

    await this.bot.clickWindow(sourceSlot, 0, 0)
    await sleep(intervalMs)
    if (fillStack) {
      // A left click fills only the target's free space. Return the rest to
      // its source below, preserving exact quantities without per-item clicks.
      await this.bot.clickWindow(destSlot, 0, 0)
      await sleep(intervalMs)
    } else {
      for (let i = 0; i < count; i++) {
        await this.bot.clickWindow(destSlot, 1, 0)
        if (intervalMs > 0) await sleep(intervalMs)
      }
    }
    await this.bot.clickWindow(sourceSlot, 0, 0)
    await sleep(intervalMs)
    if (container.selectedItem) {
      throw new Error(`拆分取物后鼠标仍持有 ${container.selectedItem.name || '物品'} x${container.selectedItem.count || 0}`)
    }
  }

  countContainerItem (container, itemKey) {
    let total = 0
    for (const item of this.containerContentItems(container)) {
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey === itemKey) total += item.count
    }
    return total
  }

  noteChestMutation (chestId) {
    if (!chestId) return
    const revision = ++this.warehouseState.revision
    this.warehouseState.chestRevisions.set(String(chestId), revision)
    this.chestMutationSeqs.set(String(chestId), revision)
    this.mutationSeq = revision
  }

  refreshChestSnapshot (chest, container) {
    this.noteChestMutation(chest.chestId)
    this.db.upsertChest(chest)
    const slots = this.containerContentItems(container).map(item => ({
      ...this.catalog.fromPrismarineItem(item),
      slot: item.slot,
      amount: item.count
    }))
    this.db.replaceChestSlots(chest.chestId, slots)
    this.trace('record', 'chest_record_refresh', {
      chest: this.describeChest(chest),
      contents: this.snapshotContainerContents(container),
      decision: '已按当前窗口内容刷新该木桶的本地槽位记录'
    })
  }

  async syncWarehouse (radius, options = {}) {
    // 阶段一：不持仓库锁扫描，业务存取照常进行；
    // 阶段二：短暂持锁，重读扫描期间被业务改动过的木桶后换入新库存并对账。
    const scan = await this.scanWarehouseContainers(radius)
    return this.withWarehouseLock(() => this.applyWarehouseScan(scan, radius, options))
  }

  async scanWarehouseContainers (radius) {
    const blocks = await this.prepareSyncBlocks(radius)
    return this.scanBarrelBlocks(blocks, radius)
  }

  // 全仓同步准备阶段：回仓并枚举半径内全部容器。并行同步时只由协调 bot
  // 执行一次，参与并行的各 bot 共用同一份木桶清单做分区，保证并集=全集。
  async prepareSyncBlocks (radius) {
    this.debug(`sync start radius=${radius}`)
    this.trace('sync', 'sync_start', {
      radius,
      decision: `开始全仓同步：扫描半径 ${radius} 内的全部木桶`
    })
    await this.goHome({ requireWarehouse: this.db.listChests().length > 0 })
    const blocks = this.findContainerBlocks(radius)
    this.debug(`found ${blocks.length} openable container blocks: ${blocks.map(block => this.describeBlock(block)).join(' | ')}`)
    this.trace('sync', 'sync_blocks_found', {
      radius,
      count: blocks.length,
      blocks: blocks.map(block => this.describeBlock(block))
    })
    return blocks
  }

  // 逐桶打开读取给定清单（单 bot 同步时是全部，并行时是其中一个分区）。
  // 任一木桶读取失败都抛错：此时还没写入任何记录，旧库存原样保留。
  async scanBarrelBlocks (blocks, radius) {
    const actualItems = []
    const snapshots = []
    const failures = []
    for (let index = 0; index < blocks.length; index++) {
      this.assertConnectionHealthy()
      const block = blocks[index]
      const chest = this.blockToChest(block)
      this.debug(`sync open ${index + 1}/${blocks.length} ${this.describeChest(chest)}`)
      const preReadSeq = this.warehouseState.revision
      let container
      try {
        container = await this.openContainerAt(chest)
        const slots = this.containerContentItems(container).map(item => ({
          ...this.catalog.fromPrismarineItem(item),
          slot: item.slot,
          amount: item.count
        }))
        snapshots.push({ chest, slots, preReadSeq })
        actualItems.push(...slots)
        this.debug(`sync read ${this.describeChest(chest)} slots=${slots.length} items=${slots.reduce((sum, item) => sum + item.amount, 0)}`)
        this.trace('sync', 'sync_barrel', {
          index: index + 1,
          total: blocks.length,
          chest: this.describeChest(chest),
          slots: slots.length,
          items: slots.reduce((sum, item) => sum + item.amount, 0),
          contents: this.snapshotContainerContents(container)
        })
      } catch (error) {
        if (error?.code === 'FATAL_PROTOCOL_READ' || this.connectionAbortController.signal.aborted) throw error
        const failure = `${this.describeChest(chest)} ${error.message}`
        failures.push(failure)
        console.error(`[warehouse] sync failed: ${failure}`)
        this.trace('error', 'sync_barrel_failed', {
          chest: this.describeChest(chest),
          message: error.message
        })
      } finally {
        this.closeContainerQuietly(container)
      }
    }

    if (!blocks.length) {
      throw new Error('同步失败：没有找到可读取的仓库容器；已保留旧本地记录，不会生成库存异常。请检查同步半径、home 点和仓库布局。')
    }
    if (failures.length) {
      const examples = failures.slice(0, 3).join('；')
      throw new Error(`同步失败：${blocks.length} 个容器中有 ${failures.length} 个读取失败；已保留全部旧记录，不会生成库存异常。${examples ? `失败示例：${examples}` : ''}`)
    }

    return { radius, blocks, snapshots, actualItems }
  }

  // 并行参与者：回仓就位后扫描分配到的分区。与协调 bot 共用同一份
  // warehouseState（revision / chestRevisions），快照语义不变。
  async scanSyncPartition (radius, blocks) {
    await this.goHome({ requireWarehouse: this.db.listChests().length > 0 })
    return this.scanBarrelBlocks(blocks, radius)
  }

  async applyWarehouseScan (scan, radius, options = {}) {
    this.db.assertNoPendingCraft?.()
    const { blocks, snapshots } = scan
    this.assertConnectionHealthy()

    // 缩量守卫：扫描结果比已登记木桶还少，基本是半径没罩住整个仓库。
    // 此时清库重写会把半径外的桶记录删掉，对账随即制造假缺失并抽干 momo，
    // 因此宁可中止保留旧记录；确属拆除木桶的场景用 !同步 <半径> 强制 通过。
    if (!options.allowShrink) {
      const registeredChestCount = this.db.listChests().length
      if (blocks.length < registeredChestCount) {
        throw new Error(`同步中止：本次扫描到 ${blocks.length} 个木桶，少于已登记的 ${registeredChestCount} 个（疑似半径过小）。已保留旧记录。请用覆盖整个仓库的半径重试；若确实拆除了木桶，请使用 !同步 <半径> 强制 重扫登记清单。`)
      }
    }

    // 重读同步扫描期间被业务存取改动过的木桶，避免用过期快照覆盖业务变更。
    // 任一重读失败都直接抛错：此时还没有写入任何新记录，旧库存原样保留。
    let rescanCount = 0
    for (const snapshot of snapshots) {
      if ((this.warehouseState.chestRevisions.get(snapshot.chest.chestId) || 0) <= snapshot.preReadSeq) continue
      this.debug(`sync rescan mutated chest ${this.describeChest(snapshot.chest)}`)
      this.trace('sync', 'sync_rescan_mutated', {
        chest: this.describeChest(snapshot.chest),
        decision: '扫描期间该木桶被业务存取改动过，重读后再采用'
      })
      const container = await this.openContainerAt(snapshot.chest)
      try {
        snapshot.slots = this.containerContentItems(container).map(item => ({
          ...this.catalog.fromPrismarineItem(item),
          slot: item.slot,
          amount: item.count
        }))
        rescanCount++
      } finally {
        this.closeContainerQuietly(container)
      }
    }

    this.assertConnectionHealthy()
    const actualItems = snapshots.flatMap(snapshot => snapshot.slots)
    this.assertConnectionHealthy()
    this.db.clearChests()
    for (const snapshot of snapshots) {
      this.db.upsertChest(snapshot.chest)
      this.db.replaceChestSlots(snapshot.chest.chestId, snapshot.slots)
    }

    const totals = this.mergeItems(actualItems)
    const reconcile = this.db.reconcileTotalsToMomo(totals)
    this.db.addTransaction('sync', 'ok', this.config.momoOwner, 'momo', totals, `radius=${radius}, chests=${blocks.length}`)

    return {
      chestCount: blocks.length,
      openedChestCount: snapshots.length,
      rescanCount,
      failures: [],
      totals,
      ...reconcile
    }
  }

  // 调试命令 !同步木桶：只打开并重读一个木桶，替换其槽位记录，
  // 并返回该桶的详细物品信息（含潜影盒内容展开）。不动账本、不做全仓对账。
  async syncSingleBarrel (chest) {
    return this.withWarehouseLock(() => this.syncSingleBarrelLocked(chest))
  }

  async syncSingleBarrelLocked (chest) {
    this.trace('debug', 'barrel_debug_start', {
      chest: `${chest.x},${chest.y},${chest.z}`,
      decision: '单桶调试同步：只重读这一个木桶'
    })
    await this.goHome({ requireWarehouse: this.db.listChests().length > 0 })
    const block = this.bot.blockAt(new Vec3(chest.x, chest.y, chest.z))
    if (!block || !this.chestNames.has(block.name)) {
      this.trace('error', 'barrel_debug_block_missing', {
        chest: `${chest.x},${chest.y},${chest.z}`,
        actualBlock: block?.name || 'none',
        decision: '目标坐标不是可同步的木桶'
      })
      throw new Error(`坐标 ${chest.x},${chest.y},${chest.z} 处不是可同步的木桶（实际方块：${block?.name || '无'}）。`)
    }
    // 与 blockToChest 相同的记录形态：chestId 用坐标，blockName 用实际读到的方块。
    const record = {
      chestId: `${chest.x},${chest.y},${chest.z}`,
      x: chest.x,
      y: chest.y,
      z: chest.z,
      blockName: block.name
    }
    const container = await this.openContainerAt(record)
    try {
      const slots = this.containerContentItems(container).map(item => ({
        ...this.catalog.fromPrismarineItem(item),
        slot: item.slot,
        amount: item.count
      }))
      const detail = this.buildBarrelDetail(slots)
      this.noteChestMutation(record.chestId)
      this.db.upsertChest(record)
      this.db.replaceChestSlots(record.chestId, slots)
      this.trace('debug', 'barrel_debug_result', {
        chest: this.describeChest(record),
        ...detail,
        decision: '已按实际内容替换该木桶的槽位记录（不调整账本）'
      })
      return { chest: { ...record, describe: this.describeChest(record) }, ...detail }
    } finally {
      this.closeContainerQuietly(container)
    }
  }

  buildBarrelDetail (slots) {
    const items = slots
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map(slot => {
        const entry = {
          slot: slot.slot,
          id: slot.itemId,
          name: slot.displayName || slot.itemId,
          amount: slot.amount,
          keyTail: shortKey(slot.itemKey)
        }
        if (this.catalog.isShulkerBox(slot.itemId)) {
          entry.shulkerContents = this.snapshotShulkerContents(slot)
        }
        return entry
      })
    return {
      types: items.length,
      total: items.reduce((sum, item) => sum + item.amount, 0),
      items
    }
  }

  findContainerBlocks (radius) {
    const positions = this.bot.findBlocks({
      matching: block => block && this.chestNames.has(block.name),
      maxDistance: radius,
      count: 4096
    })
    return positions
      .map(pos => this.bot.blockAt(pos))
      .filter(Boolean)
      .filter(block => this.shouldScanContainerBlock(block))
      .sort((a, b) => this.compareContainerScanOrder(a, b))
  }

  compareContainerScanOrder (a, b) {
    if (!this.isCylinderMode()) {
      return b.position.y - a.position.y || a.position.x - b.position.x || a.position.z - b.position.z
    }

    const axis = this.cylinderAxis()
    const home = this.homePosition || this.bot.entity?.position
    const homeAxis = home ? Math.floor(axis === 'x' ? home.x : home.z) : 0
    const aAxis = axis === 'x' ? a.position.x : a.position.z
    const bAxis = axis === 'x' ? b.position.x : b.position.z
    const axisDistance = Math.abs(aAxis - homeAxis) - Math.abs(bAxis - homeAxis)

    if (axisDistance !== 0) return axisDistance
    if (aAxis !== bAxis) return aAxis - bAxis

    const aCross = axis === 'x' ? a.position.z : a.position.x
    const bCross = axis === 'x' ? b.position.z : b.position.x
    return b.position.y - a.position.y || aCross - bCross || a.position.x - b.position.x || a.position.z - b.position.z
  }

  shouldScanContainerBlock (block) {
    if (block.name !== 'chest' && block.name !== 'trapped_chest') return true
    try {
      const type = block.getProperties?.().type
      return type !== 'right'
    } catch {
      return true
    }
  }

  blockToChest (block) {
    const { x, y, z } = block.position
    return {
      chestId: `${x},${y},${z}`,
      x,
      y,
      z,
      blockName: block.name
    }
  }

  async openContainerAt (chest) {
    this.assertConnectionHealthy()
    this.debug(`goto ${this.describeChest(chest)} from ${this.describePosition(this.bot.entity.position)}`)
    this.trace('move', 'goto_barrel', {
      chest: this.describeChest(chest),
      from: this.describePosition(this.bot.entity.position)
    })
    await this.gotoForContainer(chest)
    const block = this.bot.blockAt(new Vec3(chest.x, chest.y, chest.z))
    if (!block || !this.chestNames.has(block.name)) {
      this.trace('error', 'goto_barrel_block_missing', {
        chest: this.describeChest(chest),
        actualBlock: block?.name || 'none',
        decision: '走到目标坐标后发现不是可打开的木桶（可能被拆/换）'
      })
      throw new Error(`找不到箱子：${chest.x},${chest.y},${chest.z}`)
    }
    this.openingChest = chest
    try {
      // 服务器偶尔会弄丢开箱请求，等满超时也没有窗口；总共最多 openContainerAttempts 次，
      // 每次超时按 openContainerTimeoutsMs 递增（默认 2s/4s/8s）。
      const maxAttempts = Math.max(1, Number(this.config.timing?.openContainerAttempts ?? 3))
      for (let attempt = 0; ; attempt++) {
        try {
          const container = await this.openContainerBlock(block, this.timeoutForOpenAttempt(attempt))
          this.warnUnexpectedContainerWindow(container, chest)
          return container
        } catch (error) {
          if (!error?.allOpenTimeouts || attempt + 1 >= maxAttempts) {
            this.trace('error', 'open_barrel_failed', {
              chest: this.describeChest(chest),
              attempt: attempt + 1,
              maxAttempts,
              message: error?.message || String(error),
              decision: '打开木桶失败（超时/无窗口/协议错误）'
            })
            throw error
          }
          this.debug(`open ${this.describeChest(chest)} timed out (attempt ${attempt + 1}/${maxAttempts}), retrying with timeout ${this.timeoutForOpenAttempt(attempt + 1)}ms`)
          this.trace('open', 'open_barrel_retry', {
            chest: this.describeChest(chest),
            attempt: attempt + 1,
            maxAttempts,
            nextTimeoutMs: this.timeoutForOpenAttempt(attempt + 1),
            decision: `第 ${attempt + 1} 次开桶超时，加长超时重试`
          })
          await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
        }
      }
    } finally {
      this.openingChest = null
    }
  }

  invalidateConnection (reason = 'connection invalidated') {
    if (this.connectionAbortController.signal.aborted) return
    const error = new Error(`仓库连接已失效：${reason}`)
    error.code = 'CONNECTION_INVALIDATED'
    this.connectionAbortController.abort(error)
  }

  abortForProtocolReadError (error) {
    if (!isFatalProtocolReadError(error)) return error
    if (this.connectionAbortController.signal.aborted) return this.connectionAbortController.signal.reason

    const target = this.openingChest ? this.describeChest(this.openingChest) : '未知容器'
    const version = this.config.server?.version || '配置版本'
    const wrapped = new Error(
      `读取 ${target} 时发生 Slot/NBT 协议解析错误。` +
      `该木桶内可能有当前协议无法解析的嵌套物品；请先不要移动物品，程序会保存失败包并仅用 ${version} 重连。原始错误：${error.message}`,
      { cause: error }
    )
    wrapped.code = 'FATAL_PROTOCOL_READ'
    wrapped.chest = this.openingChest ? { ...this.openingChest } : null
    this.connectionAbortController.abort(wrapped)
    console.error(`[warehouse] fatal protocol read error: ${wrapped.message}`)
    return wrapped
  }

  assertConnectionHealthy () {
    if (this.connectionAbortController.signal.aborted) throw this.connectionAbortController.signal.reason
    if (this.isClientClosed()) {
      const error = new Error('Minecraft 连接已断开，当前仓库操作已终止。')
      error.code = 'CONNECTION_CLOSED'
      throw error
    }
  }

  async gotoForContainer (chest) {
    if (this.isCylinderMode()) {
      const moved = await this.gotoCylinderContainerStand(chest)
      if (moved) return
    }
    await this.gotoNear(chest.x, chest.y, chest.z)
  }

  isCylinderMode () {
    const mode = String(this.config.warehouse?.layoutMode || this.config.warehouse?.mode || 'normal').toLowerCase()
    return mode === 'cylinder'
  }

  cylinderConfig () {
    return this.config.warehouse?.cylinder || {}
  }

  cylinderAxis () {
    const axis = String(this.cylinderConfig().axis || 'x').toLowerCase()
    return axis === 'z' ? 'z' : 'x'
  }

  cylinderTunnelCenter () {
    const cylinder = this.cylinderConfig()
    const configured = cylinder.tunnelCenter || cylinder.center || {}
    const home = this.homePosition || this.bot.entity?.position

    const fallback = {
      x: home ? Math.floor(home.x) : 0,
      y: home ? Math.floor(home.y) : 0,
      z: home ? Math.floor(home.z) : 0
    }

    return {
      x: this.optionalInteger(configured.x, fallback.x),
      y: this.optionalInteger(configured.y, fallback.y),
      z: this.optionalInteger(configured.z, fallback.z)
    }
  }

  optionalInteger (value, fallback) {
    if (value === undefined || value === null || value === '') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.floor(parsed) : fallback
  }

  async gotoCylinderContainerStand (chest) {
    if (!this.bot.pathfinder) return false

    const axis = this.cylinderAxis()
    const tunnel = this.cylinderTunnelCenter()
    const stand = axis === 'x'
      ? new Vec3(chest.x, tunnel.y, tunnel.z)
      : new Vec3(tunnel.x, tunnel.y, chest.z)

    const candidates = this.getCylinderStandCandidates(stand)
    this.debug(`cylinder stand candidates for ${this.describeChest(chest)} axis=${axis}: ${candidates.map(pos => this.describeGridPosition(pos)).join(' | ') || 'none'}`)

    for (const pos of candidates) {
      try {
        await this.gotoWithMovements(new GoalBlock(pos.x, pos.y, pos.z), `cylinder stand ${this.describeGridPosition(pos)} for ${this.describeChest(chest)}`)
        return true
      } catch (error) {
        this.debug(`cylinder stand failed ${this.describeGridPosition(pos)}: ${error.message}`)
      }
    }

    return false
  }

  getCylinderStandCandidates (stand) {
    const yOffsets = this.cylinderConfig().yOffsets
    const configuredOffsets = Array.isArray(yOffsets) && yOffsets.length
      ? yOffsets.map(value => Number.parseInt(value, 10)).filter(Number.isFinite)
      : [0, -1, 1]
    const positions = []
    const seen = new Set()

    for (const dy of configuredOffsets) {
      const pos = stand.offset(0, dy, 0)
      const key = `${pos.x},${pos.y},${pos.z}`
      if (seen.has(key)) continue
      seen.add(key)
      if (this.isStandable(pos)) positions.push(pos)
    }

    const botPos = this.bot.entity.position
    return positions.sort((a, b) => {
      const da = a.offset(0.5, 0, 0.5).distanceTo(botPos)
      const db = b.offset(0.5, 0, 0.5).distanceTo(botPos)
      return da - db
    })
  }

  expectedContainerSlots () {
    return this.config.warehouse?.containerSlots || 27
  }

  containerContentItems (container) {
    const maxSlot = this.expectedContainerSlots()
    const items = typeof container.containerItems === 'function'
      ? container.containerItems()
      : container.items()
    return items.filter(item => Number.isInteger(item.slot) && item.slot >= 0 && item.slot < maxSlot)
  }

  warnUnexpectedContainerWindow (container, chest) {
    if (Number.isInteger(container.inventoryStart) && container.inventoryStart !== this.expectedContainerSlots()) {
      this.debug(`container window size ${container.inventoryStart} for ${this.describeChest(chest)}; using first ${this.expectedContainerSlots()} slots as barrel contents`)
    }
  }

  ensureSafeHandForContainerOpen () {
    if (!this.isUnsafeContainerOpenHeldItem(this.bot.heldItem)) return

    const safeSlot = this.findSafeContainerOpenHotbarSlot()
    if (safeSlot === null) {
      this.debug(`held item ${this.bot.heldItem.name} may open a server GUI, but no safe hotbar slot is available`)
      return
    }

    this.debug(`switch hotbar ${this.bot.quickBarSlot} -> ${safeSlot} before opening container; held=${this.bot.heldItem.name}`)
    this.bot.setQuickBarSlot(safeSlot)
  }

  isUnsafeContainerOpenHeldItem (item) {
    if (!item) return false
    const itemName = String(item.name || '').replace(/^minecraft:/, '').toLowerCase()
    // 刷怪蛋右键会生成生物而不是开箱；服务器特殊物品也常用刷怪蛋 id 做皮肤，一律视为不安全。
    if (itemName.endsWith('_spawn_egg')) return true
    const unsafeNames = this.config.warehouse?.containerOpenUnsafeHeldItems || ['flint']
    return unsafeNames.some(name => String(name || '').replace(/^minecraft:/, '').toLowerCase() === itemName)
  }

  findSafeContainerOpenHotbarSlot () {
    const start = this.bot.QUICK_BAR_START || 36
    let firstNonFlint = null

    for (let slot = 0; slot < 9; slot++) {
      if (slot === this.bot.quickBarSlot) continue
      const item = this.bot.inventory.slots[start + slot]
      if (!item) return slot
      if (firstNonFlint === null && !this.isUnsafeContainerOpenHeldItem(item)) {
        firstNonFlint = slot
      }
    }

    return firstNonFlint
  }

  closeLingeringWindow () {
    const window = this.bot.currentWindow
    if (!window) return
    // 超时后服务器仍可能迟到下发窗口；不清掉会在下一次开箱时干扰交互。
    this.debug('closing lingering window before opening container')
    try { this.bot.closeWindow(window) } catch {}
  }

  closeContainerQuietly (container) {
    if (!container) return
    try {
      container.close()
    } catch (error) {
      // 关窗只是收尾动作；失败时静默记日志，避免 finally 里抛错掩盖真实业务异常。
      this.debug(`close container failed: ${error?.message || error}`)
    }
  }

  timeoutForOpenAttempt (attempt) {
    const raw = this.config.timing?.openContainerTimeoutsMs
    const schedule = Array.isArray(raw)
      ? raw.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0)
      : []
    if (!schedule.length) return Number(this.config.timing?.openContainerTimeoutMs) || 8000
    // 次数超出配置表时沿用最后一档超时。
    return schedule[Math.min(attempt, schedule.length - 1)]
  }

  async openContainerBlock (block, timeoutMs = this.timeoutForOpenAttempt(0)) {
    const candidates = this.getContainerOpenCandidates(block)
    const errors = []

    for (const candidate of candidates) {
      const distance = this.bot.entity.position.distanceTo(candidate.position)
      const direction = this.getInteractionDirection(candidate)
      this.debug(`opening ${this.describeBlock(candidate)} distance=${distance.toFixed(2)} face=${this.describeVector(direction)}`)
      try {
        this.closeLingeringWindow()
        await this.lookAtBlock(candidate)
        this.ensureSafeHandForContainerOpen()
        const container = await this.withTimeout(
          this.bot.openContainer(candidate, direction, new Vec3(0.5, 0.5, 0.5)),
          timeoutMs,
          `打开箱子超时 ${this.describeBlock(candidate)} face=${this.describeVector(direction)}`
        )
        // 服务器偶尔会在开箱瞬间又立即关窗（卡顿/反作弊），bot.openContainer 会 resolve 出空窗口；
        // 这里不能把空窗口当成功返回，否则下游 countContainerItem(null) 与 finally 里的
        // container.close() 会连环报 "Cannot read properties of null (reading 'close')" 并掩盖真实错误。
        if (!container) {
          throw new Error(`打开箱子后没有收到窗口 ${this.describeBlock(candidate)} face=${this.describeVector(direction)}`)
        }
        this.warnUnexpectedContainerWindow(container, {
          blockName: candidate.name,
          x: candidate.position.x,
          y: candidate.position.y,
          z: candidate.position.z
        })
        return container
      } catch (error) {
        if (error?.code === 'FATAL_PROTOCOL_READ' || this.connectionAbortController.signal.aborted) throw error
        errors.push(`${this.describeBlock(candidate)} face=${this.describeVector(direction)} ${error.message}`)
        this.debug(`open attempt failed: ${errors.at(-1)}`)
      }
    }

    const failure = new Error(errors.join(' ; '))
    // 全部候选方块都只是超时或空窗口（而非协议错误等）时，允许上层关窗后重试。
    failure.allOpenTimeouts = errors.every(message => message.includes('打开箱子超时') || message.includes('没有收到窗口'))
    // 失败原因打标，供搜桶分流：refused 表示服务器只发了 close_window、
    // 明确拒绝了这次开箱，与桶里实际有多少东西无关，不能当成空桶。
    failure.openResult = errors.every(message => message.includes('没有收到窗口')) ? 'refused' : 'timeout'
    throw failure
  }

  getContainerOpenCandidates (block) {
    const candidates = [block]
    const offsets = [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1)
    ]

    for (const offset of offsets) {
      const other = this.bot.blockAt(block.position.plus(offset))
      if (other && other.name === block.name && this.isSameDoubleContainer(block, other)) {
        candidates.push(other)
      }
    }

    return candidates
  }

  isSameDoubleContainer (a, b) {
    try {
      const ap = a.getProperties?.() || {}
      const bp = b.getProperties?.() || {}
      return ap.facing === bp.facing && ap.type !== bp.type && ap.type !== 'single' && bp.type !== 'single'
    } catch {
      return false
    }
  }

  getInteractionDirection (block) {
    const botPos = this.bot.entity.position
    const center = block.position.offset(0.5, 0.5, 0.5)
    const dx = botPos.x - center.x
    const dz = botPos.z - center.z

    if (Math.abs(dx) >= Math.abs(dz)) {
      return new Vec3(dx >= 0 ? 1 : -1, 0, 0)
    }
    return new Vec3(0, 0, dz >= 0 ? 1 : -1)
  }

  async gotoNear (x, y, z) {
    if (!this.bot.pathfinder) return
    this.setupMovements()
    const candidates = this.getStandPositionsAround(x, y, z)
    this.debug(`stand candidates for ${x},${y},${z}: ${candidates.map(pos => this.describeGridPosition(pos)).join(' | ') || 'none'}`)

    for (const pos of candidates) {
      try {
        this.debug(`path try stand ${this.describeGridPosition(pos)} for target ${x},${y},${z}`)
        await this.gotoGoalWithRecovery(new GoalBlock(pos.x, pos.y, pos.z), `stand ${this.describeGridPosition(pos)}`)
        return
      } catch (error) {
        this.debug(`path candidate failed ${this.describeGridPosition(pos)}: ${error.message}`)
      }
    }

    this.debug(`path fallback GoalNear for ${x},${y},${z}`)
    await this.gotoGoalWithRecovery(new GoalNear(x, y, z, 2), `near ${x},${y},${z}`)
  }

  setupMovements () {
    if (!this.bot.pathfinder) return
    this.bot.pathfinder.setMovements(warehouseMovements(this.bot))
  }

  async gotoWithMovements (goal, label) {
    this.setupMovements()
    await this.gotoGoalWithRecovery(goal, label)
  }

  getStandPositionsAround (x, y, z) {
    const offsets = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
      [2, 0], [-2, 0], [0, 2], [0, -2],
      [2, 1], [2, -1], [-2, 1], [-2, -1],
      [1, 2], [-1, 2], [1, -2], [-1, -2]
    ]
    const yCandidates = [y, y - 1, y + 1]
    const positions = []
    const seen = new Set()

    for (const standY of yCandidates) {
      for (const [dx, dz] of offsets) {
        const pos = new Vec3(x + dx, standY, z + dz)
        const key = `${pos.x},${pos.y},${pos.z}`
        if (seen.has(key)) continue
        seen.add(key)
        if (this.isStandable(pos)) positions.push(pos)
      }
    }

    const botPos = this.bot.entity.position
    return positions.sort((a, b) => {
      const da = a.offset(0.5, 0, 0.5).distanceTo(botPos)
      const db = b.offset(0.5, 0, 0.5).distanceTo(botPos)
      return da - db
    })
  }

  isStandable (pos) {
    const feet = this.bot.blockAt(pos)
    const head = this.bot.blockAt(pos.offset(0, 1, 0))
    const below = this.bot.blockAt(pos.offset(0, -1, 0))
    return this.isPassable(feet) && this.isPassable(head) && this.isSupportBlock(below)
  }

  isPassable (block) {
    return !block || block.boundingBox === 'empty'
  }

  isSupportBlock (block) {
    return Boolean(block && block.boundingBox !== 'empty')
  }

  async gotoGoalWithRecovery (goal, label) {
    const timeoutMs = this.config.timing.pathTimeoutMs || 15000
    const noProgressMs = this.config.timing.pathNoProgressMs || 4000
    let timeout
    let progressTimer
    let lastPos = this.bot.entity.position.clone()
    let lastProgressAt = Date.now()

    const progressPromise = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`寻路超时 ${label}`)), timeoutMs)
      progressTimer = setInterval(() => {
        const current = this.bot.entity.position
        const moved = current.distanceTo(lastPos)
        if (moved > 0.25) {
          lastPos = current.clone()
          lastProgressAt = Date.now()
          return
        }
        if (Date.now() - lastProgressAt > noProgressMs) {
          reject(new Error(`寻路卡住 ${label} at ${this.describePosition(current)}`))
        }
      }, 500)
    })

    try {
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        progressPromise
      ])
    } catch (error) {
      this.bot.pathfinder.stop()
      this.bot.clearControlStates()
      await this.unstuckStep()
      throw error
    } finally {
      clearTimeout(timeout)
      clearInterval(progressTimer)
      this.bot.clearControlStates()
    }
  }

  async unstuckStep () {
    this.debug(`unstuck step from ${this.describePosition(this.bot.entity.position)}`)
    this.bot.setControlState('back', true)
    this.bot.setControlState('jump', true)
    await sleep(350)
    this.bot.clearControlStates()
    await sleep(150)
  }

  async lookAtBlock (block) {
    const center = block.position.offset(0.5, 0.5, 0.5)
    await this.bot.lookAt(center, true)
    await sleep(100)
  }

  async withTimeout (promise, ms, message) {
    this.assertConnectionHealthy()
    const signal = this.connectionAbortController.signal
    let timer
    let onAbort
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms)
        }),
        new Promise((resolve, reject) => {
          onAbort = () => reject(signal.reason || new Error('Minecraft 连接已断开。'))
          signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  describeChest (chest) {
    return `${chest.blockName}@${chest.x},${chest.y},${chest.z}`
  }

  describeBlock (block) {
    let props = ''
    try {
      props = JSON.stringify(block.getProperties?.() || {})
    } catch {
      props = '{}'
    }
    return `${block.name}@${block.position.x},${block.position.y},${block.position.z}${props}`
  }

  describePosition (pos) {
    return `${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}`
  }

  describeGridPosition (pos) {
    return `${pos.x},${pos.y},${pos.z}`
  }

  describeVector (vec) {
    return `${vec.x},${vec.y},${vec.z}`
  }

  async collectNearbyDropsUntil (deadlineMs, shouldStop) {
    const radius = this.config.warehouse.pickupRadius || 2
    this.debug(`collect drops start radius=${radius} until=${new Date(deadlineMs).toISOString()}`)
    this.setupMovements()
    while (Date.now() < deadlineMs && !shouldStop()) {
      const entity = this.nearestDroppedItem()
      if (entity) {
        try {
          await this.gotoGoalWithRecovery(
            new GoalNear(entity.position.x, entity.position.y, entity.position.z, 1),
            `drop ${this.describePosition(entity.position)}`
          )
        } catch (error) {
          this.debug(`drop path failed: ${error.message}`)
          await sleep(250)
        }
      } else {
        await sleep(250)
      }
    }
    this.debug('collect drops end')
  }

  async waitForPickupSettle (options = {}) {
    const maxMs = Number(options.maxMs ?? this.config.timing.pickupSettleMs ?? 3500)
    const stableMs = Number(options.stableMs ?? this.config.timing.pickupStableMs ?? 700)
    const intervalMs = 100
    const startedAt = Date.now()
    let stableSince = Date.now()
    let lastSignature = this.inventorySignature()

    while (Date.now() - startedAt < maxMs) {
      await sleep(intervalMs)
      const signature = this.inventorySignature()
      const hasNearbyDrop = Boolean(this.nearestDroppedItem())
      if (signature !== lastSignature || hasNearbyDrop) {
        lastSignature = signature
        stableSince = Date.now()
        continue
      }
      if (Date.now() - stableSince >= stableMs) break
    }

    this.debug(`pickup settled inventory=${this.inventorySummaryForDebug()} nearbyDrop=${Boolean(this.nearestDroppedItem())}`)
  }

  inventorySignature () {
    return this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      .map(item => `${item.itemKey}:${item.amount}`)
      .sort()
      .join('|')
  }

  inventorySummaryForDebug () {
    const items = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    const total = items.reduce((sum, item) => sum + item.amount, 0)
    const held = this.bot.heldItem ? `${this.bot.heldItem.name} x${this.bot.heldItem.count}` : 'empty'
    return `${items.length} types/${total} items held=${held}`
  }

  nearestDroppedItem () {
    const botPos = this.bot.entity.position
    let best = null
    let bestDistance = Infinity
    for (const entity of Object.values(this.bot.entities)) {
      if (entity.name !== 'item') continue
      const distance = entity.position.distanceTo(botPos)
      if (distance < bestDistance && distance <= (this.config.warehouse.pickupRadius || 2)) {
        best = entity
        bestDistance = distance
      }
    }
    return best
  }

  async dropInventoryToPlayer (username) {
    const dropped = []
    if (this.bot.currentWindow) {
      this.debug(`closing open window before dropping: ${this.bot.currentWindow.type || this.bot.currentWindow.id}`)
      this.bot.closeWindow(this.bot.currentWindow)
      await sleep(150)
    }

    while (this.bot.inventory.items().length) {
      const item = this.bot.inventory.items()[0]
      const normalized = this.catalog.fromPrismarineItem(item)
      const before = this.inventoryCountByItemKey(normalized.itemKey)
      const startedAt = Date.now()
      this.debug(`drop start ${normalized.displayName} x${item.count} slot=${item.slot} to ${username}`)
      await this.lookAtPlayer(username)
      await this.dropStackFast(item)
      const moved = await this.waitForInventoryDecrease(normalized.itemKey, before)
      if (moved <= 0) {
        throw new Error(`丢出 ${normalized.displayName} 超时，背包数量没有减少。`)
      }
      dropped.push({ ...normalized, amount: moved })
      this.debug(`drop done ${normalized.displayName} x${moved} confirm=${Date.now() - startedAt}ms cooldown=${this.dropIntervalMs()}ms`)
      await this.waitDropCooldown(startedAt)
    }
    return this.mergeItems(dropped)
  }

  async dropItemsToPlayer (username, requestedItems) {
    const requested = this.mergeItems(requestedItems || [])
    if (this.bot.currentWindow) {
      this.debug(`closing open window before dropping selected items: ${this.bot.currentWindow.type || this.bot.currentWindow.id}`)
      this.bot.closeWindow(this.bot.currentWindow)
      await sleep(150)
    }

    const beforeByKey = new Map(requested.map(request => [request.itemKey, this.inventoryCountByItemKey(request.itemKey)]))
    const maxRounds = Math.max(1, Number(this.config.timing?.dropConfirmRounds ?? 3))

    // 整批丢出、末端一次确认：全部丢完后统一对账背包减少量，
    // 没有离开背包的部分在下一轮补丢，而不是逐组等待确认。
    for (let round = 0; round < maxRounds; round++) {
      const pending = requested
        .map(request => ({
          request,
          amount: Number(request.amount || 0) - (beforeByKey.get(request.itemKey) - this.inventoryCountByItemKey(request.itemKey))
        }))
        .filter(entry => entry.amount > 0)
      if (!pending.length) break

      await this.lookAtPlayer(username)
      let plannedThisRound = 0
      for (const entry of pending) {
        let remaining = entry.amount
        // 同一轮里丢过的槽位不再重复点：背包槽位要等服务器同步才刷新，
        // 重复点同一堆只有第一次生效，计划量会被虚耗，导致少丢。
        // 个别点击没生效的堆，靠下一轮 pending 对账补丢。
        const droppedSlots = new Set()
        while (remaining > 0) {
          const item = this.bot.inventory.items().find(slot => {
            const normalized = this.catalog.fromPrismarineItem(slot)
            return normalized.itemKey === entry.request.itemKey && !droppedSlots.has(slot.slot)
          })
          if (!item) break
          const normalized = this.catalog.fromPrismarineItem(item)
          const amount = Math.min(remaining, item.count)
          const startedAt = Date.now()
          this.debug(`drop batch ${normalized.displayName} x${amount} slot=${item.slot} round=${round + 1}/${maxRounds}`)
          await this.dropSlotAmountFast(item, amount)
          droppedSlots.add(item.slot)
          remaining -= amount
          plannedThisRound += amount
          await this.waitDropCooldown(startedAt)
        }
      }
      if (!plannedThisRound) break
      await this.waitForInventoryIdle(beforeByKey.keys())
    }

    const dropped = []
    for (const request of requested) {
      const before = beforeByKey.get(request.itemKey) || 0
      const moved = Math.min(Number(request.amount || 0), Math.max(0, before - this.inventoryCountByItemKey(request.itemKey)))
      if (moved > 0) dropped.push({ ...request, amount: moved })
    }
    return this.mergeItems(dropped)
  }

  async waitForInventoryIdle (itemKeys) {
    const keys = [...itemKeys]
    if (!keys.length) return
    const pollMs = this.inventoryConfirmPollMs()
    const timeoutMs = Number(this.config.timing.dropConfirmTimeoutMs || 5000)
    const idleMs = Math.max(2 * pollMs, 150)
    const startedAt = Date.now()
    let last = keys.map(key => this.inventoryCountByItemKey(key))
    let idleSince = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(pollMs)
      const current = keys.map(key => this.inventoryCountByItemKey(key))
      if (current.some((count, index) => count !== last[index])) {
        last = current
        idleSince = Date.now()
        continue
      }
      if (Date.now() - idleSince >= idleMs) return
    }
  }

  async repairPlayerWithExperienceBottles (username, options = {}) {
    const itemId = String(options.itemId || 'minecraft:experience_bottle')
    const maxDistance = Number(options.maxDistance ?? 4)
    const used = []
    if (this.bot.currentWindow) {
      this.debug(`closing open window before repairing: ${this.bot.currentWindow.type || this.bot.currentWindow.id}`)
      this.bot.closeWindow(this.bot.currentWindow)
      await sleep(150)
    }

    while (true) {
      const target = this.resolvePlayerEntity(username)
      const botPos = this.bot.entity?.position
      if (!target?.position || !botPos) {
        this.debug(`repair stop ${username}: player entity unavailable`)
        break
      }
      const distance = target.position.distanceTo(botPos)
      if (distance > maxDistance) {
        this.debug(`repair stop ${username}: distance=${distance.toFixed(2)} > ${maxDistance}`)
        break
      }

      const item = this.bot.inventory.items().find(entry => this.catalog.fromPrismarineItem(entry).itemId === itemId)
      if (!item) break

      const normalized = this.catalog.fromPrismarineItem(item)
      const before = this.inventoryCountByItemKey(normalized.itemKey)
      const startedAt = Date.now()
      await this.equipItemInHand(item)
      await this.lookAtPlayer(username, 0.35)
      await this.useHeldItemOnce()
      const moved = await this.waitForInventoryDecrease(normalized.itemKey, before, { intervalMs: this.inventoryConfirmPollMs() })
      if (moved <= 0) throw new Error(`repair item use timed out: ${normalized.displayName}`)
      used.push({ ...normalized, amount: moved })
      this.debug(`repair throw ${normalized.displayName} x${moved} at ${username} confirm=${Date.now() - startedAt}ms cooldown=${this.dropIntervalMs()}ms`)
      await this.waitDropCooldown(startedAt)
    }

    return this.mergeItems(used)
  }

  async dropSlotAmountFast (item, amount) {
    const count = Math.max(0, Math.min(Number(amount || 0), Number(item.count || 0)))
    if (count <= 0) return
    if (count >= item.count) {
      await this.dropStackFast(item)
      return
    }

    const timeoutMs = Number(this.config.timing.dropConfirmTimeoutMs || 5000)
    for (let index = 0; index < count; index++) {
      await this.withTimeout(
        this.bot.clickWindow(item.slot, 0, 4),
        timeoutMs,
        `逐个丢出物品超时 slot=${item.slot}`
      )
    }
  }

  async dropStackFast (item) {
    const timeoutMs = Number(this.config.timing.dropConfirmTimeoutMs || 5000)
    try {
      // Mode 4, button 1 is the vanilla "drop entire stack from slot" action.
      await this.withTimeout(
        this.bot.clickWindow(item.slot, 1, 4),
        timeoutMs,
        `丢出物品点击超时 slot=${item.slot}`
      )
    } catch (error) {
      this.debug(`fast drop failed for ${item.name}@${item.slot}: ${error.message}; fallback tossStack`)
      await this.withTimeout(
        this.bot.tossStack(item),
        timeoutMs,
        `丢出物品超时 ${item.name} x${item.count}`
      )
    }
  }

  async waitForInventoryDecrease (itemKey, before, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? this.config.timing.dropConfirmTimeoutMs ?? 5000)
    const intervalMs = Math.max(10, Number(options.intervalMs ?? this.inventoryConfirmPollMs()))
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const after = this.inventoryCountByItemKey(itemKey)
      if (after < before) return before - after
      await sleep(intervalMs)
    }
    return Math.max(0, before - this.inventoryCountByItemKey(itemKey))
  }

  // 等 bot 自身区块就绪。跨维度传送后区块数据未到时，mineflayer 的 physics
  // tick 会因 blockAt 为空而整体跳过：force look 只改本地朝向，转头包靠
  // physics tick 补发；区块未就绪时包根本发不出去，服务器仍按落地旧朝向
  // 处理丢物品（落地朝向恰好朝玩家只是传送插件的巧合）。判断条件与
  // physics tick 的拦截条件保持一致：blockAt(自身位置) 非空。
  async waitForOwnChunkReadyForAim (timeoutMs) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const pos = this.bot.entity?.position
      if (pos && this.bot.blockAt(pos) != null) return true
      await sleep(100)
    }
    return false
  }

  // 丢前瞄准默认对准玩家身体底部中心（脚底坐标）。高瞄点会让丢出方向偏上，
  // 玩家站在台阶、半砖、船等矮位时物品落点会漂。
  async lookAtPlayer (username, yOffset = 0) {
    const entity = this.resolvePlayerEntity(username)
    if (!entity) {
      // 不能静默返回：调用方会按上一次视线丢出物品，等于丢歪。
      throw new Error(`丢前瞄准失败：找不到玩家 ${username} 的实体（区块可能尚未加载）`)
    }
    const chunkTimeoutMs = Number(this.config.timing?.dropAimChunkTimeoutMs ?? 5000)
    if (!await this.waitForOwnChunkReadyForAim(chunkTimeoutMs)) {
      throw new Error(`丢前瞄准失败：bot 所在区块 ${chunkTimeoutMs}ms 内未就绪，转向无法同步，为避免丢歪已中止`)
    }
    const target = entity.position.offset(0, yOffset, 0)
    const botBefore = this.bot.entity
    const beforeYaw = notchYawDeg(botBefore.yaw)
    const beforePitch = notchPitchDeg(botBefore.pitch)
    this.debug(`aim ${username}: bot=${this.describePosition(botBefore.position)} 视角 yaw=${beforeYaw.toFixed(1)}° pitch=${beforePitch.toFixed(1)}°` +
      ` 玩家=${this.describePosition(entity.position)} 碰撞箱=${entity.width ?? '?'}x${entity.height ?? '?'} 目标=${this.describePosition(target)}(yOffset=${yOffset})`)
    const startedAt = Date.now()
    // force：本地朝向一步设到位（不做逐 tick 逼近，瞬间转头）；
    // 转头包由物理心跳在下一个 50ms 补发。
    await this.bot.lookAt(target, true)
    const afterYaw = notchYawDeg(this.bot.entity.yaw)
    const afterPitch = notchPitchDeg(this.bot.entity.pitch)
    // 环形差值：0~180°，表示实际转过的角度
    const turnedDeg = Math.abs(((afterYaw - beforeYaw) % 360 + 540) % 360 - 180)
    this.debug(`aim done ${username}: yaw ${beforeYaw.toFixed(1)}°→${afterYaw.toFixed(1)}°(转${turnedDeg.toFixed(1)}°) pitch ${beforePitch.toFixed(1)}°→${afterPitch.toFixed(1)}° 用时${Date.now() - startedAt}ms`)
    await sleep(100)
  }

  // bot.players[name].entity 跨维度传送后会失效；先直查，再按大小写变体，
  // 最后扫 bot.entities 玩家实体兜底。与 service.resolvePlayerEntity 同一套语义。
  resolvePlayerEntity (username) {
    const name = String(username || '')
    if (!name) return null
    const direct = this.bot.players?.[name]
    if (direct?.entity?.position) return direct.entity
    const lower = name.toLowerCase()
    const variantKey = Object.keys(this.bot.players || {}).find(key =>
      key.toLowerCase() === lower && this.bot.players[key]?.entity?.position)
    if (variantKey) return this.bot.players[variantKey].entity
    const entities = this.bot.entities || {}
    const entityValues = typeof entities.values === 'function' ? [...entities.values()] : Object.values(entities)
    const match = entityValues.find(entity =>
      entity?.type === 'player' &&
      typeof entity.username === 'string' &&
      entity.username.toLowerCase() === lower &&
      entity.position)
    return match || null
  }

  async equipItemInHand (item) {
    if (!item) return
    const expected = this.catalog.fromPrismarineItem(item)
    const heldMatches = () => {
      if (!this.bot.heldItem) return false
      return this.catalog.fromPrismarineItem(this.bot.heldItem).itemKey === expected.itemKey
    }
    if (heldMatches()) return
    if (typeof this.bot.equip === 'function') {
      await this.bot.equip(item, 'hand')
    } else {
      const quickBarStart = this.bot.QUICK_BAR_START || 36
      if (typeof this.bot.setQuickBarSlot !== 'function' || item.slot < quickBarStart || item.slot >= quickBarStart + 9) {
        throw new Error(`cannot equip item in hand: ${item.name || item.itemId || 'item'}`)
      }
      this.bot.setQuickBarSlot(item.slot - quickBarStart)
    }

    const deadline = Date.now() + Math.max(500, Number(this.config.timing?.inventoryUpdateTimeoutMs || 2000))
    while (Date.now() < deadline) {
      if (heldMatches()) {
        this.debug(`equipped ${expected.displayName || expected.itemId} key=${expected.itemKey.slice(-6)} in main hand`)
        return
      }
      await sleep(50)
    }
    throw new Error(`装备潜影盒到主手失败：${expected.displayName || expected.itemId}`)
  }

  async useHeldItemOnce () {
    await this.withTimeout(Promise.resolve().then(async () => {
      this.bot.activateItem(false)
      await sleep(75)
      this.bot.deactivateItem?.()
    }), Number(this.config.timing.useItemTimeoutMs || 3000), 'held item use timed out')
  }

  dropIntervalMs () {
    return Math.max(0, Number(this.config.timing?.dropIntervalMs ?? 250))
  }

  inventoryConfirmPollMs () {
    return Math.max(10, Math.min(25, this.dropIntervalMs() || 25))
  }

  async waitDropCooldown (startedAt) {
    const remaining = this.dropIntervalMs() - (Date.now() - startedAt)
    if (remaining > 0) await sleep(remaining)
  }

  mergeItems (items) {
    const amounts = sumBy(items, item => item.itemKey)
    const firstByKey = new Map(items.map(item => [item.itemKey, item]))
    return [...amounts.entries()].map(([itemKey, amount]) => ({ ...firstByKey.get(itemKey), amount }))
  }
}

module.exports = Warehouse
