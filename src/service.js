const { clampInt, sleep, sumBy } = require('./utils')
const { startTrace, traceEvent, traceSummary, traceStandalone, shortKey } = require('./traceLog')
const { runHotReload } = require('./hotReload')
const { planShortages, normalizeItemId } = require('./shortagePlanner')

const REPAIR_BOTTLE_ITEM_ID = 'minecraft:experience_bottle'
const REPAIR_BOTTLE_AMOUNT = 64
const REPAIR_MAX_DISTANCE = 4
const WHOLE_SHULKER_WITHDRAW_THRESHOLD = 1728

// 扣账幂等键的进程级盐。任务序号（taskPool.sequence）是内存自增、进程重启后归零，
// 幂等键若只由 botId+taskId+批次号组成，重启后会与重启前的任务撞键：
// applyWithdrawDeduction 会把新交付误判成“已扣过”而静默跳过扣账，
// 造成物品已交付、账本不扣、Web 库存虚高（后续取货只能走无记录搜桶并报缺货）。
// 盐在进程生命周期内保持稳定：同进程内同批次键不变（就地重试/崩溃恢复防双扣语义不变），跨进程必然不同。
const DEDUCTION_KEY_SALT = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

class CloudStoreService {
  constructor (bot, db, catalog, warehouse, config, taskPool = null, subscriptions = null) {
    this.bot = bot
    this.db = db
    this.catalog = catalog
    this.warehouse = warehouse
    this.config = config
    this.taskPool = taskPool
    this.subscriptions = subscriptions
    this.botId = String(config.server?.botName || config.server?.username || bot.username || 'bot').toLowerCase()
    this.ready = false
    this.connectionInvalidated = false
    this.active = null
    this.deathContext = null
    this.recoveringFromDeath = false
    this.emergencyRescueActive = false
    this.seenMessages = new Map()
    this.webAuth = null
    this.accountedResidual = new Map()
    this.hotReloadRunning = false
    // index.js 注入：重启前的全局收尾（断开所有 bot、关订阅/DB）与进程退出。
    this.hotReloadShutdownHook = null
    this.hotReloadExitHook = null
    // 测试注入口：runHotReload 的内部步骤桩（gitPull/waitForIdle/scheduleSuccessorProcess）。
    this.hotReloadStubs = null
  }

  invalidateConnection (reason = 'connection invalidated') {
    this.connectionInvalidated = true
    this.ready = false
    this.active && (this.active.cancelled = true)
    this.craftController?.cancel(reason)
    this.warehouse.invalidateConnection(reason)
  }

  // 链路日志挂载/摘除。warehouse 可能是测试桩或旧实现（没有这两个方法），此时静默跳过。
  attachWarehouseTrace (trace) {
    if (typeof this.warehouse?.attachTrace === 'function') this.warehouse.attachTrace(trace)
  }

  detachWarehouseTrace () {
    if (typeof this.warehouse?.detachTrace === 'function') this.warehouse.detachTrace()
  }

  setWebAuth (webAuth) {
    this.webAuth = webAuth
  }

  // index.js 注入热重载所需的全局收尾与退出实现：
  // shutdownHook 在退出前执行（断开所有 bot、关订阅和 DB）；exitHook 显式退出进程——
  // 不依赖“事件循环自然排空”（残留 handle 会让旧进程变成断了 bot、关了 DB 的僵尸）。
  setHotReloadHooks (shutdownHook, exitHook) {
    this.hotReloadShutdownHook = typeof shutdownHook === 'function' ? shutdownHook : null
    this.hotReloadExitHook = typeof exitHook === 'function' ? exitHook : null
  }

  start () {
    this.db.claimLegacyRecoveryTask(this.botId)
    this.scheduleCraftAutoRecovery()
    this.bot.on('chat', (username, message) => {
      if (username === this.bot.username) return
      this.handleIncoming(username, message, 'chat', { channel: 'public' })
    })

    this.bot.on('whisper', (username, message) => {
      if (username === this.bot.username) return
      this.handleIncoming(username, message, 'whisper', { channel: 'private' })
    })

    this.bot.on('messagestr', (message, position, originalMessage, sender) => {
      this.handleMessageString(message, position, sender)
    })

    this.bot._client.on('player_chat', packet => {
      this.handlePlayerChatPacket(packet)
    })

    this.bot._client.on('system_chat', packet => {
      this.handleSystemChatPacket(packet)
    })

    this.bot.on('death', () => {
      this.handleDeath()
    })

    this.bot.on('respawn', () => {
      this.withBotContext(() => this.handleRespawn()).catch(error => {
        console.error('[death-recovery] failed:', error)
      })
    })

    setTimeout(() => {
      this.withBotContext(() => this.recoverPersistedTaskOnSpawn()).catch(error => {
        console.error('[disconnect-recovery] failed:', error)
      }).finally(() => {
        this.ready = !this.connectionInvalidated
        this.taskPool?.dispatch()
      })
    }, 1500)
  }

  handleDeath () {
    console.warn(`[death] bot died. active=${this.active ? `${this.active.type}:${this.active.username}:${this.active.phase || ''}` : 'none'}`)
    if (this.active) {
      this.active.dead = true
      this.active.cancelled = true
      this.deathContext = { ...this.active }
    } else {
      this.deathContext = { type: 'idle', username: '', player: null, phase: 'idle' }
    }
    this.bot.pathfinder?.stop()
    this.craftController?.cancel('机器人死亡，合成已停止并保留恢复记录。')
    this.bot.clearControlStates()
  }

  async handleRespawn () {
    if (!this.deathContext || this.recoveringFromDeath) return
    this.recoveringFromDeath = true
    const context = this.deathContext
    this.deathContext = null

    // The craft controller keeps its lease until every outstanding craft call
    // drains. Do not run generic death cleanup or erase its durable journal.
    if (context.type === 'craft' || context.type === 'craft_recovery' || this.db.hasPendingCraft?.(this.botId)) {
      try {
        this.craftController?.cancel('机器人死亡后等待合成恢复。')
        if (this.taskPool?.hasInFlightCraft?.(this.botId)) {
          await this.taskPool.waitForCraftDrain?.(this.botId)
        }
        if (this.connectionInvalidated) throw new Error('连接已失效，合成恢复留待新连接。')
        if (this.craftController?.isBusy() || this.bot._craftingExecutor?.isBusy()) return
        await this.getCraftController().recover()
      } finally {
        this.recoveringFromDeath = false
        this.taskPool?.dispatch()
      }
      return
    }

    const trace = startTrace({
      bot: this.botId,
      kind: 'recovery',
      reason: 'death',
      type: context.type,
      actor: context.username || '',
      phase: context.phase || ''
    })
    this.attachWarehouseTrace(trace)
    try {
      await sleep(1500)
      console.log(`[death-recovery] respawned, going home. context=${context.type}:${context.username || ''}:${context.phase || ''}`)
      await this.warehouse.goHome({ requireWarehouse: true })

      if (context.type === 'deposit' && (context.owner || context.player)) {
        const owner = context.owner || context.player
        const result = await this.warehouse.depositInventoryForOwner(owner.uuid, owner.username)
        if (result.deposited.length) {
          this.msg(context.username, `机器人死亡后已回仓库，已继续存入${this.ownerScopeName(owner)}：${this.formatDepositSummary(result.deposited)}。`)
        } else {
          this.msg(context.username, '机器人死亡后已回仓库，但背包里没有可继续入库的物品。')
        }
        if (result.leftover.length) {
          this.accountResidualAsMomo(result.leftover, `death deposit leftover, actor=${context.username}, owner=${owner.uuid}`)
          this.msg(context.username, `仓库空间不足，剩余${this.formatDepositSummary(result.leftover)}已转记为 momo，避免影响下一个玩家。`)
        }
      } else if (context.type === 'withdraw') {
        const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
        const recoveryTask = this.db.getRecoveryTask(this.botId)
        const recoveryOwner = recoveryTask ? this.recoveryOwnerFromTask(recoveryTask) : (context.owner || context.player)
        const pendingRepack = this.resolvePreparedShulkerRepackRecovery()
        const deliveredAfterDeath = recoveryTask?.type === 'withdraw' && this.isWithdrawDeliveryPhase(recoveryTask.phase) && recoveryTask.items?.length
          ? this.subtractLeftoverFromDelivered(recoveryTask.items, held)
          : []
        if (pendingRepack && !held.length) {
          if (pendingRepack.state === 'physical_changed') {
            const resolved = this.db.resolveStuckShulkerRepack?.(this.botId, [], 'death recovery with empty inventory')
            if (resolved) {
              console.warn(`[death-recovery] resolved stuck shulker repack record with empty inventory: bot=${this.botId} committed=${resolved.committed}${resolved.committed ? '' : `, cleared with mismatch (${resolved.error})`}`)
            }
          } else {
            console.warn(`[death-recovery] pending shulker repack has no held items; keeping the recovery record without committing: bot=${this.botId}`)
          }
        }
        const result = await this.warehouse.depositInventoryWithoutBalance('withdraw_death_recovery', `player=${context.username}, phase=${context.phase || ''}`)
        if (deliveredAfterDeath.length && recoveryOwner) {
          this.recordWithdrawDeduction(recoveryOwner, deliveredAfterDeath, `player=${context.username}, recovery=death`, this.recoveryDeductionKey(recoveryTask))
        }
        if (pendingRepack && held.length) this.commitRecoveredShulkerRepack(result, 'death')
        if (context.username) {
          this.msg(context.username, '机器人取物品过程中死亡，本次取物品已终止；身上剩余物品已回收入库，不会扣除未交付数量。')
        }
        if (result.leftover.length && context.username) {
          this.msg(context.username, `仓库空间不足，仍有物品留在机器人身上：${this.formatItemList(result.leftover)}`)
        }
      }

      this.db.clearRecoveryTask(this.botId)
      if (this.active?.dead) this.active = null
      traceSummary(trace, { status: 'done', reason: 'death' })
    } catch (error) {
      traceEvent(trace, 'error', 'recovery_error', { message: error?.message || String(error) })
      traceSummary(trace, { status: 'failed', reason: 'death', message: error?.message || String(error) })
      throw error
    } finally {
      this.detachWarehouseTrace()
      this.recoveringFromDeath = false
    }
  }

  saveRecoveryTask (type, actorUsername, owner, targetUsername, phase = '', items = [], deductionKey = '') {
    this.db.saveRecoveryTask({
      type,
      actorUsername,
      ownerUuid: owner?.uuid || '',
      ownerUsername: owner?.username || '',
      ownerScope: owner?.scope || 'personal',
      vaultName: owner?.vaultName || '',
      targetUsername,
      phase,
      deductionKey: String(deductionKey || ''),
      items: this.mergeItems(items || [])
    }, this.botId)
  }

  recoveryDeductionKey (task) {
    const existing = String(task?.deductionKey || '').trim()
    if (existing) return existing
    const legacy = `legacy:${this.botId}:${task?.updatedAt || task?.createdAt || 'unknown'}`
    console.warn(`[withdraw-recovery] recovery task has no deduction key; using stable legacy key ${legacy}`)
    return legacy
  }

  clearRecoveryTaskIfInventoryEmpty () {
    const task = this.db.getRecoveryTask(this.botId)
    if (task?.type === 'withdraw' && this.isWithdrawDeliveryPhase(task.phase)) return
    const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    if (!held.length) this.db.clearRecoveryTask(this.botId)
  }

  isWithdrawDeliveryPhase (phase) {
    return phase === 'withdraw_dropping' || phase === 'withdraw_repairing' || phase === 'withdraw_return_home'
  }

  recoveryOwnerFromTask (task) {
    return {
      uuid: task.ownerUuid,
      username: task.ownerUsername || this.db.ownerLabel(task.ownerUuid),
      scope: task.ownerScope || (task.ownerUuid?.startsWith('vault:') ? 'custom' : 'personal'),
      vaultName: task.vaultName || (task.ownerUuid?.startsWith('vault:') ? this.db.ownerLabel(task.ownerUuid).replace(/^仓库:/, '') : '')
    }
  }

  resolvePreparedShulkerRepackRecovery () {
    const recovery = this.db.getShulkerRepackRecovery?.(this.botId) || null
    if (!recovery || recovery.state !== 'prepared') return recovery || null
    return this.warehouse.resolvePreparedShulkerRepackFromInventory()
  }

  clearOrphanedPreparedShulkerRepack (recovery, task, held) {
    if (recovery?.state !== 'prepared' || task || held?.length) return false
    this.db.clearShulkerRepackRecovery(this.botId)
    console.warn(`[shulker-repack-recovery] cleared orphaned prepared record with no held items or recovery task: bot=${this.botId} old=${recovery.oldBoxItemKey}`)
    return true
  }

  commitRecoveredShulkerRepack (depositResult, recoveryType) {
    const recovery = this.db.getShulkerRepackRecovery?.(this.botId) || null
    if (!recovery) return null
    if (depositResult?.leftover?.length) {
      throw new Error(`潜影盒重打包恢复仍有物品未能回库，暂不补记账本：${this.formatItemList(depositResult.leftover)}`)
    }
    const committed = this.db.commitShulkerRepackRecovery(this.botId)
    if (committed) {
      console.warn(`[shulker-repack-recovery] committed bot=${this.botId} type=${recoveryType} old=${committed.oldBoxItemKey} new=${committed.newBoxItem.itemKey}`)
    }
    return committed
  }

  async recoverPersistedTaskOnSpawn () {
    if (this.db.hasPendingCraft?.(this.botId)) {
      if (this.connectionInvalidated) throw new Error('连接已失效，合成恢复留待新连接。')
      // An old disconnected instance may still be draining a network Promise.
      if (this.taskPool?.hasInFlightCraft?.(this.botId)) {
        await this.taskPool.waitForCraftDrain?.(this.botId)
      }
      if (this.connectionInvalidated) throw new Error('连接已失效，合成恢复留待新连接。')
      await this.getCraftController().recover()
      return
    }
    const task = this.db.getRecoveryTask(this.botId)
    const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    const pendingRecord = this.db.getShulkerRepackRecovery?.(this.botId) || null
    const pendingRepack = this.resolvePreparedShulkerRepackRecovery()
    if (!task && !pendingRepack) {
      if (this.clearOrphanedPreparedShulkerRepack(pendingRecord, task, held)) return
      return
    }
    if (pendingRepack && !held.length) {
      if (pendingRecord?.state === 'physical_changed') {
        const resolved = this.db.resolveStuckShulkerRepack?.(this.botId, [], 'disconnect recovery with empty inventory')
        if (resolved) {
          console.warn(`[disconnect-recovery] resolved stuck shulker repack record with empty inventory: bot=${this.botId} committed=${resolved.committed}${resolved.committed ? '' : `, cleared with mismatch (${resolved.error})`}`)
        }
      } else {
        console.warn(`[disconnect-recovery] pending shulker repack has no held items; keeping the recovery record and continuing service: bot=${this.botId}`)
      }
      if (!task) return
    }
    if (!task && pendingRepack) {
      await this.warehouse.goHome({ requireWarehouse: true })
      const result = await this.warehouse.depositInventoryWithoutBalance('disconnect_recovery_shulker_repack', `bot=${this.botId}`)
      this.commitRecoveredShulkerRepack(result, 'disconnect_without_task')
      return
    }

    const owner = this.recoveryOwnerFromTask(task)
    if (!held.length && !pendingRepack && !(task.type === 'withdraw' && this.isWithdrawDeliveryPhase(task.phase) && task.items?.length)) {
      console.warn(`[disconnect-recovery] clearing stale recovery task without held items: ${task.type}:${task.actorUsername}:${task.phase}`)
      this.db.clearRecoveryTask(this.botId)
      return
    }

    const trace = startTrace({
      bot: this.botId,
      kind: 'recovery',
      reason: 'disconnect',
      type: task.type,
      actor: task.actorUsername || '',
      target: task.targetUsername || '',
      phase: task.phase || '',
      held: held.map(item => ({ name: item.displayName || item.itemId, amount: item.amount }))
    })
    this.attachWarehouseTrace(trace)
    try {
      console.warn(`[disconnect-recovery] restoring persisted task: task=${task.type}:${task.actorUsername}:${task.phase} held=${held.length ? this.formatItemList(held) : 'empty'}`)
      if (held.length) await this.warehouse.goHome({ requireWarehouse: true })

      if (task.type === 'deposit') {
        const result = await this.warehouse.depositInventoryForOwner(owner.uuid, owner.username)
        this.db.addTransaction('disconnect_recovery_deposit', result.deposited.length ? 'ok' : 'empty', owner.uuid, owner.username, result.deposited.length ? result.deposited : result.leftover, `actor=${task.actorUsername}, phase=${task.phase}`)
        if (result.leftover.length) {
          this.accountResidualAsMomo(result.leftover, `disconnect deposit leftover, actor=${task.actorUsername}, owner=${owner.uuid}, phase=${task.phase}`)
        }
        if (task.actorUsername && result.deposited.length) {
          this.msg(task.actorUsername, `机器人重连后已继续存入${this.ownerScopeName(owner)}：${this.formatDepositSummary(result.deposited)}。`)
        }
      } else if (task.type === 'withdraw') {
        const result = held.length
          ? await this.warehouse.depositInventoryWithoutBalance('disconnect_recovery_withdraw', `actor=${task.actorUsername}, target=${task.targetUsername}, phase=${task.phase}`)
          : { deposited: [], leftover: [] }
        if (this.isWithdrawDeliveryPhase(task.phase) && task.items?.length) {
          const delivered = this.subtractLeftoverFromDelivered(task.items, held)
          if (delivered.length) {
            this.recordWithdrawDeduction(owner, delivered, `actor=${task.actorUsername}, target=${task.targetUsername}, phase=${task.phase}, recovery=disconnect`, this.recoveryDeductionKey(task))
            if (task.actorUsername) {
              this.msg(task.actorUsername, `机器人重连后已补记上次已交付的取货：${this.formatWithdrawSummary(delivered)}。`)
            }
          }
        }
        if (pendingRepack && held.length) this.commitRecoveredShulkerRepack(result, 'disconnect')
        if (task.actorUsername && result.deposited.length) {
          this.msg(task.actorUsername, `机器人重连后已把未交付的取货物品回收入库；这部分不会扣除库存。`)
        }
        if (result.leftover.length && task.actorUsername) {
          this.msg(task.actorUsername, `机器人重连恢复时仍有物品未能放回仓库：${this.formatItemList(result.leftover)}`)
        }
      } else {
        console.warn(`[disconnect-recovery] unknown task type ${task.type}, keeping held items in inventory`)
        return
      }

      this.db.clearRecoveryTask(this.botId)
      traceSummary(trace, { status: 'done', reason: 'disconnect' })
    } catch (error) {
      traceEvent(trace, 'error', 'recovery_error', { message: error?.message || String(error) })
      traceSummary(trace, { status: 'failed', reason: 'disconnect', message: error?.message || String(error) })
      throw error
    } finally {
      this.detachWarehouseTrace()
    }
  }

  handlePlayerChatPacket (packet) {
    const username = this.usernameFromUuid(packet.senderUuid)
    const message = packet.plainMessage || this.componentToText(packet.unsignedChatContent)
    if (this.config.debugRawChat) {
      console.log(`[packet:player_chat] uuid=${packet.senderUuid} username=${username || '?'} plain=${message}`)
    }
    if (!username || !message || this.isSelfUsername(username)) return
    this.handleIncoming(username, message, 'packet:player_chat', { channel: 'public' })
  }

  handleSystemChatPacket (packet) {
    const message = this.componentToText(packet.content)
    if (this.config.debugRawChat && message) {
      console.log(`[packet:system_chat] actionBar=${packet.isActionBar} text=${message}`)
    }
    if (!message) return
    const parsed = this.parseCustomCommandMessage(message, null)
    if (!parsed) return
    this.handleIncoming(parsed.username, parsed.command, 'packet:system_chat', { channel: 'private' })
  }

  handleIncoming (username, message, source, context = {}) {
    if (this.isSelfUsername(username)) {
      if (this.config.debugRawChat) console.log(`[chat:${source}] ignored self message: ${username}: ${message}`)
      return
    }
    if (this.config.debugRawChat) console.log(`[chat:${source}] ${username}: ${message}`)

    const commandMessage = this.normalizePrivateCommandText(message, source)
    const normalizedCommand = this.normalizeCommandText(commandMessage)
    if (!normalizedCommand.startsWith('!')) return

    // 急救必须绕过普通任务队列：它需要立即打断当前 bot 的任务。
    if (normalizedCommand === '!急救') {
      if (context.channel !== 'private' && !this.isPrivateSource(context.source || source)) {
        return
      }
      if (!this.isAdmin(username)) {
        this.msg(username, '你没有权限使用急救命令。')
        return
      }
      this.handleEmergencyRescue(username).catch(error => {
        console.error(`[emergency-rescue:${this.botId}] failed:`, error)
        this.msg(username, `急救失败：${error.message}`)
      })
      return
    }
    // 热重载同样绕过任务队列：管理员命令不占用 bot，流程会在后台等所有 bot 空闲。
    // 且各个 bot 都能受理（多 bot 在线时每只都会收到，第一只标记后其余直接跳过）。
    if (normalizedCommand === '!热重载') {
      if (!this.isAdmin(username)) {
        this.msg(username, '你没有权限使用热重载命令。')
        return
      }
      this.handleHotReload(username).catch(error => {
        console.error(`[hot-reload:${this.botId}] failed:`, error)
        this.msg(username, `热重载失败：${error.message}`)
      })
      return
    }
    // 玩家输入记录：原样保留玩家怎么输入的（公屏/私聊渠道、原始文本），
    // 后续是受理还是被去重/繁忙拦截，也挂在同一个 command trace 上。
    const inputTrace = startTrace({
      bot: this.botId,
      kind: 'command',
      actor: username,
      source,
      channel: context.channel || '',
      rawMessage: String(message || ''),
      command: normalizedCommand
    })
    const botGameCommand = this.isBotGameCommand(normalizedCommand)
    if (botGameCommand && this.isDuplicateCommand(username, normalizedCommand, source)) {
      traceEvent(inputTrace, 'input', 'command_rejected_duplicate', { decision: '重复命令，在去重窗口内忽略' })
      return
    }
    if (this.taskPool && !botGameCommand && !this.taskPool.acceptIncoming(username, normalizedCommand)) {
      traceEvent(inputTrace, 'input', 'command_rejected_busy', { decision: '机器人正忙或重复消息被拦截，命令未受理' })
      return
    }
    if (!this.taskPool && !botGameCommand && this.isDuplicateCommand(username, normalizedCommand, source)) {
      traceEvent(inputTrace, 'input', 'command_rejected_duplicate', { decision: '重复命令，在去重窗口内忽略' })
      return
    }
    traceEvent(inputTrace, 'input', 'command_accepted', { decision: '命令受理，进入处理流程' })
    const commandLogId = this.db.createCommandLog({
      username,
      commandText: this.redactSensitiveText(normalizedCommand),
      channel: context.channel || 'private',
      receiverBotId: this.botId,
      receiverBotName: this.bot.username || this.config.server?.botName || this.botId
    })
    traceEvent(inputTrace, 'input', 'command_context', {
      commandLogId,
      decision: 'commandLogId 可与后续取货 trace（trace_start.commandLogId）互相索引'
    })
    this.db.runWithCommandContext(commandLogId, () => this.withBotContext(() => this.handleChat(username, normalizedCommand, { ...context, source })))
      .catch(error => this.db.runWithCommandContext(commandLogId, () => this.withBotContext(() => this.handleCommandError(username, error))))
  }

  isDuplicateCommand (username, message, source) {
    const text = this.normalizeCommandText(message)
    if (!text.startsWith('!')) return false

    const key = `${username.toLowerCase()}|${text}`
    const now = Date.now()
    const last = this.seenMessages.get(key) || 0
    const dedupeMs = this.config.timing.commandDedupeMs || 1500
    if (now - last < dedupeMs) {
      if (this.config.debugChat) console.log(`[command:dedupe] ignored duplicate from ${source}: ${username} -> ${this.redactSensitiveText(text)}`)
      return true
    }

    this.seenMessages.set(key, now)
    return false
  }

  handleMessageString (message, position, sender) {
    if (this.config.debugRawChat) {
      const senderInfo = sender ? ` sender=${sender}` : ''
      console.log(`[messagestr:${position}]${senderInfo} ${message}`)
    }

    if (String(position || '').toLowerCase() === 'system' && this.subscriptions) {
      const payment = this.subscriptions.handleSystemMessage(message, this.bot.username || this.config.server?.botName || this.botId,
        (username, notice) => this.msg(username, notice))
      if (payment.matched) return
    }
    if (this.handleTeleportRequestMessage(message)) return

    const whisper = this.parsePrivateMessage(message)
    if (whisper) {
      this.handleIncoming(whisper.username, whisper.message, 'messagestr:private', { channel: 'private' })
      return
    }

    const parsed = this.parseCustomCommandMessage(message, sender)
    if (!parsed) return
    this.handleIncoming(parsed.username, parsed.command, 'messagestr', { channel: 'public' })
  }

  parsePrivateMessage (message) {
    const text = String(message || '').trim()
    const patterns = [
      /^\[([A-Za-z0-9_]{3,16})\s*[➥➦➤➜→>\-]+\s*([A-Za-z0-9_]{3,16})\]\s*(.+)$/,
      /^\[([A-Za-z0-9_]{3,16})\s*->\s*([A-Za-z0-9_]{3,16})\]\s*(.+)$/,
      /^([A-Za-z0-9_]{3,16})\s+悄悄地对你说[:：]\s*(.+)$/,
      /^([A-Za-z0-9_]{3,16})\s+whispers(?: to you)?[:：]?\s*(.+)$/i
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (!match) continue
      if (match.length === 4) {
        const [, from, to, body] = match
        if (this.isSelfUsername(from)) return null
        if (to !== this.bot.username) return null
        return { username: from, message: this.normalizeCommandText(body) }
      }
      const [, from, body] = match
      if (this.isSelfUsername(from)) return null
      return { username: from, message: this.normalizeCommandText(body) }
    }

    return null
  }

  parseCustomCommandMessage (message, sender) {
    if (this.isOutgoingPrivateMessage(message)) return null

    const commandMatch = this.findCommandAtChatBodyStart(message)
    if (!commandMatch) return null

    const command = this.normalizeCommandText(commandMatch.command)
    const beforeCommand = message.slice(0, commandMatch.index)
    const username = this.extractUsername(beforeCommand, sender)
    if (!username || this.isSelfUsername(username)) return null

    const key = `${username}|${command}|${message}`
    const now = Date.now()
    const last = this.seenMessages.get(key) || 0
    if (now - last < 1000) return null
    this.seenMessages.set(key, now)

    return { username, command }
  }

  handleTeleportRequestMessage (message) {
    const text = String(message || '').trim()
    const match = text.match(/^([A-Za-z0-9_]{3,16})\s+请求传送到你的位置$/)
    if (!match) return false

    const username = match[1]
    if (!this.isAdmin(username)) {
      if (this.config.debugChat) console.log(`[tpa] ignored non-admin teleport request from ${username}`)
      return true
    }

    const command = (this.config.commands.tpaccept || '/tpaccept {player}').replace('{player}', username)
    if (this.config.debugChat) console.log(`[tpa] accepting admin teleport request: ${command}`)
    this.bot.chat(command)
    return true
  }

  findCommandAtChatBodyStart (message) {
    const text = String(message || '')
    const commandPattern = /^\s*([!！][^\r\n]*)/

    const direct = text.match(commandPattern)
    if (direct) {
      return {
        command: direct[1],
        index: direct.index + direct[0].indexOf(direct[1])
      }
    }

    const arrowIndex = Math.max(text.lastIndexOf('>'), text.lastIndexOf('»'))
    if (arrowIndex >= 0) {
      const afterArrow = text.slice(arrowIndex + 1)
      const match = afterArrow.match(commandPattern)
      if (!match) return null
      return {
        command: match[1],
        index: arrowIndex + 1 + match.index + match[0].indexOf(match[1])
      }
    }

    const colonIndexes = [text.indexOf(':'), text.indexOf('：')].filter(index => index >= 0)
    if (!colonIndexes.length) return null
    const colonIndex = Math.min(...colonIndexes)
    const afterColon = text.slice(colonIndex + 1)
    const match = afterColon.match(commandPattern)
    if (!match) return null
    return {
      command: match[1],
      index: colonIndex + 1 + match.index + match[0].indexOf(match[1])
    }
  }

  isOutgoingPrivateMessage (message) {
    const text = String(message || '').trim()
    const match = text.match(/^\[([A-Za-z0-9_]{3,16})\s*[➥➦➤➜→>\-]+\s*([A-Za-z0-9_]{3,16})\]/)
    if (!match) return false
    const [, from, to] = match
    return this.isSelfUsername(from) || !this.isSelfUsername(to)
  }

  extractUsername (text, sender) {
    if (sender) {
      const player = Object.values(this.bot.players).find(entry => entry.uuid === sender)
      if (player?.username) return player.username
    }

    const names = Object.keys(this.bot.players)
      .filter(name => name !== this.bot.username)
      .sort((a, b) => b.length - a.length)

    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text)) {
        return name
      }
    }

    const fallback = text.match(/([A-Za-z0-9_]{3,16})\s*[:：>»]?\s*$/)
    return fallback?.[1] || null
  }

  usernameFromUuid (uuid) {
    if (!uuid) return null
    const normalized = String(uuid).toLowerCase()
    for (const [username, player] of Object.entries(this.bot.players)) {
      if (String(player.uuid || '').toLowerCase() === normalized) return username
    }
    return null
  }

  componentToText (component) {
    if (!component) return ''
    if (typeof component === 'string') {
      try {
        return this.componentToText(JSON.parse(component))
      } catch {
        return component
      }
    }
    if (Array.isArray(component)) return component.map(part => this.componentToText(part)).join('')
    if (component.type && Object.prototype.hasOwnProperty.call(component, 'value')) {
      return this.componentToText(component.value)
    }
    if (typeof component !== 'object') return String(component)

    let text = ''
    if (typeof component.text === 'string') text += component.text
    if (component.text?.value) text += component.text.value
    if (typeof component.translate === 'string') text += component.translate
    if (component.translate?.value) text += component.translate.value

    const extra = component.extra || component.with
    if (Array.isArray(extra)) text += extra.map(part => this.componentToText(part)).join('')
    if (extra?.value && Array.isArray(extra.value)) text += extra.value.map(part => this.componentToText(part)).join('')

    return text
  }

  handleCommandError (username, error) {
    if (error?.silent) {
      if (this.config.debug) console.warn(`[command:silent-cancel] ${username}: ${error.message}`)
      this.clearRecoveryTaskIfInventoryEmpty()
      this.active = null
      return
    }
    console.error(error)
    const context = this.active || error?.commandContext
    if (context?.type === 'withdraw' && context.targetUsername && context.targetUsername !== username) {
      const repair = context.deliveryMode === 'repair'
      this.msg(context.targetUsername, repair
        ? `${username} 给你修装备失败：${error.message}`
        : `${username} 给你的取货失败：${error.message}`)
      this.msg(username, repair
        ? `给 ${context.targetUsername} 修装备失败：${error.message}`
        : `给 ${context.targetUsername} 的取货失败：${error.message}`)
    } else {
      this.msg(username, `操作失败：${error.message}`)
    }
    this.clearRecoveryTaskIfInventoryEmpty()
    this.active = null
  }

  async handleChat (username, message, context = {}) {
    const text = this.normalizeCommandText(message)
    if (!text.startsWith('!')) return
    if (this.config.debugChat) console.log(`[command] ${username} -> ${this.redactSensitiveText(text)}`)
    this.touchPlayer(username)
    // 私聊进来的业务任务由收到私信的机器人执行；公屏保持原逻辑（任意空闲机器人接单）。
    const taskOptions = { stickyWorker: this.isPrivateSource(context.source) ? this : null }

    if (this.isBotGameCommand(text)) {
      await this.handleBotGameCommand(username, text, context)
      return
    }

    if (this.isWebLoginTokenCommand(text)) {
      await this.handleWebLoginToken(username, text, context)
      return
    }

    if (this.isWebLoginCodeCommand(text)) {
      await this.handleWebLoginCode(username, text, context)
      return
    }

    if (text.startsWith('!创建仓库')) {
      await this.handleCreateCustomWarehouse(username, text)
      return
    }

    if (text === '!我的仓库') {
      await this.handleMyCustomWarehouses(username)
      return
    }

    if (text === '!默认仓库' || text.startsWith('!设置默认仓库')) {
      await this.handleDefaultWarehouse(username, text)
      return
    }

    const personalCommand = this.parsePersonalWarehouseCommand(text)
    if (personalCommand) {
      await this.handlePersonalWarehouseCommand(username, personalCommand, taskOptions)
      return
    }

    const customCommand = this.parseCustomWarehouseCommand(text)
    if (customCommand) {
      await this.handleCustomWarehouseCommand(username, customCommand, taskOptions)
      return
    }

    if (text.startsWith('!查询') || text.startsWith('!查')) {
      await this.handleQuery(username, text, this.defaultStorageOwnerForPlayer(this.getPlayer(username)))
      return
    }

    if (text.startsWith('!额度')) {
      await this.handleQuota(username, text)
      return
    }

    if (text.startsWith('!加管理员') || text.startsWith('!加管理')) {
      await this.handleAddAdmin(username, text)
      return
    }

    if (text.startsWith('!设置额度')) {
      await this.handleSetQuota(username, text)
      return
    }

    if (text.startsWith('!增加') || text.startsWith('!减少')) {
      await this.handleAdjustBalance(username, text)
      return
    }

    if (text.startsWith('!清空库存') || text.startsWith('!清理库存')) {
      await this.handleClearInventory(username, text)
      return
    }

    if (text.startsWith('!同步木桶')) {
      await this.handleSyncBarrel(username, text)
      return
    }

    if (text.startsWith('!同步仓库') || text.startsWith('!同步')) {
      await this.handleSync(username, text)
      return
    }

    if (text === '!热重载') {
      // handleIncoming 已在更早处拦下 !热重载 并做了权限校验；
      // 这里只是兜底（如测试直接调 handleChat），不再重复校验权限。
      if (!this.isAdmin(username)) {
        this.msg(username, '你没有权限使用热重载命令。')
        return
      }
      await this.handleHotReload(username)
      return
    }

    if (/^!修装备(?:\s|$)?/.test(text)) {
      await this.handleRepairCommand(username, text, taskOptions)
      return
    }

    // Crafting is available to the owner of the selected personal or
    // organization warehouse; validateCraftOwner checks membership.
    if (text === '!合成恢复') {
      await this.handleCraftRecovery(username)
      return
    }
    if (text.startsWith('!合成')) {
      await this.handleCraft(username, text, this.defaultStorageOwnerForPlayer(this.getPlayer(username)))
      return
    }

    if (text === '!存物品' || text === '!存') {
      const player = this.getPlayer(username)
      if (!this.db.hasPersonalWarehouse(player.uuid) && this.subscriptions) this.subscriptions.maybeAutoRegister(player, 'deposit')
      const owner = this.defaultStorageOwnerForPlayer(player)
      await this.enqueueTask(username, 'deposit', worker => worker.handleDeposit(username, owner), taskOptions)
      return
    }

    if (/^!(存取|取存)(?:\s|$)/.test(text)) {
      const player = this.getPlayer(username)
      if (!this.db.hasPersonalWarehouse(player.uuid) && this.subscriptions) this.subscriptions.maybeAutoRegister(player, 'deposit')
      const owner = this.defaultStorageOwnerForPlayer(player)
      const withdrawText = text.replace(/^!(存取|取存)/, '!取')
      await this.enqueueTask(username, 'withdraw', worker => worker.handleWithdraw(username, withdrawText, owner, null, username, { continueWithDeposit: true }), taskOptions)
      return
    }

    if (text.startsWith('!取物品') || text.startsWith('!取')) {
      const owner = this.defaultStorageOwnerForPlayer(this.getPlayer(username))
      await this.enqueueTask(username, 'withdraw', worker => worker.handleWithdraw(username, text, owner), taskOptions)
    }
  }

  async handleEmergencyRescue (username) {
    if (this.emergencyRescueActive) return false
    this.emergencyRescueActive = true
    try {
      if (this.craftController?.isBusy() || this.db.hasPendingCraft?.(this.botId)) {
        this.craftController?.cancel('管理员急救请求：合成停止，物品保留归属等待恢复。')
        this.msg(username, '合成仍在结束或等待恢复，已请求停止；请在操作结束后执行 !合成恢复，核对物品归属。')
        return false
      }
      const cancelledQueued = this.taskPool?.cancelQueuedForWorker(this, 'emergency rescue') || 0
      if (cancelledQueued && this.config.debug) {
        console.log(`[emergency-rescue:${this.botId}] cancelled queued tasks=${cancelledQueued}`)
      }

      if (this.active) {
        this.active.cancelled = true
        this.active.emergency = true
      }
      this.bot.pathfinder?.stop()
      this.bot.clearControlStates?.()
      if (this.bot.currentWindow) this.bot.closeWindow(this.bot.currentWindow)

      const arrived = await this.teleportToPlayer(username, { ignoreCancellation: true })
      if (!arrived) return false

      const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      if (!held.length) {
        this.msg(username, '急救完成：机器人背包为空。')
        return true
      }
      const dropped = await this.dropWithdrawItemsToPlayer(username, held)
      this.msg(username, `急救完成：已丢出${this.formatDepositSummary(dropped.length ? dropped : held)}。`)
      return true
    } finally {
      this.emergencyRescueActive = false
      this.taskPool?.dispatch()
    }
  }

  // 管理员命令 !热重载：git pull 更新代码 → 等所有 bot 空闲 → 拉起新代码进程并退出旧进程。
  // 不占任务队列：流程在后台等待，管理员下达后可以继续干别的；重启前会把进度私聊给管理员。
  // 管理员命令 !热重载：git pull 更新代码 → 等所有 bot 空闲 → 拉起新代码进程并退出旧进程。
  // 不占任务队列：流程在后台等待，管理员下达后可以继续干别的；重启前会把进度私聊给管理员。
  // 重启通过“新进程先启动、旧进程再退出”实现，不依赖 pm2/systemd 等外部守护；
  // 多 bot 在线时每只都能受理该命令，但 hotReloadRunning 标志保证只有一个流程在跑。
  handleHotReload (username) {
    if (this.hotReloadRunning) {
      this.msg(username, '热重载已在进行中，请等待完成。')
      return Promise.resolve({ status: 'already_running' })
    }
    this.hotReloadRunning = true
    const finish = () => { this.hotReloadRunning = false }
    const stubs = this.hotReloadStubs || {}
    return runHotReload({
      notify: message => this.msg(username, message),
      taskPool: this.taskPool,
      idleTimeoutMs: this.config.timing?.hotReloadIdleTimeoutMs,
      spawnSuccessor: this.config.timing?.hotReloadSpawnSuccessor === true,
      gitExec: stubs.gitExec,
      gitPull: stubs.gitPull,
      waitForIdle: stubs.waitForIdle,
      scheduleSuccessorProcess: stubs.scheduleSuccessorProcess,
      shutdown: () => {
        // 让本 bot 手头任务尽快收尾：标记取消并断开连接（其他 bot 由 index.js 的收尾钩子处理）。
        this.invalidateConnection('hot reload restart')
        this.hotReloadShutdownHook?.()
      },
      exitProcess: async () => {
        finish()
        // hotReloadExitHook 未注入（测试桩）时不退出，返回 false 让流程走完但进程保留。
        const exited = await this.hotReloadExitHook?.()
        return exited !== false
      }
    })
      .then(result => {
        if (result?.status !== 'restarting') finish()
        return result
      })
      .catch(error => {
        finish()
        throw error
      })
  }

  async runExclusive (username, type, fn, extra = {}) {
    // The task pool already owns this craft's exclusive lease. Recover directly
    // before setting active; enqueueing another exclusive task here would wait
    // on this very task. Other bots' journals retain the upstream global guard.
    if (type === 'craft' && this.db.hasPendingCraft?.(this.botId)) {
      if (this.connectionInvalidated) throw new Error('连接已失效，合成恢复留待原机器人重连。')
      await this.withBotContext(() => this.getCraftController().recover())
    }
    if (type !== 'craft_recovery') this.db.assertNoPendingCraft?.()
    const migration = this.db.runDeferredMigrations?.()
    if (migration?.catalogError || migration?.offlineIdentityError) {
      throw new Error('恢复后的库存身份迁移尚未完成，请检查日志并重试。')
    }
    const active = { type, username, cancelled: false, dead: false, phase: 'start', player: null, ...extra }
    this.active = active
    try {
      return await this.db.runWithCommandContext(active.commandLogId, () => this.withBotContext(fn))
    } catch (error) {
      if (error && typeof error === 'object' && !error.commandContext) {
        error.commandContext = { ...active }
      }
      throw error
    } finally {
      if (active.reservationId) this.db.releaseInventoryReservation(active.reservationId)
      if (this.active === active) this.active = null
    }
  }

  withBotContext (fn) {
    return this.db.runWithBotContext({
      botId: this.botId,
      botName: this.bot.username || this.config.server?.botName || this.botId
    }, fn)
  }

  enqueueTask (username, type, run, options = {}) {
    if (!this.taskPool) return this.runExclusive(username, type, () => run(this))
    const stickyWorker = options.stickyWorker &&
      (type === 'craft_recovery' || this.taskPool.workers.has(options.stickyWorker))
      ? options.stickyWorker
      : null
    return this.taskPool.enqueue({
      username,
      type,
      run,
      commandLogId: this.db.currentCommandLogId(),
      exclusive: Boolean(options.exclusive),
      stickyWorker,
      onQueued: position => {
        const stickyBusy = stickyWorker && (stickyWorker.active || stickyWorker.recoveringFromDeath)
        if (position > 1 || stickyBusy || ![...this.taskPool.workers].some(worker => worker.ready && !worker.active)) {
          this.msg(username, stickyWorker
            ? `任务已加入队列，将等待 ${stickyWorker.bot?.username || stickyWorker.botId || this.bot.username} 处理，前面还有 ${Math.max(0, position - 1)} 个任务。`
            : `任务已加入队列，前面还有 ${Math.max(0, position - 1)} 个任务。`)
        }
      }
    })
  }

  startWebDeposit (user, ownerUuid) {
    const owner = this.resolveWebStorageOwner(user, ownerUuid)
    this.enqueueTask(user.username, 'deposit', worker => worker.handleDeposit(user.username, owner))
      .catch(error => this.handleCommandError(user.username, error))
    return `存货任务已提交到${this.ownerScopeName(owner)}，空闲机器人会自动处理。`
  }

  startWebWithdraw (user, ownerUuid, itemText, amount, targetUsername = '') {
    return this.startWebWithdrawMany(user, ownerUuid, [{ item: itemText, amount }], targetUsername)
  }

  startWebWithdrawMany (user, ownerUuid, webRequests, targetUsername = '') {
    const owner = this.resolveWebStorageOwner(user, ownerUuid)
    if (!Array.isArray(webRequests) || !webRequests.length) throw new Error('请先选择要取出的物品。')
    const target = String(targetUsername || user.username || '').trim()
    if (!/^[A-Za-z0-9_]{3,16}$/.test(target)) throw new Error('目标玩家 ID 格式不正确。')

    const requests = this.normalizeWebWithdrawRequests(user, webRequests)

    // Web 端取货输入记录：谁在网页上取了什么、交给谁、从哪个仓库取。
    traceStandalone('command', 'input', 'web_withdraw_request', {
      bot: this.botId,
      actor: user.username,
      source: 'web',
      owner,
      ownerLabel: this.ownerScopeName(owner),
      target,
      requests: requests.map(request => ({
        name: request.displayName || request.itemId,
        amount: request.amount,
        keyTail: shortKey(request.itemKey)
      })),
      decision: '玩家通过 Web 面板提交取货任务'
    })
    this.enqueueTask(user.username, 'withdraw', worker => worker.handleWithdraw(user.username, '', owner, requests, target))
      .catch(error => this.handleCommandError(user.username, error))
    return target === user.username
      ? `取货任务已提交，将从${this.ownerScopeName(owner)}取出 ${requests.length} 种物品。`
      : `取货任务已提交，将从${this.ownerScopeName(owner)}取出 ${requests.length} 种物品并交给 ${target}。`
  }

  normalizeWebWithdrawRequests (user, webRequests) {
    if (!Array.isArray(webRequests) || !webRequests.length) throw new Error('请先选择要取出的物品。')
    return webRequests.map((entry, requestIndex) => {
      const count = this.parsePositiveAmount(entry?.amount, '取出数量')
      let resolved = null
      if (entry?.itemKey) {
        const item = this.db.getItemByKey(entry.itemKey)
        if (!item) throw new Error(`找不到物品：${entry.itemKey}`)
        resolved = { ...item, displayName: String(entry.displayName || '').trim() || item.displayName }
      } else {
        const item = String(entry?.item || '').trim()
        if (!item) throw new Error('请填写要取出的物品。')
        resolved = this.resolveStoredItem(item, user.uuid)
      }
      return { ...resolved, amount: count, requestIndex }
    })
  }

  // Read-only withdrawal planning shared by Web previews and the execution path.
  // It deliberately stops before reservation, deduction, or any other mutation.
  previewWithdrawShortage (user, ownerUuid, webRequests) {
    const owner = this.resolveWebStorageOwner(user, ownerUuid)
    const requests = this.normalizeWebWithdrawRequests(user, webRequests)
    const player = { uuid: user.uuid, username: user.username }
    const plan = this.buildWithdrawPlanForRequest(player, owner, requests)
    const eligibleOwnerUuids = this.withdrawSourceOwners(player, owner).map(source => source.uuid)
    const shortage = this.buildShortageCraftPlan(owner, requests, plan.allocations, { eligibleOwnerUuids })
    return {
      owner,
      requests,
      notices: plan.notices || [],
      allocations: plan.allocations || [],
      ...shortage,
      // Keep the singular alias used by Web/projection clients while retaining
      // the planner's explicit plural field for callers that need the raw list.
      shortage: shortage.shortages
    }
  }

  buildShortageCraftPlan (owner, requests, allocations = [], options = {}) {
    const reservationsAlreadyApplied = Boolean(options?.reservationsAlreadyApplied)
    const primaryOwnerUuid = typeof owner === 'string' ? owner : owner?.uuid
    const ownerUuids = new Set()
    if (primaryOwnerUuid) ownerUuids.add(String(primaryOwnerUuid))
    for (const ownerUuid of options?.eligibleOwnerUuids || []) {
      if (ownerUuid) ownerUuids.add(String(ownerUuid))
    }
    for (const allocation of allocations || []) {
      if (allocation?.ownerUuid) ownerUuids.add(String(allocation.ownerUuid))
    }

    // CraftLedger exposes loose balances with their exact item keys. Remove
    // only the keys/amounts assigned to this withdrawal before aggregating by
    // item id, so a planned pickup cannot also become a craft input.
    const consumedByKey = new Map()
    if (!reservationsAlreadyApplied) {
      for (const allocation of allocations || []) {
        if (allocation?.withdrawMode === 'shulker_extract') continue
        const itemKey = String(allocation?.itemKey || '')
        if (!itemKey) continue
        const ownerUuid = String(allocation?.ownerUuid || primaryOwnerUuid || '')
        const amount = Number(allocation?.amount || 0)
        if (!ownerUuid || !Number.isFinite(amount) || amount <= 0) continue
        const key = `${ownerUuid}\u0000${itemKey}`
        consumedByKey.set(key, Number(consumedByKey.get(key) || 0) + amount)
      }
    }

    const stockByOwner = new Map()
    for (const ownerUuid of ownerUuids) {
      const availableCraftStock = {}
      const ownerConsumedByKey = new Map()
      for (const [key, amount] of consumedByKey) {
        if (key.startsWith(`${ownerUuid}\u0000`)) ownerConsumedByKey.set(key, amount)
      }
      let rows = []
      try {
        rows = typeof this.db.getCraftAvailableItems === 'function'
          ? this.db.getCraftAvailableItems(ownerUuid) || []
          : this.craftLedger().getCraftAvailableItems(ownerUuid) || []
      } catch {
        // Lightweight service fixtures may not provide a CraftLedger DB. An
        // empty snapshot keeps preview/read-only semantics intact.
        rows = []
      }
      for (const row of rows) {
        const itemId = normalizeItemId(row?.itemId)
        const itemKey = String(row?.itemKey || '')
        const amount = Number(row?.amount || 0)
        if (!itemId || !Number.isFinite(amount) || amount <= 0) continue
        const rowOwner = String(row?.ownerUuid || ownerUuid)
        const consumedKey = `${rowOwner}\u0000${itemKey}`
        const consumed = Number(ownerConsumedByKey.get(consumedKey) || 0)
        const remaining = Math.max(0, amount - consumed)
        if (ownerConsumedByKey.has(consumedKey)) ownerConsumedByKey.set(consumedKey, Math.max(0, consumed - amount))
        if (!remaining) continue
        const name = itemId.replace(/^minecraft:/, '')
        availableCraftStock[name] = Number(availableCraftStock[name] || 0) + remaining
      }
      stockByOwner.set(ownerUuid, availableCraftStock)
    }

    return planShortages({
      requests,
      allocations,
      availableCraftStock: {},
      availableCraftStockByOwner: stockByOwner,
      config: this.config,
      catalog: this.catalog
    })
  }

  resolveWebStorageOwner (user, ownerUuid) {
    const owner = String(ownerUuid || user.uuid || '').trim()
    if (!owner) throw new Error('缺少仓库归属。')
    if (!this.db.canWebUserAccessOwner(user, owner)) {
      throw new Error('你没有权限操作这个仓库。')
    }
    if (owner.startsWith('vault:')) {
      const warehouse = this.db.getCustomWarehouse(owner.slice(6))
      if (!warehouse) throw new Error(`找不到自定义仓库：${owner}`)
      return this.resolveCustomWarehouseOwner(warehouse)
    }
    if (owner === user.uuid) {
      return { uuid: user.uuid, username: user.username, scope: 'personal' }
    }
    const player = [...Object.keys(this.bot.players)]
      .find(name => this.bot.players[name]?.uuid === owner)
    const known = player ? this.resolvePlayer(player) : null
    const username = known?.username || this.db.ownerLabel(owner)
    return { uuid: owner, username, scope: 'personal' }
  }

  async handleDeposit (username, owner = null, options = {}) {
    const player = this.getPlayer(username)
    const storageOwner = owner || { ...player, scope: 'personal' }
    const alreadyAtPlayer = Boolean(options.alreadyAtPlayer)
    let sessionLogged = false
    // 存货链路日志：与取货同格式，写入 logs/withdraw-trace-日期.jsonl（kind=deposit）。
    const trace = startTrace({
      bot: this.botId,
      kind: 'deposit',
      actor: username,
      owner: storageOwner.uuid,
      ownerLabel: this.ownerScopeName(storageOwner),
      source: alreadyAtPlayer ? 'withdraw_continue' : 'deposit'
    })
    this.attachWarehouseTrace(trace)
    const logSession = (status, items = [], extra = {}) => {
      if (sessionLogged) return
      sessionLogged = true
      this.logDepositSession(username, storageOwner, status, items, extra)
      traceSummary(trace, {
        status,
        itemCount: this.totalAmount(items || []),
        phase: extra.phase || '',
        reason: extra.reason || ''
      })
    }
    const logCancelledSession = () => {
      const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      logSession('cancelled', held, {
        phase: this.active?.phase || 'unknown',
        reason: this.active?.dead ? 'death' : 'cancelled'
      })
    }

    if (this.active) {
      this.active.player = player
      this.active.owner = storageOwner
      this.active.phase = 'prepare_deposit'
    }
    try {
      if (!alreadyAtPlayer) {
        this.msg(username, `准备存入${this.ownerScopeName(storageOwner)}，请稍等。`)
        if (this.bot.inventory.items().length) {
          traceEvent(trace, 'deposit', 'residual_flush_start', {
            decision: '背包有上次残留物品，先回仓清点入库再开始本次存货'
          })
          await this.warehouse.goHomeIfAway()
          if (this.isActiveCancelled()) {
            logCancelledSession()
            return
          }
          await this.flushResidual()
          if (this.isActiveCancelled()) {
            logCancelledSession()
            return
          }
        }

        const quota = this.getStorageQuota(storageOwner.uuid, storageOwner.scope)
        if (quota.usedSlots >= quota.quotaSlots) {
          logSession('quota_full', [], {
            phase: this.active?.phase || 'quota_check',
            usedSlots: quota.usedSlots,
            quotaSlots: quota.quotaSlots
          })
          traceEvent(trace, 'decision', 'quota_full', {
            usedSlots: quota.usedSlots,
            quotaSlots: quota.quotaSlots,
            decision: '库存额度已满，拒绝存货'
          })
          this.msg(username, `${this.ownerSubjectName(storageOwner)}额度已满：${quota.usedSlots}/${quota.quotaSlots} 格。请先取出一些物品。`)
          return
        }

        if (this.active) this.active.phase = 'deposit_teleport_to_player'
        const teleported = await this.teleportToPlayer(username)
        traceEvent(trace, 'delivery', 'teleport_to_player', {
          target: username,
          ok: Boolean(teleported)
        })
        if (!teleported) {
          await this.warehouse.waitForPickupSettle()
          const receivedAfterTimeout = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
          if (receivedAfterTimeout.length) {
            traceEvent(trace, 'decision', 'teleport_timeout_but_received', {
              held: receivedAfterTimeout.map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
              decision: '传送超时但已收到物品，直接回仓入库'
            })
            this.msg(username, `没有检测到你在附近，但已收到物品，正在存入${this.ownerScopeName(storageOwner)}。`)
            if (this.active) this.active.phase = 'deposit_return_home'
            this.saveRecoveryTask('deposit', username, storageOwner, username, 'deposit_return_home')
            await this.warehouse.goHome({ requireWarehouse: true })
            if (this.active) this.active.phase = 'deposit_storing'
            this.saveRecoveryTask('deposit', username, storageOwner, username, 'deposit_storing')
            const result = await this.warehouse.depositInventoryForOwner(storageOwner.uuid, storageOwner.username)
            const status = result.deposited.length
              ? (result.leftover.length ? 'partial_after_teleport_timeout' : 'ok_after_teleport_timeout')
              : (result.leftover.length ? 'no_space_after_teleport_timeout' : 'empty_after_teleport_timeout')
            logSession(status, result.deposited.length ? result.deposited : result.leftover, {
              phase: this.active?.phase || 'deposit_storing',
              depositedAmount: this.totalAmount(result.deposited),
              leftoverAmount: this.totalAmount(result.leftover),
              reason: 'teleport_timeout_with_inventory'
            })
            if (result.deposited.length) {
              const prefix = result.leftover.length ? '部分存入' : '存入完成'
              this.msg(username, `${this.ownerActionPrefix(storageOwner)}${prefix}：${this.formatDepositSummary(result.deposited)}。`)
            } else {
              this.msg(username, result.leftover.length ? `收到物品但暂时无法入库：${this.formatDepositSummary(result.leftover)}。` : '没有收到可入库的物品。')
            }
            if (result.leftover.length) {
              this.accountResidualAsMomo(result.leftover, `deposit leftover after teleport timeout, actor=${username}, owner=${storageOwner.uuid}`)
              const reason = result.stopReason ? `${result.stopReason} ` : '仓库空间不足，'
              this.msg(username, `${reason}剩余${this.formatDepositSummary(result.leftover)}已转记为 momo，避免影响下一个玩家。`)
            }
            this.db.clearRecoveryTask(this.botId)
            return
          }
          logSession('teleport_timeout', [], {
            phase: this.active?.phase || 'deposit_teleport_to_player',
            timeoutMs: this.config.timing.teleportRequestTimeoutMs || 15000
          })
          return
        }
        if (this.isActiveCancelled()) {
          logCancelledSession()
          return
        }
      }
      if (this.active) {
        this.active.type = 'deposit'
        this.active.phase = 'deposit_collecting'
        this.active.targetUsername = username
      }
      this.saveRecoveryTask('deposit', username, storageOwner, username, 'deposit_collecting')
      const leaveDistance = Number(this.config.timing.depositLeaveDistance || 4)
      this.msg(username, `开始收集物品，请在10秒内丢给我；你离开机器人超过${leaveDistance}格后会提前结束。`)

      const deadline = Date.now() + this.config.timing.pickupWindowMs
      const shouldStopCollecting = () => {
        if (this.active?.cancelled) return true
        // 背包捡满就提前结束收集（与"玩家远离"同级的提前结束条件）：满背包
        // 捡不起玩家丢的物品，干等窗口结束只会让地上的物品堆积甚至消失，
        // 不如立即回去入库，玩家想继续存可以再叫一次。
        if (this.bot.inventory.emptySlotCount?.() === 0) {
          if (this.active) this.active.depositStopReason = 'inventory_full'
          return true
        }
        const playerEntity = this.resolvePlayerEntity(username).entity
        const botPosition = this.bot.entity?.position
        if (!playerEntity?.position || !botPosition) return false
        const distance = playerEntity.position.distanceTo(botPosition)
        if (distance <= leaveDistance) return false
        if (this.active) {
          this.active.depositStopReason = 'player_left'
          this.active.depositPlayerDistance = distance
        }
        return true
      }
      if (this.config.debug) console.log(`[deposit] collecting for ${username}, window=${this.config.timing.pickupWindowMs}ms`)
      await this.warehouse.collectNearbyDropsUntil(deadline, shouldStopCollecting)
      if (this.config.debug) console.log(`[deposit] collect window ended for ${username}, cancelled=${this.active?.cancelled}, reason=${this.active?.depositStopReason || 'timeout'}`)
      if (this.isActiveCancelled()) {
        logCancelledSession()
        return
      }
      await this.warehouse.waitForPickupSettle()
      const collected = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      traceEvent(trace, 'deposit', 'collect_done', {
        stopReason: this.active?.depositStopReason || 'timeout',
        held: collected.map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
        decision: collected.length
          ? `收集结束：收到 ${collected.reduce((sum, item) => sum + item.amount, 0)} 个物品`
          : '收集结束：没有收到物品'
      })

      if (this.active) this.active.phase = 'deposit_return_home'
      await this.warehouse.goHome({ requireWarehouse: true })
      if (this.isActiveCancelled()) {
        logCancelledSession()
        return
      }
      if (this.active) this.active.phase = 'deposit_storing'
      this.saveRecoveryTask('deposit', username, storageOwner, username, 'deposit_storing')
      const result = await this.warehouse.depositInventoryForOwner(storageOwner.uuid, storageOwner.username)
      traceEvent(trace, 'deposit', 'deposit_flow_result', {
        deposited: (result.deposited || []).map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
        leftover: (result.leftover || []).map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
        stopReason: result.stopReason || '',
        decision: result.deposited.length
          ? `入库 ${this.totalAmount(result.deposited)} 个${result.leftover.length ? `，剩余 ${this.totalAmount(result.leftover)} 个无法入库` : ''}`
          : (result.leftover.length ? '没有任何物品入库' : '背包是空的，没有可入库物品')
      })
      const status = result.deposited.length
        ? (result.leftover.length ? 'partial' : 'ok')
        : (result.leftover.length ? 'no_space' : 'empty')
      logSession(status, result.deposited.length ? result.deposited : result.leftover, {
        phase: this.active?.phase || 'deposit_storing',
        depositedAmount: this.totalAmount(result.deposited),
        leftoverAmount: this.totalAmount(result.leftover),
        stopReason: this.active?.depositStopReason || 'timeout',
        playerDistance: this.active?.depositPlayerDistance || 0
      })
      if (result.deposited.length) {
        const prefix = result.leftover.length ? '部分存入' : '存入完成'
        this.msg(username, `${this.ownerActionPrefix(storageOwner)}${prefix}：${this.formatDepositSummary(result.deposited)}。`)
      } else {
        this.msg(username, result.leftover.length ? `收到物品但暂时无法入库：${this.formatDepositSummary(result.leftover)}。` : '没有收到可入库的物品。')
      }

      if (result.leftover.length) {
        traceEvent(trace, 'decision', 'leftover_to_momo', {
          leftover: (result.leftover || []).map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
          reason: result.stopReason || '仓库空间不足',
          decision: '未能入库的剩余物品转记为 momo'
        })
        this.accountResidualAsMomo(result.leftover, `deposit leftover, actor=${username}, owner=${storageOwner.uuid}`)
        const reason = result.stopReason ? `${result.stopReason} ` : '仓库空间不足，'
        this.msg(username, `${reason}剩余${this.formatDepositSummary(result.leftover)}已转记为 momo，避免影响下一个玩家。`)
      }
      this.db.clearRecoveryTask(this.botId)
    } catch (error) {
      const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      logSession('error', held, {
        phase: this.active?.phase || 'unknown',
        error: error.message
      })
      traceEvent(trace, 'error', 'deposit_error', {
        message: error?.message || String(error),
        phase: this.active?.phase || ''
      })
      throw error
    } finally {
      this.detachWarehouseTrace()
    }
  }

  logDepositSession (actorUsername, owner, status, items = [], extra = {}) {
    const details = {
      actor: actorUsername,
      owner: owner.uuid,
      scope: owner.scope || 'personal',
      ...extra
    }
    if (owner.vaultName) details.vault = owner.vaultName
    const message = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, ' ')}`)
      .join(', ')
    this.db.addTransaction('deposit_session', status, owner.uuid, owner.username, items, message)
  }

  async handleRepairCommand (username, text, taskOptions = {}) {
    const actor = this.getPlayer(username)
    const storageOwner = this.defaultStorageOwnerForPlayer(actor)
    const targetUsername = this.parseRepairTarget(text, username)
    const request = this.buildRepairBottleRequest()
    await this.enqueueTask(username, 'withdraw', worker => worker.handleWithdraw(
      username,
      '',
      storageOwner,
      [request],
      targetUsername,
      { deliveryMode: 'repair' }
    ), taskOptions)
  }

  parseRepairTarget (text, fallbackUsername) {
    const raw = String(text || '').replace(/^!修装备(?:\s+)?/, '').trim()
    if (!raw) return fallbackUsername
    if (!/^[A-Za-z0-9_]{3,16}$/.test(raw)) throw new Error('目标玩家 ID 格式不正确。')
    return raw
  }

  buildRepairBottleRequest () {
    return {
      itemId: REPAIR_BOTTLE_ITEM_ID,
      displayName: this.catalog.getDisplayName(REPAIR_BOTTLE_ITEM_ID) || '经验瓶',
      amount: REPAIR_BOTTLE_AMOUNT
    }
  }

  async handleWithdraw (username, text, owner = null, prebuiltRequests = null, targetUsername = username, options = {}) {
    const player = this.getPlayer(username)
    const storageOwner = owner || { ...player, scope: 'personal' }
    const continueWithDeposit = Boolean(options.continueWithDeposit)
    const deliveryMode = options.deliveryMode === 'repair' ? 'repair' : 'drop'
    const parsedWithdraw = prebuiltRequests
      ? { requests: prebuiltRequests, targetUsername: String(targetUsername || username).trim() }
      : this.parseWithdrawCommand(text, storageOwner, targetUsername || username, player.uuid)
    const deliveryTarget = String(parsedWithdraw.targetUsername || username).trim()
    const deliveryToOther = deliveryTarget !== username
    if (continueWithDeposit && deliveryToOther) {
      throw new Error('存取/取存只能由本人接收物品，不能指定其他目标玩家。')
    }
    if (this.active) {
      this.active.player = player
      this.active.owner = storageOwner
      this.active.targetUsername = deliveryTarget
      this.active.deliveryMode = deliveryMode
      this.active.phase = 'prepare_withdraw'
    }
    const requests = parsedWithdraw.requests
    if (!requests.length) {
      this.msg(username, `格式示例：${storageOwner.scope === 'custom' ? `!${storageOwner.vaultName} 取 石英块64` : '!取 石英块64 石头128 红石块3'}`)
      return
    }

    // 链路日志：从这一刻起，本次取货的每个动作/决策都写入 logs/withdraw-trace-日期.jsonl，
    // 出问题时把对应日期的文件和里面的 traceId 发回来即可逐环节排查。
    const trace = startTrace({
      bot: this.botId,
      kind: 'withdraw',
      actor: username,
      target: deliveryTarget,
      owner: storageOwner.uuid,
      ownerLabel: this.ownerScopeName(storageOwner),
      mode: deliveryMode,
      source: prebuiltRequests ? 'web' : 'chat',
      commandText: prebuiltRequests ? '' : String(text || ''),
      commandLogId: this.db.currentCommandLogId?.() || 0,
      requests: requests.map(request => ({
        name: request.displayName || request.itemId,
        amount: request.amount,
        keyTail: shortKey(request.itemKey)
      }))
    })
    this.attachWarehouseTrace(trace)
    let summary = { status: 'interrupted', delivered: [], missing: [] }
    try {
      summary = await this.runWithdrawFlow({
        username,
        player,
        storageOwner,
        requests,
        deliveryTarget,
        deliveryToOther,
        deliveryMode,
        continueWithDeposit,
        trace
      }) || summary
    } catch (error) {
      traceEvent(trace, 'error', 'task_error', {
        message: error?.message || String(error),
        phase: this.active?.phase || ''
      })
      throw error
    } finally {
      traceSummary(trace, {
        status: summary.status,
        deliveredTypes: this.itemTypeCount(summary.delivered || []),
        deliveredTotal: this.totalAmount(summary.delivered || []),
        missingTypes: this.itemTypeCount(summary.missing || []),
        missingTotal: this.totalAmount(summary.missing || [])
      })
      this.detachWarehouseTrace()
    }
  }

  async runWithdrawFlow ({ username, player, storageOwner, requests, deliveryTarget, deliveryToOther, deliveryMode, continueWithDeposit, trace }) {
    const msgActor = message => {
      this.msg(username, message)
    }
    const msgTarget = message => this.msg(deliveryTarget, message)
    const eligibleOwnerUuids = this.withdrawSourceOwners(player, storageOwner).map(owner => owner.uuid)
    let shortagePlan = null
    const withShortagePlan = result => shortagePlan
      ? {
          ...result,
          shortagePlan,
          shortages: shortagePlan.shortages,
          shortage: shortagePlan.shortages,
          craft: shortagePlan.craft
        }
      : result
    const recordShortagePlan = (allocations, options, decision) => {
      shortagePlan = this.buildShortageCraftPlan(storageOwner, requests, allocations, {
        ...options,
        eligibleOwnerUuids
      })
      traceEvent(trace, 'plan', 'shortage_plan', {
        requested: shortagePlan.requested,
        allocated: shortagePlan.allocated,
        shortages: shortagePlan.shortages,
        craft: shortagePlan.craft,
        decision
      })
      return shortagePlan
    }
    await this.warehouse.goHomeIfAway()
    if (this.isActiveCancelled()) return { status: 'cancelled', delivered: [], missing: [] }
    await this.flushResidual()
    if (this.isActiveCancelled()) return { status: 'cancelled', delivered: [], missing: [] }

    const plan = this.buildWithdrawPlanForRequest(player, storageOwner, requests)
    traceEvent(trace, 'plan', 'plan_result', {
      notices: plan.notices,
      allocations: plan.allocations.map(item => ({
        name: item.displayName || item.itemId,
        amount: item.amount,
        mode: item.withdrawMode === 'shulker_extract' ? 'shulker_extract' : 'loose',
        sourceBox: item.withdrawMode === 'shulker_extract'
          ? { name: item.sourceShulkerDisplayName || item.sourceShulkerItemKey || '', keyTail: shortKey(item.sourceShulkerItemKey || ''), boxes: item.sourceBoxCount || 0 }
          : undefined,
        keyTail: shortKey(item.itemKey),
        ownerScope: item.ownerScope || storageOwner.scope || ''
      })),
      decision: `按账本拆解为 ${plan.allocations.length} 条取货计划（散装/拆盒），预留库存后逐批执行`
    })
    if (!deliveryToOther) {
      for (const notice of plan.notices) this.msg(username, notice)
    }

    if (!plan.allocations.length) {
      recordShortagePlan(
        plan.allocations,
        { reservationsAlreadyApplied: false },
        '没有可直接取出的库存，按当前散装库存计算缺口合成候选（仅记录，不执行合成）'
      )
      if (deliveryToOther) {
        msgTarget(deliveryMode === 'repair'
          ? `${username} 想给你修装备，但仓库没有可用的经验瓶。`
          : `${username} 想给你取物品，但仓库没有可取出的物品。`)
        msgActor(deliveryMode === 'repair'
          ? `给 ${deliveryTarget} 修装备失败：仓库没有可用的经验瓶。`
          : `给 ${deliveryTarget} 的取货失败：仓库没有可取出的物品。`)
      }
      else this.msg(username, '没有可取出的物品。')
      return withShortagePlan({ status: 'empty_plan', delivered: [], missing: [] })
    }

    const reservationId = `${this.botId}:${this.active?.taskId || Date.now()}`
    this.db.reserveInventory(reservationId, plan.allocations)
    if (this.active) this.active.reservationId = reservationId
    traceEvent(trace, 'plan', 'reserve_inventory', { reservationId })

    // Reservations are already reflected by CraftLedger's available-item
    // query, so avoid subtracting these allocations a second time here.
    recordShortagePlan(
      plan.allocations,
      { reservationsAlreadyApplied: true },
      '取货预留已建立，按当前散装库存重新计算缺口合成候选（仅记录，不执行合成）'
    )

    const batches = this.splitAllocationsIntoInventoryBatches(plan.allocations, 36)
    traceEvent(trace, 'plan', 'batches_split', {
      batches: batches.length,
      batchItems: batches.map(batch => batch.map(item => `${item.displayName || item.itemId}x${item.amount}${item.withdrawMode === 'shulker_extract' ? '(拆盒)' : ''}`))
    })

    const teleportNotice = deliveryMode === 'repair'
      ? `正在从${this.ownerScopeName(storageOwner)}取经验瓶给你修装备，离开4格后自动结束。`
      : (deliveryToOther
          ? `${username} 正在从${this.ownerScopeName(storageOwner)}给你取物品${this.withdrawBatchNoticeSuffix(batches.length)}，请${batches.length > 1 ? '每次' : '稍后'}接受机器人的传送请求。`
          : `正在从${this.ownerScopeName(storageOwner)}给你取物品${this.withdrawBatchNoticeSuffix(batches.length)}，请${batches.length > 1 ? '每次' : '稍后'}接受机器人的传送请求。`)
    if (deliveryToOther) msgTarget(teleportNotice)
    else msgActor(teleportNotice)

    const runBatches = () => this.runWithdrawBatches({
      username,
      storageOwner,
      deliveryTarget,
      deliveryToOther,
      deliveryMode,
      batches,
      continueWithDeposit,
      msgActor,
      msgTarget,
      trace
    })

    let attempt = await runBatches()
    if (attempt.cancelled || attempt.aborted) return withShortagePlan({ status: attempt.aborted ? 'aborted' : 'cancelled', delivered: [], missing: [] })

    let deliveredTotal = this.mergeItems(attempt.allDeducted)
    if (!deliveredTotal.length) {
      // 缺失物品全部没有木桶位置记录（有账无物）：warehouse 已按距离逐个打开
      // 已登记木桶现场找过并刷新了记录，这里不再做无效的就地核对重试。
      // 残余物品不入库，留给后续任务的 flushResidual / 任务收尾统一处理。
      const unlocatedKeys = new Set((attempt.allUnlocated || []).map(item => item.itemKey))
      const missingItems = attempt.allMissing || []
      if (missingItems.length && missingItems.every(item => unlocatedKeys.has(item.itemKey))) {
        const searchedBarrels = Number(attempt.searchedUnlocatedBarrels) || 0
        traceEvent(trace, 'decision', 'skip_retry_unlocated', {
          missing: missingItems.map(item => ({ name: item.displayName || item.itemId, amount: item.amount, keyTail: shortKey(item.itemKey) })),
          searchedBarrels,
          decision: '缺失物品全部没有位置记录：已现场搜桶并刷新记录，跳过就地核对重试，残余不入库'
        })
        await this.warehouse.goHome({ requireWarehouse: true })
        const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
        if (held.length) {
          msgActor(`机器人身上保留着 ${held.length} 种物品，将在后续任务开始前统一回仓。`)
        }
        // 缺口已现场确认：当场修账（扣 owner 余额 + 留痕），Web 库存立即与实物一致。
        this.autoReconcileConfirmedMissing(storageOwner, missingItems, username)
        msgActor(`账本有库存，但已逐个打开 ${searchedBarrels} 个木桶仍找不到实物：${this.formatItemList(missingItems)}。已自动同步账本并登记库存异常，管理员可在Web管理页复核。`)
        this.db.clearRecoveryTask(this.botId)
        return withShortagePlan({ status: 'failed_no_location', delivered: [], missing: this.mergeItems(missingItems) })
      }

      // 取货时已就地核对每个木桶：实物少了当场刷新该木桶记录，读到整桶为空按服务器卡顿处理并保留原记录。
      // 这里先把残余放回清点，再按最新木桶记录立即重试一次，不做耗时的全仓同步。
      traceEvent(trace, 'decision', 'retry_after_recheck', {
        decision: '一批都没取到：先回仓把残余放回清点，按刚刷新的木桶记录立即重试一轮'
      })
      await this.warehouse.goHome({ requireWarehouse: true })
      const returned = await this.warehouse.depositInventoryWithoutBalance('withdraw_failed_return', `owner=${storageOwner.uuid}, actor=${username}`)
      if (!returned.leftover.length) {
        msgActor('账本有库存但没有取出任何物品，已逐个木桶核对实际库存，正在按最新记录重试……')
        attempt = await runBatches()
        if (attempt.cancelled || attempt.aborted) return withShortagePlan({ status: attempt.aborted ? 'aborted' : 'cancelled', delivered: [], missing: [] })
        deliveredTotal = this.mergeItems(attempt.allDeducted)
      }
    }

    if (!deliveredTotal.length) {
      traceEvent(trace, 'result', 'task_failed_no_withdraw', {
        decision: '就地核对并重试后仍然一无所获，本次取货失败（未扣账）'
      })
      await this.warehouse.goHome({ requireWarehouse: true })
      const returned = await this.warehouse.depositInventoryWithoutBalance('withdraw_failed_return', `owner=${storageOwner.uuid}, actor=${username}`)
      if (returned.leftover.length) {
        msgActor(`机器人身上仍有未能放回仓库的物品：${this.formatItemList(returned.leftover)}`)
      }
      if (deliveryMode === 'repair') {
        if (deliveryToOther) msgTarget(`${username} 想给你修装备，但你离开太远或未能成功使用经验瓶，本次已取消。`)
        this.msg(username, `${this.ownerActionPrefix(storageOwner)}修装备未开始或未成功使用经验瓶，已把经验瓶回收入库，本次不会扣除库存。`)
      } else if (deliveryToOther) {
        msgTarget(`${username} 给你的取货失败：仓库实物取出失败，请稍后再试。`)
        msgActor(`给 ${deliveryTarget} 的取货失败：仓库实物取出失败，请稍后再试。`)
      } else {
        // 重试后仍一无所获：缺口就地确认完毕（取到又放回的不计缺失），当场修账。
        // 背包已满导致的少取不是仓库缺货，不修账。
        this.autoReconcileConfirmedMissing(storageOwner, (attempt.allMissing || []).filter(item => !item.inventoryFull), username)
        this.msg(username, `账本有库存，但按本地木桶记录没有取出：${this.formatItemList(plan.allocations)}。已就地核对各木桶并重试仍未取到，账本已按实物自动修正并登记异常；若持续出现，请管理员在Web管理页检查库存异常。`)
      }
      this.db.clearRecoveryTask(this.botId)
      return withShortagePlan({ status: 'failed_no_withdraw', delivered: [], missing: this.mergeItems(plan.allocations) })
    }

    const missingByItem = this.groupMissingByDisplay(plan.allocations, attempt.allWithdrawn, attempt.allMissing)
    // 部分交付的缺口当场修账：交付部分稍后按计划扣账，缺失部分现在扣，
    // 任务结束后账面 = 实物，不再需要管理员补 !同步。
    // 背包已满导致的少取除外——仓库实物还在，不能扣账。
    const reconcilableMissing = (attempt.allMissing || []).filter(item => !item.inventoryFull)
    const reconciledMissing = this.autoReconcileConfirmedMissing(storageOwner, reconcilableMissing, username)
    traceEvent(trace, 'result', 'task_delivered', {
      delivered: deliveredTotal.map(item => ({ name: item.displayName || item.itemId, amount: item.amount, keyTail: shortKey(item.itemKey) })),
      missingNotices: missingByItem,
      reconciledMissing,
      decision: '实物已交付，交付部分已按计划扣账'
    })
    if (!deliveryToOther) {
      for (const notice of missingByItem) this.msg(username, notice)
      if (reconciledMissing.length) this.msg(username, '缺失部分已自动同步账本并登记库存异常，管理员可在Web管理页复核。')
    }

    if (deliveryToOther) {
      const suffix = missingByItem.length ? '，部分物品仓库实物不足，未取到。' : '。'
      msgTarget(deliveryMode === 'repair'
        ? `${username} 给你修装备已完成：共用了 ${this.totalAmount(deliveredTotal)} 个${this.buildRepairBottleRequest().displayName}${suffix}`
        : `${username} 给你的取货已送达：${this.formatWithdrawSummary(deliveredTotal)}${suffix}`)
      msgActor(deliveryMode === 'repair'
        ? `给 ${deliveryTarget} 修装备已完成：共用了 ${this.totalAmount(deliveredTotal)} 个${this.buildRepairBottleRequest().displayName}${suffix}`
        : `给 ${deliveryTarget} 的取货已送达：${this.formatWithdrawSummary(deliveredTotal)}${suffix}`)
    } else {
      this.msg(username, deliveryMode === 'repair'
        ? `${this.ownerActionPrefix(storageOwner)}修装备完成：共用了 ${this.totalAmount(deliveredTotal)} 个${this.buildRepairBottleRequest().displayName}。`
        : `${this.ownerActionPrefix(storageOwner)}取货完成：${this.formatWithdrawSummary(deliveredTotal)}。`)
    }

    if (continueWithDeposit) {
      await this.handleDeposit(username, storageOwner, { alreadyAtPlayer: attempt.stayedWithPlayerForDeposit })
      return withShortagePlan({ status: 'delivered_then_deposit', delivered: deliveredTotal, missing: attempt.allMissing || [] })
    }
    this.db.clearRecoveryTask(this.botId)
    return withShortagePlan({ status: 'delivered', delivered: deliveredTotal, missing: attempt.allMissing || [] })
  }

  // 取货任务收尾：把确认取不到的缺口当场修账（扣 owner 余额 + sync_deduct 流水 +
  // missing 异常留痕）。归属精确到本任务 owner，比 !同步 的按比例估算更可靠；
  // 失败只告警不阻断任务收尾。
  autoReconcileConfirmedMissing (storageOwner, missingItems, username) {
    if (!missingItems?.length) return []
    try {
      if (typeof this.db.deductConfirmedMissing !== 'function') return []
      return this.db.deductConfirmedMissing(
        storageOwner.uuid,
        storageOwner.username || username || '',
        missingItems,
        '取货时确认缺失'
      )
    } catch (error) {
      console.warn(`[withdraw-auto-reconcile] 确认缺失自动修账失败：${error?.message || error}`)
      return []
    }
  }

  async runWithdrawBatches ({ username, storageOwner, deliveryTarget, deliveryToOther, deliveryMode, batches, continueWithDeposit, msgActor, msgTarget, trace }) {
    const allWithdrawn = []
    const allDeducted = []
    const allMissing = []
    const allUnlocated = []
    let searchedUnlocatedBarrels = 0
    let stayedWithPlayerForDeposit = false
    let cancelled = false
    let aborted = false
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index]
      // 幂等键必须带进程盐：任务序号重启归零，裸拼会在重启后与旧任务撞键导致静默跳过扣账。
      const batchId = `withdraw:${this.botId}:${this.active?.taskId || 'legacy'}:${index + 1}:${DEDUCTION_KEY_SALT}`
      this.setWithdrawBatchProgress(index + 1, batches.length, 'withdraw_from_chests')
      this.saveRecoveryTask('withdraw', username, storageOwner, deliveryTarget, 'withdraw_from_chests', [], batchId)
      traceEvent(trace, 'batch', 'batch_start', {
        batchId,
        index: index + 1,
        total: batches.length,
        items: batch.map(item => ({
          name: item.displayName || item.itemId,
          amount: item.amount,
          mode: item.withdrawMode === 'shulker_extract' ? 'shulker_extract' : 'loose',
          keyTail: shortKey(item.itemKey)
        }))
      })
      const physical = await this.withdrawBatchWithQuantityGuard(batch, {
        username,
        storageOwner,
        deliveryTarget,
        batchIndex: index + 1,
        totalBatches: batches.length,
        trace
      })
      traceEvent(trace, 'batch', 'batch_physical_result', {
        batchId,
        withdrawn: (physical.withdrawn || []).map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
        missing: (physical.missing || []).map(item => ({ name: item.displayName || item.itemId, amount: item.amount }))
      })
      if (physical.missing?.length) allMissing.push(...physical.missing)
      if (physical.unlocated?.length) allUnlocated.push(...physical.unlocated)
      searchedUnlocatedBarrels += Number(physical.searchedUnlocatedBarrels) || 0
      if (this.isActiveCancelled()) {
        cancelled = true
        break
      }

      const delivered = this.allocateWithdrawnToPlanned(batch, physical.withdrawn)

      if (!delivered.length) {
        traceEvent(trace, 'batch', 'batch_no_delivery', {
          batchId,
          decision: '该批计划物品一个都没取到，直接进入下一批'
        })
        continue
      }
      allWithdrawn.push(...delivered)

      this.setWithdrawBatchProgress(index + 1, batches.length, 'withdraw_teleport_to_player')
      const teleported = await this.teleportToPlayer(deliveryTarget, { notify: false })
      traceEvent(trace, 'delivery', 'teleport_to_player', {
        batchId,
        target: deliveryTarget,
        ok: Boolean(teleported)
      })
      if (!teleported) {
        this.setWithdrawBatchProgress(index + 1, batches.length, 'withdraw_tpa_timeout_return_home')
        this.saveRecoveryTask('withdraw', username, storageOwner, deliveryTarget, 'withdraw_tpa_timeout_return_home', [], batchId)
        await this.warehouse.goHome({ requireWarehouse: true })
        const result = await this.warehouse.depositInventoryWithoutBalance('withdraw_tpa_timeout', `actor=${username}, target=${deliveryTarget}`)
        if (result.leftover.length) {
          msgActor(`仓库空间不足，机器人身上仍有未放回的物品：${this.formatItemList(result.leftover)}`)
        }
        const partial = this.mergeItems(allDeducted)
        if (partial.length) {
          if (deliveryToOther) {
            msgTarget(`${username} 给你的部分物品已送达：${this.formatWithdrawSummary(partial)}。剩余取货因未接受传送请求已取消。`)
            msgActor(`给 ${deliveryTarget} 的部分物品已送达：${this.formatWithdrawSummary(partial)}。剩余取货因对方未接受传送请求已取消。`)
          } else {
            this.msg(username, `${this.ownerActionPrefix(storageOwner)}已分批取出部分物品：${this.formatWithdrawSummary(partial)}。剩余取货因未接受传送请求已取消。`)
          }
        } else if (deliveryToOther) {
          msgActor(deliveryMode === 'repair'
            ? `给 ${deliveryTarget} 修装备已取消：对方未接受传送请求。`
            : `给 ${deliveryTarget} 的取货已取消：对方未接受传送请求。`)
        }
        this.db.clearRecoveryTask(this.botId)
        aborted = true
        break
      }

      if (this.isActiveCancelled()) {
        cancelled = true
        break
      }
      const deliveryPhase = deliveryMode === 'repair' ? 'withdraw_repairing' : 'withdraw_dropping'
      this.setWithdrawBatchProgress(index + 1, batches.length, deliveryPhase)
      this.saveRecoveryTask('withdraw', username, storageOwner, deliveryTarget, deliveryPhase, delivered, batchId)
      const dropped = deliveryMode === 'repair'
        ? await this.warehouse.repairPlayerWithExperienceBottles(deliveryTarget, {
            itemId: REPAIR_BOTTLE_ITEM_ID,
            maxDistance: REPAIR_MAX_DISTANCE
          })
        : await this.dropWithdrawItemsToPlayer(deliveryTarget, delivered)
      traceEvent(trace, 'delivery', 'deliver_to_player', {
        batchId,
        target: deliveryTarget,
        mode: deliveryMode,
        dropped: (dropped || []).map(item => ({ name: item.displayName || item.itemId, amount: item.amount }))
      })
      if (this.isActiveCancelled()) {
        cancelled = true
        break
      }

      const deduct = this.allocateWithdrawnToPlanned(delivered, dropped)
      traceEvent(trace, 'ledger', 'deduct_plan', {
        batchId,
        deduct: (deduct || []).map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
        undeliveredReturned: (dropped || []).length ? undefined : '本轮没有成功丢出任何物品，不扣账'
      })

      if (deduct.length) {
        this.recordWithdrawDeduction(storageOwner, deduct, `actor=${username}, target=${deliveryTarget}, batch=${index + 1}/${batches.length}`, batchId)
        this.saveRecoveryTask('withdraw', username, storageOwner, deliveryTarget, 'withdraw_return_home', [], batchId)
        allDeducted.push(...deduct)
      } else {
        this.saveRecoveryTask('withdraw', username, storageOwner, deliveryTarget, 'withdraw_return_home', [], batchId)
      }

      const finalBatch = index === batches.length - 1
      if (continueWithDeposit && finalBatch) {
        stayedWithPlayerForDeposit = true
        continue
      }

      this.setWithdrawBatchProgress(index + 1, batches.length, 'withdraw_return_home')
      await this.warehouse.goHome({ requireWarehouse: true })
      if (this.isActiveCancelled()) {
        cancelled = true
        break
      }
      const residual = continueWithDeposit
        ? await this.warehouse.depositInventoryForOwner(storageOwner.uuid, storageOwner.username)
        : await this.warehouse.depositInventoryWithoutBalance('withdraw_residual_return', `owner=${storageOwner.uuid}, actor=${username}, target=${deliveryTarget}, batch=${index + 1}/${batches.length}`)
      if (residual.deposited.length) {
        msgActor(continueWithDeposit
          ? `取货期间收到的物品已先存入${this.ownerScopeName(storageOwner)}：${this.formatDepositSummary(residual.deposited)}。`
          : (deliveryMode === 'repair'
              ? `有未用完的经验瓶已回收入库；这部分没有从${this.ownerSubjectName(storageOwner)}扣除。`
              : `有未成功丢出的物品已回收入库；这部分没有从${this.ownerSubjectName(storageOwner)}扣除。`))
      }
    }

    return { allWithdrawn, allDeducted, allMissing, allUnlocated, searchedUnlocatedBarrels, stayedWithPlayerForDeposit, cancelled, aborted }
  }

  async dropWithdrawItemsToPlayer (username, requestedItems) {
    if (typeof this.warehouse.dropItemsToPlayer === 'function') {
      return this.warehouse.dropItemsToPlayer(username, requestedItems)
    }

    const requested = this.mergeItems(requestedItems || [])
    const dropped = []
    if (this.bot.currentWindow) {
      this.bot.closeWindow(this.bot.currentWindow)
      await sleep(150)
    }

    for (const request of requested) {
      let remaining = Number(request.amount || 0)
      while (remaining > 0) {
        const item = this.bot.inventory.items().find(entry => {
          const normalized = this.catalog.fromPrismarineItem(entry)
          return normalized.itemKey === request.itemKey
        })
        if (!item) break

        const normalized = this.catalog.fromPrismarineItem(item)
        const amount = Math.min(remaining, Number(item.count || 0))
        const before = this.warehouse.inventoryCountByItemKey(normalized.itemKey)
        await this.warehouse.lookAtPlayer(username)
        if (amount >= item.count) {
          await this.warehouse.dropStackFast(item)
        } else {
          const timeoutMs = Number(this.config.timing.dropConfirmTimeoutMs || 5000)
          for (let index = 0; index < amount; index++) {
            await this.warehouse.withTimeout(
              this.bot.clickWindow(item.slot, 0, 4),
              timeoutMs,
              `逐个丢出物品超时 slot=${item.slot}`
            )
          }
        }

        const moved = await this.warehouse.waitForInventoryDecrease(normalized.itemKey, before)
        if (moved <= 0) throw new Error(`丢出 ${normalized.displayName} 超时，背包数量没有减少。`)
        const deliveredAmount = Math.min(remaining, moved)
        dropped.push({ ...normalized, amount: deliveredAmount })
        remaining -= deliveredAmount
        await sleep(this.config.timing.dropIntervalMs)
      }
    }

    return this.mergeItems(dropped)
  }

  async withdrawBatchWithQuantityGuard (batch, context = {}) {
    const maxAttempts = 2
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const physical = await this.warehouse.withdrawAllocations(batch)
      const settleMs = Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250))
      if (settleMs > 0) await sleep(settleMs)

      const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      const excess = this.itemsExceedingPlan(held, batch)
      if (!excess.length) {
        traceEvent(context.trace, 'ledger', 'quantity_guard_ok', {
          attempt,
          held: held.map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
          decision: '背包实际物品与取货计划核对一致'
        })
        return {
          ...physical,
          withdrawn: held
        }
      }

      const details = [
        `actor=${context.username || ''}`,
        `owner=${context.storageOwner?.uuid || ''}`,
        `target=${context.deliveryTarget || ''}`,
        `batch=${context.batchIndex || 1}/${context.totalBatches || 1}`,
        `attempt=${attempt}/${maxAttempts}`,
        `excess=${this.formatItemList(excess)}`
      ].join(', ')
      console.warn(`[withdraw-quantity-guard] ${details}`)
      traceEvent(context.trace, 'decision', 'quantity_guard_overage', {
        attempt,
        maxAttempts,
        excess: excess.map(item => ({ name: item.displayName || item.itemId, amount: item.amount })),
        decision: '背包里多出了计划之外的物品（数量异常），先全部回库再重试'
      })

      const returned = await this.warehouse.depositInventoryWithoutBalance('withdraw_overage_return', details)
      if (returned.leftover?.length) {
        throw new Error(`取货数量异常，且多取物品未能全部回库：${this.formatItemList(returned.leftover)}`)
      }
      if (attempt === maxAttempts) {
        throw new Error(`散装取货数量连续异常，已将本批物品回库并终止任务：${this.formatItemList(excess)}`)
      }
    }

    return { withdrawn: [], missing: batch, unlocated: [] }
  }

  async handleQuery (username, text, storageOwner = null) {
    const parts = text.split(/\s+/).filter(Boolean)
    let owner = storageOwner || { ...this.getPlayer(username), scope: 'personal' }
    let itemName = parts[1]

    if (parts.length === 3 && parts[1].toLowerCase() === 'momo') {
      if (!this.isAdmin(username)) {
        this.msg(username, '你没有权限查询 momo。')
        return
      }
      owner = { uuid: this.config.momoOwner, username: 'momo' }
      itemName = parts[2]
    }

    if (!itemName || parts.length > 3) {
      this.msg(username, '查询只支持单一物品，格式：!查 石头')
      return
    }

    const actor = this.getPlayer(username)
    const items = this.resolveStoredItemsForOwnerQuery(owner.uuid, itemName, actor.uuid)
    const shulkers = this.resolveShulkerContentsForOwnerQuery(owner.uuid, itemName, actor.uuid)
    if (!items.length && !shulkers.length) {
      this.msg(username, `${this.queryOwnerLabel(owner)}没有匹配当前库存的物品：${itemName}`)
      return
    }
    this.sendQueryResult(username, this.queryOwnerLabel(owner), items, shulkers)
  }

  // Synthesis (ported from olela bot, 2026-11-02): craft an item using only what the
  // warehouse already holds. No collection chain — the planner rejects orders whose
  // inputs are missing from storage. Runs as an exclusive task so only one bot crafts.
  // This is the internal entry point; the web panel and the mods are untouched.
  craftLedger () {
    if (!this._craftLedger) {
      const CraftLedger = require('./craft/ledger')
      this._craftLedger = new CraftLedger(this.db)
    }
    return this._craftLedger
  }

  getCraftController () {
    if (!this.craftController) {
      const { CraftController } = require('./craft/controller')
      this.craftController = new CraftController({
        bot: this.bot, db: this.db, catalog: this.catalog, config: this.config,
        warehouse: this.warehouse, executor: this.bot._craftingExecutor,
        botId: this.botId, ledger: this.craftLedger(),
        validateOwner: (owner, actor) => this.validateCraftOwner(owner, actor),
        quota: owner => this.getStorageQuota(owner.uuid, owner.scope)
      })
    }
    return this.craftController
  }

  validateCraftOwner (owner, username) {
    const player = this.getPlayer(username)
    if (owner.scope === 'custom' || owner.uuid.startsWith('vault:')) {
      const name = owner.vaultName || owner.uuid.slice(6)
      if (!this.db.getCustomWarehouse(name) || !this.db.isCustomWarehouseMember(name, player.uuid)) {
        throw new Error('组织仓库已不存在或你不是该仓库成员，无法使用合成。')
      }
    } else if (owner.uuid !== player.uuid) throw new Error('合成仓库归属与请求玩家不一致。')
  }

  async handleCraft (username, text, storageOwner = null) {
    if (this.config.craft?.enabled === false || !this.bot._craftingExecutor) {
      this.msg(username, '合成功能未启用（缺少合成执行器）。')
      return
    }
    const parsed = this.parseCraftRequest(String(text).replace(/^!合成\s*/, ''))
    if (!parsed.ok) { this.msg(username, parsed.error); return }
    const player = this.getPlayer(username)
    const owner = storageOwner || { ...player, scope: 'personal' }
    this.validateCraftOwner(owner, username)
    // Same resolution chain as deposit/withdraw: personal alias -> global alias
    // -> catalog display names. Falls back to the raw string for catalog ids.
    const alias = this.resolveByAliasChain(parsed.itemName, player.uuid)
    if (alias.layer === 'disabled') throw new Error('该物品别名已停用。')
    const resolved = this.catalog.resolveName(alias.item?.itemId || parsed.itemName)
    const planned = require('./craft').planToCraftCommand({
      item: resolved.name, quantity: parsed.quantity,
      available: this.availableCraftStock(owner.uuid), config: this.config, forceCraft: true
    })
    if (!planned.ok) { this.msg(username, this.describeCraftRejection(planned, parsed)); return }
    // Capture request intent and explicit owner. The selected worker replans and
    // reserves current stock under the warehouse lock when execution begins.
    const request = {
      player: username, owner: { ...owner }, target: { name: resolved.name, quantity: parsed.quantity },
      notify: message => this.msg(username, message)
    }
    this.msg(username, '合成请求已提交：' + parsed.itemName + ' ×' + parsed.quantity + '；开工时重新核对库存。')
    await this.enqueueTask(username, 'craft', worker => worker.runCraftCommand(request), { exclusive: true })
  }

  // Mirrors parseWithdraw's name/quantity grammar so !合成 accepts the same
  // forms as !取: bare alias ("!合成 木棍"), trailing count ("!合成 木棍 64"),
  // and glued count ("!合成 木棍64"). Missing quantity crafts one.
  parseCraftRequest (request) {
    const raw = String(request || '').trim()
    if (!raw) return { ok: false, error: '格式：!合成 物品名 [数量]，例如 !合成 木棍 64、!合成 木棍64、!合成 木棍' }
    let itemName = raw
    let quantity = 1
    const trailing = raw.match(/^(.*?)(?:\s+)(\d+)$/)
    if (trailing) {
      itemName = trailing[1].trim()
      quantity = Number(trailing[2])
    } else {
      const glued = raw.match(/^(.*?)(\d+)$/)
      if (glued && glued[1].trim()) {
        itemName = glued[1].trim()
        quantity = Number(glued[2])
      }
    }
    if (!itemName) return { ok: false, error: '缺少物品名，例如 !合成 木棍 64。' }
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1000000) {
      return { ok: false, error: '数量必须是 1 到 1000000 之间的整数。' }
    }
    return { ok: true, itemName, quantity }
  }

  availableCraftStock (ownerUuid) {
    const available = {}
    for (const row of this.craftLedger().getCraftAvailableItems(ownerUuid)) {
      const baseName = row.itemId.replace(/^minecraft:/, '')
      available[baseName] = (available[baseName] || 0) + row.amount
    }
    return available
  }

  describeCraftRejection (planned, parsed) {
    if (planned.reason === 'needs_collection') return '仓库内原料不足，无法合成 ' + parsed.itemName + '（只使用散装库存，不采集）。'
    if (planned.reason === 'already_in_warehouse') return '仓库里已有足够 ' + parsed.itemName + '，无需合成。'
    return '无法合成 ' + parsed.itemName + '：配方不可达、原料不足或合成配置无效。'
  }

  async runCraftCommand (command) {
    const notify = command.notify || (message => this.msg(command.player, message))
    // 开工前先清背包实物残留（复用每次存入前的同一套 flushResidual 归属回库）：
    // 机器人平时开着自动捡拾，玩家掉的零散物会进背包，实物残留会让合成独占
    // 背包的清洁检查直接失败（2026-11-05 22:38 矿车合成被"背包 潜影盒×1"打挂）。
    // 必须在控制器取仓库锁之前执行：flushResidual 的入库封装自己会拿同一把
    // 不可重入锁，锁内再调会死锁。窗口/光标/合成格异常不再拦截（所有者拍板）：
    // 直接关窗归位（settleResidue 幂等），关窗退回的物品随本次清理一并回仓。
    if (this.bot.inventory.items().length) {
      await this.getCraftController().settleResidue()
      if (this.isActiveCancelled()) return
      notify('检测到机器人背包残留物品，正在按归属回仓清理，随后自动开工合成。')
      await this.warehouse.goHomeIfAway()
      if (this.isActiveCancelled()) return
      await this.flushResidual()
      if (this.isActiveCancelled()) return
    }
    const result = await this.getCraftController().run({
      actor: command.player, owner: command.owner, item: command.target.name, quantity: command.target.quantity
    })
    if (result.status === 'complete') notify('合成完成：' + command.target.name + ' ×' + command.target.quantity + '，产物与余料已回云仓并记账。')
    else if (result.status === 'already_sufficient') notify('仓库里已有足够目标物品，无需继续合成。')
    return result
  }

  async handleCraftRecovery (username) {
    if (!this.isAdmin(username)) throw new Error('合成恢复只允许系统管理员使用。')
    const botIds = [...new Set((this.db.pendingCraftBotIds?.() || []).filter(Boolean))]
    if (!botIds.length) {
      this.msg(username, '本机器人没有待恢复的合成任务。')
      return { status: 'empty' }
    }
    const outcomes = []
    for (const botId of botIds) {
      const owner = this.taskPool
        ? [...this.taskPool.workers].find(worker => worker.botId === botId)
        : (this.botId === botId ? this : null)
      if (!this.taskPool && !owner) {
        this.msg(username, `待恢复机器人 ${botId} 当前离线，等待原机器人重新上线后核对。`)
        outcomes.push({ status: 'waiting', botId })
        continue
      }
      const stickyWorker = owner || { botId }
      const canStart = !this.taskPool || Boolean(this.taskPool.eligibleWorkerForTask({ type: 'craft_recovery', stickyWorker }))
      const task = Promise.resolve(this.enqueueTask(username, 'craft_recovery', async worker => {
        const result = await worker.getCraftController().recover()
        this.msg(username, result.status === 'empty'
          ? `机器人 ${botId} 没有待恢复的合成任务。`
          : result.diffRegistered
            ? '合成中断状态已核验，物品已回云仓；对账差异已登记库存异常，请在 Web 管理页复核；可重新提交合成。'
            : '合成中断状态已核验，物品已回云仓；可重新提交合成。')
        return result
      }, { exclusive: true, stickyWorker }))
      if (canStart) outcomes.push(await task)
      else {
        this.msg(username, `已为 ${botId} 排队恢复，等待原机器人上线并结束旧操作；恢复完成前仍按原有规则保护库存。`)
        task.catch(error => this.handleCommandError(username, error))
        outcomes.push({ status: 'waiting', botId })
      }
    }
    return outcomes.length === 1 ? outcomes[0] : outcomes
  }

  // Automatic craft recovery: a bot that spawns (first login, reconnect after a
  // drop, or web-admin restart) with a pending craft journal reconciles it
  // itself instead of blocking every deposit/withdraw until an admin runs
  // !合成恢复 manually. Runs through the same exclusive craft_recovery task
  // as the manual command; admins get a notice with the outcome.
  scheduleCraftAutoRecovery () {
    const run = async () => {
      try {
        if (this.config.craft?.enabled === false || !this.bot._craftingExecutor) return
        if (!this.db.hasPendingCraft?.(this.botId)) return
        const admin = this.db.listAdmins().find(row => row.username)?.username || ''
        console.log(`[craft:auto-recover] ${this.bot.username} has a pending craft journal; recovering automatically`)
        const result = await this.enqueueTask(admin, 'craft_recovery', async worker => {
          const outcome = await worker.getCraftController().recover()
          return outcome
        }, { exclusive: true, stickyWorker: this })
        // recover() 重试失败会按库存差异登记销账（不再锁库），status recovered
        // 含 diffRegistered=true 时要提示管理员有差异登记待复核。
        const notice = result?.status === 'recovered'
          ? (result?.diffRegistered
              ? `机器人 ${this.bot.username} 启动时自动恢复了一笔中断的合成，物品已回云仓；对账差异已登记库存异常，请管理员在 Web 管理页复核。`
              : `机器人 ${this.bot.username} 启动时自动恢复了一笔中断的合成，物品已回云仓；可重新提交合成。`)
          : null
        if (notice) {
          for (const row of this.db.listAdmins()) {
            if (row.username) this.msg(row.username, notice)
          }
        }
      } catch (error) {
        console.error(`[craft:auto-recover] ${this.bot.username} failed:`, error?.message || error)
        const notice = `机器人 ${this.bot.username} 启动时自动合成恢复失败：${error?.message || error}；请管理员执行 !合成恢复 核对。`
        for (const row of this.db.listAdmins()) {
          if (row.username) this.msg(row.username, notice)
        }
      }
    }
    // Give the world a moment to stream in before walking home and opening
    // containers; recoverLocked itself re-reads server evidence anyway.
    setTimeout(() => { run() }, 5000)
  }

  async handleCreateCustomWarehouse (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '只有云仓库系统管理员可以创建组织仓库。')
      return
    }
    const player = this.getPlayer(username)
    const parts = text.split(/\s+/).filter(Boolean)
    if (parts.length !== 2) {
      this.msg(username, '格式：!创建仓库 仓库名')
      return
    }

    const name = parts[1]
    const error = this.validateCustomWarehouseName(name)
    if (error) {
      this.msg(username, error)
      return
    }

    if (this.db.getCustomWarehouse(name)) {
      this.msg(username, `仓库名 ${name} 已存在，请换一个名字。`)
      return
    }

    const limit = this.config.storage?.maxCustomWarehousesPerPlayer || 3
    const current = this.db.countWarehousesCreatedBy(player.uuid)
    if (current >= limit) {
      this.msg(username, `你最多只能创建 ${limit} 个自定义仓库。`)
      return
    }

    this.db.createCustomWarehouse(name, player.uuid, username)
    this.msg(username, `已创建自定义仓库：${name}。你是这个仓库的管理员。`)
  }

  async handleMyCustomWarehouses (username) {
    const player = this.getPlayer(username)
    const rows = this.db.listCustomWarehousesForPlayer(player.uuid)
    if (!rows.length) {
      this.msg(username, '你还没有关联任何自定义仓库。')
      return
    }
    const text = rows.map(row => `${row.name}${row.role === 'admin' ? '(管理员)' : '(成员)'}`).join('，')
    this.msg(username, `你的仓库：${text}`)
  }

  async handleDefaultWarehouse (username, text) {
    const player = this.getPlayer(username)
    if (text === '!默认仓库') {
      const owner = this.defaultStorageOwnerForPlayer(player)
      this.msg(username, `当前默认仓库：${this.defaultOwnerLabel(owner)}。`)
      return
    }

    const match = text.match(/^!设置默认仓库(?:\s+(.+))?$/)
    const targetText = String(match?.[1] || '').trim()
    if (!targetText || /\s/.test(targetText)) {
      this.msg(username, '格式：设置默认仓库 个人 或 设置默认仓库 仓库名')
      return
    }

    const owner = this.resolveStorageOwnerByKeyword(username, targetText)
    this.db.setPlayerDefaultOwnerUuid(player.uuid, owner.uuid)
    this.msg(username, `已设置默认仓库：${this.defaultOwnerLabel(owner)}。以后直接“存/取/查”会使用这个仓库。`)
  }

  parsePersonalWarehouseCommand (text) {
    const match = text.match(/^!个人\s+(查|存|取)(?:\s+(.+))?$/)
    if (!match) return null
    return { action: match[1], rest: String(match[2] || '').trim() }
  }

  async handlePersonalWarehouseCommand (username, command, taskOptions = {}) {
    const player = this.getPlayer(username)
    if (!this.db.hasPersonalWarehouse(player.uuid) && command.action === '存' && this.subscriptions) {
      this.subscriptions.maybeAutoRegister(player, 'deposit')
    }
    if (!this.db.hasPersonalWarehouse(player.uuid)) {
      this.msg(username, '你没有个人仓库。请联系云仓库管理员创建，或使用你已加入的组织仓库。')
      return
    }
    const owner = { ...player, scope: 'personal', strictPersonal: true }

    if (command.action === '查') {
      if (!command.rest || /\s/.test(command.rest)) {
        this.msg(username, '查询只支持单一物品，格式：个人 查 石头')
        return
      }
      await this.handleQuery(username, `!查 ${command.rest}`, owner)
      return
    }

    if (command.action === '存') {
      if (command.rest) {
        this.msg(username, '格式：个人 存')
        return
      }
      await this.enqueueTask(username, 'deposit', worker => worker.handleDeposit(username, owner), taskOptions)
      return
    }

    if (command.action === '取') {
      if (!command.rest) {
        this.msg(username, '格式：个人 取 石头64')
        return
      }
      await this.enqueueTask(username, 'withdraw', worker => worker.handleWithdraw(username, `!个人 取 ${command.rest}`, owner), taskOptions)
    }
  }

  parseCustomWarehouseCommand (text) {
    const match = text.match(/^!(\S{1,15})\s+(添加成员|加成员|删除成员|删成员|添加管理|添加管理员|加管理|加管理员|删除管理|删除管理员|删管理|删管理员|查|存|取|仓库成员|成员|查看成员|成员列表)(?:\s+(.+))?$/)
    if (!match) return null
    const [, warehouseName, action, rest = ''] = match
    return { warehouseName, action, rest: rest.trim() }
  }

  isCustomAction (action, type) {
    const aliases = {
      addMember: ['添加成员', '加成员'],
      removeMember: ['删除成员', '删成员'],
      addAdmin: ['添加管理', '添加管理员', '加管理', '加管理员'],
      removeAdmin: ['删除管理', '删除管理员', '删管理', '删管理员'],
      listMembers: ['仓库成员', '成员', '查看成员', '成员列表']
    }
    return aliases[type]?.includes(action) || false
  }

  async handleCustomWarehouseCommand (username, command, taskOptions = {}) {
    const actor = this.getPlayer(username)
    const warehouse = this.db.getCustomWarehouse(command.warehouseName)
    if (!warehouse) {
      this.msg(username, `找不到自定义仓库：${command.warehouseName}`)
      return
    }

    const owner = this.resolveCustomWarehouseOwner(warehouse)
    const isMember = this.db.isCustomWarehouseMember(warehouse.name, actor.uuid)
    const isAdmin = this.db.isCustomWarehouseAdmin(warehouse.name, actor.uuid)

    if (this.isCustomAction(command.action, 'addMember')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以添加成员。')
        return
      }
      const target = this.resolveMemberArgument(command.rest)
      this.db.addCustomWarehouseMember(warehouse.name, target.uuid, target.username)
      this.msg(username, `已把 ${target.username} 添加到仓库 ${warehouse.name}。`)
      return
    }

    if (this.isCustomAction(command.action, 'removeMember')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以删除成员。')
        return
      }
      const target = this.resolveMemberArgument(command.rest)
      if (target.uuid === warehouse.creatorUuid) {
        this.msg(username, '不能删除仓库创建者。')
        return
      }
      const removed = this.db.removeCustomWarehouseMember(warehouse.name, target.uuid)
      this.msg(username, removed ? `已从仓库 ${warehouse.name} 删除成员 ${target.username}。` : `${target.username} 不是仓库 ${warehouse.name} 的成员。`)
      return
    }

    if (this.isCustomAction(command.action, 'addAdmin')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以添加仓库管理员。')
        return
      }
      const target = this.resolveMemberArgument(command.rest)
      this.db.setCustomWarehouseMemberRole(warehouse.name, target.uuid, target.username, 'admin')
      this.msg(username, `已把 ${target.username} 设为仓库 ${warehouse.name} 的管理员。`)
      return
    }

    if (this.isCustomAction(command.action, 'removeAdmin')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以删除仓库管理员。')
        return
      }
      const target = this.resolveMemberArgument(command.rest)
      if (target.uuid === warehouse.creatorUuid) {
        this.msg(username, '不能取消仓库创建者的管理员权限。')
        return
      }
      const changed = this.db.setCustomWarehouseMemberRoleIfExists(warehouse.name, target.uuid, 'member')
      this.msg(username, changed ? `已取消 ${target.username} 在仓库 ${warehouse.name} 的管理员权限。` : `${target.username} 不是仓库 ${warehouse.name} 的成员。`)
      return
    }

    if (!isMember) {
      this.msg(username, `你不是仓库 ${warehouse.name} 的成员。`)
      return
    }

    if (this.isCustomAction(command.action, 'listMembers')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以查看成员列表。')
        return
      }
      const members = this.db.listCustomWarehouseMembers(warehouse.name)
      const text = members.map(member => `${member.username}${member.role === 'admin' ? '(管理员)' : ''}`).join('，') || '无'
      this.msg(username, `${warehouse.name} 成员：${text}`)
      return
    }

    if (command.action === '查') {
      if (!command.rest || /\s/.test(command.rest)) {
        this.msg(username, `查询只支持单一物品，格式：!${warehouse.name} 查 石头`)
        return
      }
      const items = this.resolveStoredItemsForOwnerQuery(owner.uuid, command.rest, actor.uuid)
      const shulkers = this.resolveShulkerContentsForOwnerQuery(owner.uuid, command.rest, actor.uuid)
      if (!items.length && !shulkers.length) {
        this.msg(username, `${warehouse.name} 当前没有匹配当前库存的物品：${command.rest}`)
        return
      }
      this.sendQueryResult(username, `${warehouse.name} 当前`, items, shulkers)
      return
    }

    if (command.action === '存') {
      if (command.rest) {
        this.msg(username, `格式：!${warehouse.name} 存`)
        return
      }
      await this.enqueueTask(username, 'deposit', worker => worker.handleDeposit(username, owner), taskOptions)
      return
    }

    if (command.action === '取') {
      if (!command.rest) {
        this.msg(username, `格式：!${warehouse.name} 取 石头64`)
        return
      }
      await this.enqueueTask(username, 'withdraw', worker => worker.handleWithdraw(username, `!${warehouse.name} 取 ${command.rest}`, owner), taskOptions)
    }
  }

  resolveMemberArgument (text) {
    const username = String(text || '').trim()
    if (!username || /\s/.test(username)) {
      throw new Error('成员参数必须是单个玩家ID。')
    }
    return this.resolvePlayer(username)
  }

  async handleQuota (username, text) {
    const parts = text.split(/\s+/).filter(Boolean)
    let target = null

    if (parts.length === 2) {
      target = this.resolveQuotaOwnerArgument(parts[1])
      if (target.scope === 'custom') {
        const actor = this.getPlayer(username)
        const isMember = this.db.isCustomWarehouseMember(target.vaultName, actor.uuid)
        if (!isMember && !this.isAdmin(username)) {
          this.msg(username, `你不是仓库 ${target.vaultName} 的成员。`)
          return
        }
      } else if (!this.isAdmin(username)) {
        this.msg(username, '你没有权限查询其他玩家额度。')
        return
      }
    } else if (parts.length > 2) {
      this.msg(username, '格式：!额度、!额度 玩家ID 或 !额度 仓库:仓库名')
      return
    }
    if (!target) target = this.defaultStorageOwnerForPlayer(this.getPlayer(username))

    const quota = this.getStorageQuota(target.uuid, target.scope)
    const percent = quota.quotaSlots > 0 ? Math.floor((quota.usedSlots / quota.quotaSlots) * 100) : 0
    const prefix = target.scope === 'custom'
      ? `仓库 ${target.vaultName} 当前`
      : (target.username === username ? '你当前' : `${target.username} 当前`)
    this.msg(username, `${prefix}已使用 ${quota.usedSlots}/${quota.quotaSlots} 格，约 ${quota.usedItems} 个物品，${percent}%。`)
  }

  async handleAddAdmin (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限添加管理员。')
      return
    }

    const parts = text.split(/\s+/).filter(Boolean)
    if (parts.length !== 2) {
      this.msg(username, '格式：!加管理员 玩家ID')
      return
    }

    const target = this.resolvePlayer(parts[1])
    this.db.addAdmin(target.username, target.uuid.startsWith('name:') ? null : target.uuid)
    this.msg(username, `已添加管理员：${target.username}`)
  }

  isBotGameCommand (text) {
    return /^!(指令|切换)(?:\s|$)/.test(String(text || ''))
  }

  async handleBotGameCommand (username, text, context = {}) {
    if (/^!切换(?:\s|$)/.test(String(text || ''))) {
      await this.handleSwitchHotbarCommand(username, text, context)
      return
    }
    const command = String(text || '').replace(/^!指令(?:\s+)?/, '').trim()
    const privateSource = this.isPrivateSource(context.source)
    if (!this.isAdmin(username)) {
      if (privateSource) this.msg(username, '你没有权限让机器人发送游戏内指令。')
      return
    }
    if (!command) {
      if (privateSource) this.msg(username, '格式：!指令 要让机器人发送的内容')
      return
    }
    if (this.active?.type === 'deposit' || this.active?.type === 'withdraw') {
      this.msg(username, `机器人正在为 ${this.active.username} 执行${this.active.type === 'deposit' ? '存货' : '取货'}任务，暂时不允许使用 !指令，以免打断返回 /home。`)
      return
    }
    if (this.config.debugChat) console.log(`[bot-command:${this.bot.username}] ${username} -> ${this.redactSensitiveText(command)}`)
    this.bot.chat(command)
    if (privateSource) this.msg(username, `已执行：${command}`)
  }

  // 手动把主手切到快捷栏第 n 格：排查手持物品干扰开箱（右键触发了物品效果而非开箱）等问题用。
  async handleSwitchHotbarCommand (username, text, context = {}) {
    const privateSource = this.isPrivateSource(context.source)
    if (!this.isAdmin(username)) {
      if (privateSource) this.msg(username, '你没有权限切换机器人快捷栏。')
      return
    }
    const slot = Number(String(text || '').replace(/^!切换(?:\s+)?/, '').trim())
    if (!Number.isInteger(slot) || slot < 1 || slot > 9) {
      if (privateSource) this.msg(username, '格式：切换 1~9，把机器人主手切到快捷栏第 n 格。')
      return
    }
    if (this.active?.type === 'deposit' || this.active?.type === 'withdraw') {
      if (privateSource) this.msg(username, `机器人正在为 ${this.active.username} 执行${this.active.type === 'deposit' ? '存货' : '取货'}任务，暂时不允许切换快捷栏。`)
      return
    }
    const before = this.describeHeldItemForSwitch()
    this.bot.setQuickBarSlot(slot - 1)
    if (privateSource) this.msg(username, `已切换到快捷栏第 ${slot} 格：${before} -> ${this.describeHeldItemForSwitch()}。`)
  }

  describeHeldItemForSwitch () {
    const held = this.bot.heldItem
    if (!held) return '空手'
    const display = this.catalog?.getDisplayName?.(held.name) || held.name
    return `${display} x${held.count}`
  }

  isWebLoginTokenCommand (text) {
    return /^!设置(?:密钥|密码)(?:\s+.*)?$/.test(text)
  }

  isWebLoginCodeCommand (text) {
    return /^!登录(?:\s+\d{6})?$/.test(text)
  }

  async handleWebLoginCode (username, text, context = {}) {
    if (!this.isPrivateSource(context.source)) {
      this.msg(username, '为了避免验证码泄露，请私聊我发送：登录 验证码。')
      return
    }
    const code = String(text || '').match(/^!登录\s+(\d{6})$/)?.[1] || ''
    if (!code) {
      this.msg(username, '格式：登录 网页上显示的6位验证码。')
      return
    }
    if (!this.webAuth?.approveLoginChallenge) {
      this.msg(username, '网页登录服务暂不可用，请稍后再试。')
      return
    }
    const result = this.webAuth.approveLoginChallenge(username, code)
    if (result.ok) {
      this.msg(username, '网页登录成功，请回到网页继续使用。')
    } else if (result.reason === 'unknown_player') {
      this.msg(username, '登录失败：没有获取到你的正版 UUID，请重新进服后再试。')
    } else {
      this.msg(username, '验证码无效或已过期，请回到网页重新获取。')
    }
  }

  async handleWebLoginToken (username, text, context = {}) {
    if (!this.isPrivateSource(context.source)) {
      this.msg(username, '为了避免泄露，请私聊我发送：设置密码 你自己的密码。')
      return
    }

    const player = this.getPlayer(username)
    const { customToken } = this.parseWebLoginTokenCommand(text)
    if (!customToken) {
      this.msg(username, '格式：设置密码 你自己的密码。每次设置都会覆盖旧密码。')
      return
    }
    const result = this.db.setWebLoginToken(player.uuid, player.username, customToken)
    const dashboardUrl = this.webAuth?.publicUrl?.() || this.config.web?.dashboardUrl || this.config.dashboardUrl || ''
    const loginHint = dashboardUrl
      ? `网页登录地址：${dashboardUrl}  已设置密码：${result.token}`
      : `已设置密码：${result.token}`
    this.msg(username, `${loginHint}。每次设置都会覆盖旧密码。注意：密码不检查复杂度，太简单可能被别人猜到；被破解造成库存信息泄露，后果自负。`)
  }

  parseWebLoginTokenCommand (text) {
    const match = String(text || '').match(/^!设置(?:密钥|密码)(?:\s+([\s\S]+))?$/)
    return { customToken: String(match?.[1] || '').trim() }
  }

  async handleSetQuota (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限设置额度。')
      return
    }

    const parts = text.split(/\s+/).filter(Boolean)
    if (parts.length !== 3) {
      this.msg(username, '格式：!设置额度 玩家ID 格数 或 !设置额度 仓库:仓库名 格数')
      return
    }

    const target = this.resolveQuotaOwnerArgument(parts[1])
    const slots = Number.parseInt(parts[2], 10)
    if (!Number.isFinite(slots) || slots < 0) {
      this.msg(username, '额度必须是大于等于 0 的整数格数。')
      return
    }

    this.db.setQuotaSlots(target.uuid, slots)
    const quota = this.getStorageQuota(target.uuid, target.scope)
    const label = target.scope === 'custom' ? `仓库 ${target.vaultName}` : target.username
    this.msg(username, `已设置 ${label} 的额度为 ${slots} 格；当前已用 ${quota.usedSlots}/${quota.quotaSlots} 格。`)
  }

  async handleAdjustBalance (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限修改玩家库存。')
      return
    }

    const match = text.match(/^!(增加|减少)\s+(\S+)\s+(.+?)\s+(\d+)$/)
    if (!match) {
      this.msg(username, '格式：!增加 玩家ID 物品名 数量 或 !减少 玩家ID 物品名 数量')
      return
    }

    const [, action, targetName, itemName, amountText] = match
    const amount = Number.parseInt(amountText, 10)
    if (!Number.isFinite(amount) || amount <= 0) {
      this.msg(username, '数量必须是大于 0 的整数。')
      return
    }

    const target = this.resolvePlayer(targetName)
    const resolved = this.catalog.resolveName(itemName)
    const item = this.catalog.fromItemIdAmount(resolved.itemId, amount)

    if (action === '增加') {
      this.db.addBalanceItems(target.uuid, [item])
      this.db.addTransaction('admin_adjust_add', 'ok', target.uuid, target.username, [item], `admin=${username}`)
      const total = this.db.getOwnerTotalByItemId(target.uuid, item.itemId)
      this.msg(username, `已给 ${target.username} 增加 ${this.catalog.getDisplayName(item.itemId)} x${amount}，当前共 x${total}。`)
      return
    }

    const current = this.db.getOwnerTotalByItemId(target.uuid, item.itemId)
    const removeAmount = Math.min(amount, current)
    if (removeAmount <= 0) {
      this.msg(username, `${target.username} 当前没有 ${this.catalog.getDisplayName(item.itemId)}。`)
      return
    }

    const removals = this.buildAdminRemovalItems(target.uuid, item.itemId, removeAmount)
    this.db.removeBalanceItems(target.uuid, removals)
    this.db.addTransaction('admin_adjust_remove', 'ok', target.uuid, target.username, removals, `admin=${username}, requested=${amount}`)
    const total = this.db.getOwnerTotalByItemId(target.uuid, item.itemId)
    this.msg(username, `已从 ${target.username} 减少 ${this.catalog.getDisplayName(item.itemId)} x${removeAmount}，当前剩余 x${total}。`)
  }

  buildAdminRemovalItems (ownerUuid, itemId, amount) {
    const rows = this.db.getOwnerItemsByItemId(ownerUuid, itemId)
    const removals = []
    let remaining = amount

    for (const row of rows) {
      if (remaining <= 0) break
      const removeAmount = Math.min(row.amount, remaining)
      removals.push({
        itemKey: row.itemKey,
        itemId: row.itemId,
        displayName: row.displayName,
        nbtJson: row.nbtJson || '',
        metaJson: row.metaJson || '',
        amount: removeAmount
      })
      remaining -= removeAmount
    }

    return removals
  }

  // ── 多 bot 并行全仓同步 ──────────────────────────────────────────────
  // 硬约束：对账（applyWarehouseScan）必须一次性拿到全仓快照，否则会出现
  // "账 > 实物"的假缺口。因此并行只发生在扫描阶段：各 bot 分区扫完后，
  // 由协调 bot 持仓库锁统一重读变更桶、换记录、对账。

  // 按既有扫描顺序切空间连续条带（findContainerBlocks 按距离排序，连续段
  // = 同心环带），减少并行 bot 互相穿越挡路；并集=全集、互不重叠。
  splitBlocksForParallelSync (workerCount, blocks) {
    const strips = Array.from({ length: workerCount }, () => [])
    blocks.forEach((block, index) => {
      strips[Math.min(workerCount - 1, Math.floor((index * workerCount) / blocks.length))].push(block)
    })
    return strips
  }

  // 收集并行参与者：协调 bot + 其他空闲健康 bot（跳过正在跑任务、
  // 死亡恢复中、紧急救援中的），maxParallelSyncBots 可限制并行上限。
  collectSyncParticipants (coordinator) {
    if (!this.taskPool) return [coordinator]
    const cap = Number(this.config.warehouse.maxParallelSyncBots || 0)
    const idle = [...this.taskPool.workers].filter(candidate =>
      candidate !== coordinator &&
      candidate.ready && !candidate.active && !candidate.recoveringFromDeath && !candidate.emergencyRescueActive)
    const picked = cap > 0 ? idle.slice(0, cap - 1) : idle
    return [coordinator, ...picked]
  }

  async syncWarehouseWithTeam (coordinator, radius, trace, options = {}) {
    const blocks = await coordinator.warehouse.prepareSyncBlocks(radius)
    const participants = this.collectSyncParticipants(coordinator)
    // 桶数不足就不分区（<=1 个桶并行没有意义）。
    const workerCount = blocks.length > 1 ? Math.min(participants.length, blocks.length) : 1
    const team = participants.slice(0, workerCount)

    if (workerCount === 1) {
      const scan = await coordinator.warehouse.scanBarrelBlocks(blocks, radius)
      const result = await coordinator.warehouse.withWarehouseLock(() => coordinator.warehouse.applyWarehouseScan(scan, radius, options))
      return { ...result, botCount: 1 }
    }

    const strips = this.splitBlocksForParallelSync(workerCount, blocks)
    traceEvent(trace, 'sync', 'sync_partition_plan', {
      botCount: workerCount,
      partitionSizes: strips.map(strip => strip.length),
      decision: `分区并行扫描：${team.map(service => service.botId).join(' + ')}`
    })

    // 借用的 bot 挂上任务标记：快照如实显示"同步中"，任务池派发双保险。
    const borrowed = team.slice(1)
    for (const service of borrowed) {
      service.active = { type: 'sync', name: 'sync', username: 'admin', exclusive: false, borrowedBySync: coordinator.botId }
    }

    try {
      // 等所有分区全部落地再合并：任一分区失败整体中止，旧记录原样保留。
      const settled = await Promise.allSettled(strips.map((strip, index) => team[index].warehouse.scanSyncPartition(radius, strip)))
      const failure = settled.find(outcome => outcome.status === 'rejected')
      if (failure) throw failure.reason
      const scans = settled.map(outcome => outcome.value)
      const merged = {
        radius,
        blocks,
        snapshots: scans.flatMap(scan => scan.snapshots),
        actualItems: scans.flatMap(scan => scan.actualItems)
      }
      const result = await coordinator.warehouse.withWarehouseLock(() => coordinator.warehouse.applyWarehouseScan(merged, radius, options))
      return { ...result, botCount: workerCount }
    } finally {
      for (const service of borrowed) {
        if (service.active?.borrowedBySync === coordinator.botId) service.active = null
      }
    }
  }

  async handleSync (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限同步仓库。')
      return
    }

    await this.enqueueTask(username, 'sync', async worker => {
      const parts = text.split(/\s+/).filter(Boolean)
      // "强制" 用于确属拆除木桶后的缩量重扫，跳过缩量守卫（守卫默认开启，
      // 防止小半径同步误删半径外的桶记录并对账抽干 momo）。
      const force = parts.slice(1).some(part => part === '强制' || part.toLowerCase() === 'force')
      const numericArg = parts.slice(1).find(part => /^-?\d+$/.test(part))
      const radius = clampInt(
        numericArg,
        this.config.warehouse.defaultSyncRadius,
        1,
        this.config.warehouse.maxSyncRadius
      )
      const trace = startTrace({ bot: this.botId, kind: 'sync', actor: username, radius })
      this.attachWarehouseTrace(trace)
      this.msg(username, `开始同步仓库，半径 ${radius}${force ? '（强制，跳过缩量守卫）' : ''}。`)
      try {
        const result = await this.syncWarehouseWithTeam(worker, radius, trace, { allowShrink: force })
        const addedAmount = this.totalAmount(result.addedToMomo)
        const unresolvedAmount = this.totalAmount(result.unresolved)
        const failureText = result.failures.length ? `，失败${result.failures.length}` : ''
        const parallelText = result.botCount > 1 ? `，${result.botCount}台并行` : ''
        this.msg(username, `同步完成：木桶${result.chestCount}，打开${result.openedChestCount}，重读${result.rescanCount || 0}${failureText}${parallelText}，多余${addedAmount}/${this.itemTypeCount(result.addedToMomo)}种，缺失${unresolvedAmount}/${this.itemTypeCount(result.unresolved)}种。详情见Web管理页。`)
        traceSummary(trace, {
          status: 'ok',
          chests: result.chestCount,
          opened: result.openedChestCount,
          rescan: result.rescanCount || 0,
          bots: result.botCount,
          addedTotal: addedAmount,
          unresolvedTotal: unresolvedAmount
        })
      } catch (error) {
        traceEvent(trace, 'error', 'sync_error', { message: error?.message || String(error) })
        traceSummary(trace, { status: 'failed', message: error?.message || String(error) })
        throw error
      } finally {
        this.detachWarehouseTrace()
      }
    }, { exclusive: true })
  }

  // 调试命令 !同步木桶：只同步一个木桶并回报该桶的详细物品信息（含潜影盒内容展开），
  // 用于快速核对“账本 vs 实物”而不用跑一次耗时的全仓同步。
  parseBarrelCoords (text) {
    const match = String(text || '').match(/^!同步木桶\s+(.+)$/)
    if (!match) return null
    const parts = match[1].trim().split(/[\s,，]+/).filter(Boolean)
    if (parts.length !== 3) return null
    const coords = parts.map(part => Number(part))
    if (coords.some(value => !Number.isFinite(value))) return null
    const [x, y, z] = coords
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
  }

  async handleSyncBarrel (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限同步木桶。')
      return
    }

    const coords = this.parseBarrelCoords(text)
    if (!coords) {
      this.msg(username, '格式：!同步木桶 x y z（也支持 x,y,z）。坐标可用 !查 或 Web 管理页里的木桶位置。')
      return
    }

    await this.enqueueTask(username, 'sync', async worker => {
      const chestLabel = `${coords.x},${coords.y},${coords.z}`
      const trace = startTrace({
        bot: this.botId,
        kind: 'barrel-debug',
        actor: username,
        chest: chestLabel,
        commandText: String(text || '')
      })
      this.attachWarehouseTrace(trace)
      this.msg(username, `开始同步木桶 ${chestLabel}……`)
      try {
        const detail = await worker.warehouse.syncSingleBarrel(coords)
        traceSummary(trace, {
          status: 'ok',
          chest: detail.chest?.describe || chestLabel,
          types: detail.types,
          total: detail.total
        })
        const lines = this.formatBarrelDetailLines(detail)
        for (const chunk of lines) this.msg(username, chunk)
      } catch (error) {
        traceEvent(trace, 'error', 'barrel_debug_error', { message: error?.message || String(error) })
        traceSummary(trace, { status: 'failed', message: error?.message || String(error) })
        throw error
      } finally {
        this.detachWarehouseTrace()
      }
    }, { exclusive: true })
  }

  // Web 管理页“木桶视图”的实时重读：与 !同步木桶 同一条链路（开桶 → 替换槽位记录），
  // 但不向游戏内发消息，结果直接回给面板。专用排他任务，避免与存取/全仓同步并发。
  resyncBarrelForAdmin (coords, admin) {
    const actor = String(admin?.username || 'web-admin')
    return this.enqueueTask(actor, 'sync', async worker => {
      const chestLabel = `${coords.x},${coords.y},${coords.z}`
      const trace = startTrace({
        bot: this.botId,
        kind: 'barrel-debug',
        actor,
        source: 'web',
        chest: chestLabel
      })
      this.attachWarehouseTrace(trace)
      try {
        const detail = await worker.warehouse.syncSingleBarrel(coords)
        traceSummary(trace, { status: 'ok', source: 'web', chest: detail.chest?.describe || chestLabel, types: detail.types, total: detail.total })
        return detail
      } catch (error) {
        traceEvent(trace, 'error', 'barrel_debug_error', { source: 'web', message: error?.message || String(error) })
        traceSummary(trace, { status: 'failed', source: 'web', message: error?.message || String(error) })
        throw error
      } finally {
        this.detachWarehouseTrace()
      }
    }, { exclusive: true })
  }

  formatBarrelDetailLines (detail) {
    const chestLabel = detail.chest?.describe || `${detail.chest?.x},${detail.chest?.y},${detail.chest?.z}`
    const lines = [`木桶 ${chestLabel} 同步完成：${detail.types} 种物品，共 ${detail.total} 个。`]
    if (!detail.items.length) {
      lines.push('（桶是空的）')
      return lines
    }
    for (const item of detail.items) {
      let line = `槽${item.slot}：${item.name} x${item.amount}（短码 ${item.keyTail}）`
      if (Array.isArray(item.shulkerContents) && item.shulkerContents.length) {
        const contents = item.shulkerContents
          .map(entry => `${entry.name}x${entry.n}`)
          .join('、')
        line += `，盒内：${contents}`
      } else if (Array.isArray(item.shulkerContents)) {
        line += '，盒内：空'
      }
      lines.push(line)
    }
    return lines
  }

  async handleClearInventory (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限清空库存记录。')
      return
    }

    const poolState = this.taskPool?.snapshot()
    if (this.active || poolState?.active?.length || poolState?.queued?.length) {
      this.msg(username, '当前仍有存取或同步任务，不能清空库存记录。')
      return
    }

    const parts = text.split(/\s+/).filter(Boolean)
    if (parts[1] !== '确认') {
      this.msg(username, '此操作会清空库存、木桶位置、同步异常、存取记录和历史物品档案；保留管理员、组织仓库、成员、玩家、额度和配置别名。确认执行请输入：!清空库存 确认')
      return
    }

    const counts = this.db.clearInventoryData()
    this.msg(username, `已清空库存记录：库存${counts.balances}条，木桶${counts.chests}个，槽位${counts.chestSlots}条，潜影盒索引${counts.shulkerContents}条，异常${counts.inventoryMismatches || 0}条，记录${counts.transactions}条，物品档案${counts.items}条。`)
  }

  buildWithdrawPlan (ownerUuid, requests, ownerLabel = '你当前') {
    const notices = []
    const allocations = []
    const reservedLooseItems = new Map()
    const reservedShulkerBoxes = new Map()

    for (const request of requests) {
      const rows = request.itemKey
        ? this.db.getOwnerItemsByItemKey(ownerUuid, request.itemKey)
        : this.db.getOwnerItemsByItemId(ownerUuid, request.itemId)
      const availableRows = rows
        .map(row => ({
          ...row,
          availableAmount: Math.max(0, Number(row.amount || 0) - Number(reservedLooseItems.get(row.itemKey) || 0))
        }))
        .filter(row => row.availableAmount > 0)
      const looseAvailable = availableRows.reduce((sum, row) => sum + row.availableAmount, 0)
      const displayName = request.displayName || this.catalog.getDisplayName(request.itemId)
      const shulkerRows = this.resolveShulkerRowsForWithdraw(ownerUuid, request)
      const shulkerAvailable = shulkerRows.reduce((sum, row) => {
        const reserved = Math.min(Number(reservedShulkerBoxes.get(row.shulkerItemKey) || 0), Number(row.shulkerAmount || 0))
        const availableBoxes = Math.max(0, Number(row.shulkerAmount || 0) - reserved)
        return sum + availableBoxes * Number(row.containedAmount || 0)
      }, 0)
      const available = looseAvailable + shulkerAvailable

      if (available <= 0) {
        notices.push(`${ownerLabel}只有 0 个${displayName}，无法取出 ${request.amount} 个。`)
        continue
      }

      if (available < request.amount) {
        notices.push(`${ownerLabel}散装和潜影盒内合计只有 ${available} 个${displayName}，将尽量取出。`)
      }

      if (this.db.isQuickShulkerExtractionEnabled && !this.db.isQuickShulkerExtractionEnabled(ownerUuid)) {
        this.planLegacyWholeShulkerWithdrawals({
          shulkerRows,
          availableRows,
          request,
          displayName,
          remainingRequest: Math.min(request.amount, available),
          reservedLooseItems,
          reservedShulkerBoxes,
          allocations
        })
        continue
      }

      let remainingRequest = Math.min(request.amount, available)
      const deliverWholeShulkers = request.amount >= WHOLE_SHULKER_WITHDRAW_THRESHOLD

      for (const row of deliverWholeShulkers ? shulkerRows : []) {
        if (remainingRequest <= 0) break
        const perBox = Number(row.containedAmount || 0)
        const ownedBoxes = Number(row.shulkerAmount || 0)
        const reserved = reservedShulkerBoxes.get(row.shulkerItemKey) || 0
        const availableBoxes = Math.max(0, ownedBoxes - reserved)
        if (perBox <= 0 || availableBoxes <= 0 || !this.isFullSingleItemShulkerRow(row)) continue

        const boxes = Math.min(availableBoxes, Math.floor(remainingRequest / perBox))
        if (boxes <= 0) continue

        const coveredAmount = boxes * perBox
        const allocation = this.shulkerRowToAllocation(row, boxes, displayName, request, coveredAmount)
        allocations.push(allocation)
        reservedShulkerBoxes.set(row.shulkerItemKey, reserved + boxes)
        remainingRequest -= coveredAmount
      }

      const loosePlanned = Math.min(remainingRequest, looseAvailable)
      let remaining = loosePlanned
      for (const row of availableRows) {
        if (remaining <= 0) break
        const amount = Math.min(row.availableAmount, remaining)
        const { availableAmount, ...item } = row
        allocations.push({
          ...item,
          amount,
          requestIndex: Number.isInteger(request?.requestIndex) ? request.requestIndex : undefined,
          requestItemKey: request?.itemKey || '',
          requestItemId: request?.itemId || '',
          requestDisplayName: displayName
        })
        reservedLooseItems.set(row.itemKey, Number(reservedLooseItems.get(row.itemKey) || 0) + amount)
        remaining -= amount
      }

      let remainingInside = Math.max(0, remainingRequest - loosePlanned)
      for (const row of shulkerRows) {
        if (remainingInside <= 0) break
        const perBox = Number(row.containedAmount || 0)
        const ownedBoxes = Number(row.shulkerAmount || 0)
        const reserved = reservedShulkerBoxes.get(row.shulkerItemKey) || 0
        const availableBoxes = Math.max(0, ownedBoxes - reserved)
        if (perBox <= 0 || availableBoxes <= 0) continue

        const boxes = Math.min(availableBoxes, Math.ceil(remainingInside / perBox))
        if (boxes <= 0) continue

        const coveredAmount = Math.min(remainingInside, boxes * perBox)
        const deliverWholeBox = deliverWholeShulkers &&
          remainingInside >= perBox &&
          this.isFullSingleItemShulkerRow(row)
        const allocation = deliverWholeBox
          ? this.shulkerRowToAllocation(row, boxes, displayName, request, coveredAmount)
          : this.shulkerRowToExtractionAllocation(row, boxes, displayName, request, coveredAmount)
        allocations.push(allocation)
        reservedShulkerBoxes.set(row.shulkerItemKey, reserved + boxes)
        remainingInside -= coveredAmount
      }

    }

    return { notices, allocations: this.mergeAllocations(allocations) }
  }

  planLegacyWholeShulkerWithdrawals ({ shulkerRows, availableRows, request, displayName, remainingRequest, reservedLooseItems, reservedShulkerBoxes, allocations }) {
    let preferredShulkerCovered = 0
    for (const row of shulkerRows) {
      if (remainingRequest <= 0) break
      const perBox = Number(row.containedAmount || 0)
      const ownedBoxes = Number(row.shulkerAmount || 0)
      const reserved = Number(reservedShulkerBoxes.get(row.shulkerItemKey) || 0)
      const availableBoxes = Math.max(0, ownedBoxes - reserved)
      if (perBox <= 0 || availableBoxes <= 0) continue
      if (!this.isSingleItemShulkerRow(row)) continue
      const boxes = Math.min(availableBoxes, Math.floor(remainingRequest / perBox))
      if (boxes <= 0) continue
      const coveredAmount = boxes * perBox
      allocations.push(this.shulkerRowToAllocation(row, boxes, displayName, request, coveredAmount))
      reservedShulkerBoxes.set(row.shulkerItemKey, reserved + boxes)
      preferredShulkerCovered += coveredAmount
      remainingRequest -= coveredAmount
    }
    const loosePlanned = Math.min(remainingRequest, availableRows.reduce((sum, row) => sum + row.availableAmount, 0))
    let looseRemaining = loosePlanned
    for (const row of availableRows) {
      if (looseRemaining <= 0) break
      const amount = Math.min(row.availableAmount, looseRemaining)
      const { availableAmount, ...item } = row
      allocations.push({ ...item, amount, requestIndex: Number.isInteger(request?.requestIndex) ? request.requestIndex : undefined, requestItemKey: request?.itemKey || '', requestItemId: request?.itemId || '', requestDisplayName: displayName })
      reservedLooseItems.set(row.itemKey, Number(reservedLooseItems.get(row.itemKey) || 0) + amount)
      looseRemaining -= amount
    }
    let remainingInside = request.amount - preferredShulkerCovered - loosePlanned
    for (const row of shulkerRows) {
      if (remainingInside <= 0) break
      const perBox = Number(row.containedAmount || 0)
      const ownedBoxes = Number(row.shulkerAmount || 0)
      const reserved = Number(reservedShulkerBoxes.get(row.shulkerItemKey) || 0)
      const availableBoxes = Math.max(0, ownedBoxes - reserved)
      if (perBox <= 0 || availableBoxes <= 0) continue
      const boxes = Math.min(availableBoxes, Math.ceil(remainingInside / perBox))
      if (boxes <= 0) continue
      const coveredAmount = Math.min(remainingInside, boxes * perBox)
      allocations.push(this.shulkerRowToAllocation(row, boxes, displayName, request, coveredAmount))
      reservedShulkerBoxes.set(row.shulkerItemKey, reserved + boxes)
      remainingInside -= coveredAmount
    }
  }

  isSingleItemShulkerRow (row) {
    const slotCount = Number(row?.slotCount || 0)
    const totalSlotCount = Number(row?.totalSlotCount || 0)
    const containedAmount = Number(row?.containedAmount || 0)
    const totalContainedAmount = Number(row?.boxContainedAmount || 0)
    return slotCount > 0 &&
      containedAmount > 0 &&
      totalSlotCount === slotCount &&
      totalContainedAmount === containedAmount
  }

  isFullSingleItemShulkerRow (row) {
    if (!this.isSingleItemShulkerRow(row)) return false
    const stackSize = Math.max(1, Number(this.catalog.getStackSize(row.containedItemId) || 64))
    const fullAmount = 27 * stackSize
    return Number(row.containedAmount || 0) === fullAmount &&
      Number(row.slotCount || 0) === 27
  }

  buildWithdrawPlanForRequest (player, storageOwner, requests) {
    if (storageOwner.scope !== 'personal' || storageOwner.uuid !== player.uuid || storageOwner.strictPersonal) {
      const ownerLabel = storageOwner.scope === 'custom' ? `${storageOwner.vaultName} 当前` : '你当前'
      const plan = this.buildWithdrawPlan(storageOwner.uuid, requests, ownerLabel)
      return {
        notices: plan.notices,
        allocations: this.withWithdrawOwner(plan.allocations, storageOwner)
      }
    }

    const indexedRequests = requests.map((request, index) => ({
      ...request,
      requestIndex: index,
      requestedAmount: Number(request.amount || 0)
    }))
    const owners = this.withdrawSourceOwners(player, storageOwner)

    const allocations = []
    const supplementNames = []
    let remainingRequests = indexedRequests

    for (let index = 0; index < owners.length && remainingRequests.length; index++) {
      const owner = owners[index]
      const label = owner.scope === 'custom' ? `${owner.vaultName} 当前` : '你当前'
      const plan = this.buildWithdrawPlan(owner.uuid, remainingRequests, label)
      const tagged = this.withWithdrawOwner(plan.allocations, owner)
      if (tagged.length && owner.scope === 'custom') supplementNames.push(owner.vaultName)
      allocations.push(...tagged)
      remainingRequests = this.remainingWithdrawRequestsAfterPlan(remainingRequests, plan.allocations)
    }

    const notices = []
    if (supplementNames.length) {
      notices.push(`个人仓库库存不足，已自动从组织仓库 ${[...new Set(supplementNames)].join('、')} 补取。`)
    }
    for (const request of remainingRequests) {
      const totalWanted = Number(request.requestedAmount || request.amount || 0)
      const got = Math.max(0, totalWanted - Number(request.amount || 0))
      const displayName = request.displayName || this.catalog.getDisplayName(request.itemId)
      if (got > 0) {
        notices.push(`个人仓库和组织仓库合计只有 ${got} 个${displayName}，将尽量取出。`)
      } else {
        notices.push(`个人仓库和组织仓库都没有 ${displayName}，无法取出 ${totalWanted} 个。`)
      }
    }

    return { notices, allocations }
  }

  withdrawSourceOwners (player, storageOwner) {
    if (storageOwner.scope !== 'personal' || storageOwner.uuid !== player.uuid || storageOwner.strictPersonal) {
      return [storageOwner]
    }
    return [
      storageOwner,
      ...this.db.listCustomWarehousesForPlayer(player.uuid).map(row => this.resolveCustomWarehouseOwner(row))
    ]
  }

  withWithdrawOwner (allocations, owner) {
    return (allocations || []).map(item => ({
      ...item,
      ownerUuid: owner.uuid,
      ownerUsername: owner.username,
      ownerScope: owner.scope || 'personal',
      ownerVaultName: owner.vaultName || ''
    }))
  }

  remainingWithdrawRequestsAfterPlan (requests, allocations) {
    const coveredByKey = this.sumWithdrawCoverageByKey(allocations)
    const remaining = []
    for (const request of requests || []) {
      const key = this.withdrawCoverageKey(request)
      const covered = Number(coveredByKey.get(key) || 0)
      const used = Math.min(Number(request.amount || 0), covered)
      if (covered > 0) coveredByKey.set(key, covered - used)
      const left = Number(request.amount || 0) - used
      if (left > 0) remaining.push({ ...request, amount: left })
    }
    return remaining
  }

  allocateWithdrawnToPlanned (planned, withdrawn) {
    const actualByKey = sumBy(withdrawn || [], item => item.itemKey)
    const delivered = []
    for (const item of planned || []) {
      const available = actualByKey.get(item.itemKey) || 0
      const amount = Math.min(Number(item.amount || 0), available)
      if (amount > 0) {
        delivered.push(this.withDeliveredCoverageAmount(item, amount))
        actualByKey.set(item.itemKey, available - amount)
      }
    }
    return delivered
  }

  itemsExceedingPlan (actual, planned) {
    const plannedByKey = sumBy(planned || [], item => item.itemKey)
    const excess = []
    for (const item of this.mergeItems(actual || [])) {
      const allowed = Number(plannedByKey.get(item.itemKey) || 0)
      const amount = Math.max(0, Number(item.amount || 0) - allowed)
      if (amount > 0) excess.push({ ...item, amount })
    }
    return excess
  }

  recordWithdrawDeduction (fallbackOwner, items, message, deductionKey = '') {
    traceEvent(this.warehouse.activeTrace, 'ledger', 'deduct_commit', {
      deductionKey: deductionKey || '',
      message,
      items: (items || []).map(item => ({
        name: item.displayName || item.itemId,
        amount: item.amount,
        owner: item.ownerUuid || fallbackOwner.uuid,
        keyTail: shortKey(item.itemKey)
      })),
      decision: '按已确认交付数量扣减账本库存（幂等键防重复扣）'
    })
    const groups = new Map()
    for (const item of items || []) {
      const ownerUuid = item.ownerUuid || fallbackOwner.uuid
      let group = groups.get(ownerUuid)
      if (!group) {
        group = {
          ownerUuid,
          username: item.ownerUsername || (ownerUuid === fallbackOwner.uuid ? fallbackOwner.username : this.db.ownerLabel(ownerUuid)),
          items: []
        }
        groups.set(ownerUuid, group)
      }
      group.items.push(item)
    }

    if (deductionKey && typeof this.db.applyWithdrawDeduction === 'function') {
      return this.db.applyWithdrawDeduction(deductionKey, [...groups.values()], message)
    }

    this.db.transaction(() => {
      for (const group of groups.values()) {
        const merged = this.mergeItems(group.items)
        for (const item of merged) {
          const stored = this.db.getItemByKey(item.itemKey)
          const complete = {
            ...stored,
            ...item,
            itemId: item.itemId || stored?.itemId,
            displayName: item.displayName || stored?.displayName,
            nbtJson: item.nbtJson ?? stored?.nbtJson,
            metaJson: item.metaJson ?? stored?.metaJson
          }
          if (!complete.itemId || !complete.displayName || complete.nbtJson === undefined || complete.metaJson === undefined) {
            throw new Error(`扣账物品记录不完整：${item.itemKey}`)
          }
          this.db.upsertItem(complete)
          this.db.adjustBalance(group.ownerUuid, item.itemKey, -item.amount)
        }
        this.db.addTransaction('withdraw', 'ok', group.ownerUuid, group.username, merged, message)
      }
    })
  }

  mergeAllocations (allocations) {
    const byKey = new Map()
    for (const item of allocations) {
      const requestIndex = Number.isInteger(item.requestIndex) ? item.requestIndex : ''
      const key = `${item.withdrawMode || 'item'}|${item.sourceShulkerItemKey || ''}|${item.itemKey}|${this.withdrawCoverageKey(item)}|${requestIndex}`
      const existing = byKey.get(key)
      if (existing) {
        existing.amount += item.amount
        if (item.withdrawMode === 'shulker_extract') {
          existing.sourceBoxCount = Number(existing.sourceBoxCount || 0) + Number(item.sourceBoxCount || 0)
          existing.reservationAmount = Number(existing.reservationAmount || 0) + Number(item.reservationAmount || 0)
        }
        if (Number(item.coverageAmount || 0) > 0 || Number(existing.coverageAmount || 0) > 0) {
          existing.coverageAmount = Number(existing.coverageAmount || 0) + Number(item.coverageAmount || 0)
        }
      } else {
        byKey.set(key, { ...item })
      }
    }
    return [...byKey.values()]
  }

  splitAllocationsIntoInventoryBatches (allocations, maxSlots = 36) {
    const batches = []
    let current = []
    let usedSlots = 0
    let workspaceSlots = 0
    const limit = Math.max(1, Number.parseInt(maxSlots, 10) || 36)

    const pushCurrent = () => {
      if (!current.length) return
      batches.push(current)
      current = []
      usedSlots = 0
      workspaceSlots = 0
    }

    for (const item of allocations || []) {
      let remaining = Number.parseInt(item.amount, 10)
      if (!Number.isFinite(remaining) || remaining <= 0) continue
      const stackSize = Math.max(1, this.catalog.getStackSize(item.itemId))

      while (remaining > 0) {
        const itemWorkspaceSlots = item.withdrawMode === 'shulker_extract' ? 1 : 0
        const requiredWorkspaceSlots = Math.max(workspaceSlots, itemWorkspaceSlots)
        if (usedSlots >= limit - requiredWorkspaceSlots) pushCurrent()
        workspaceSlots = Math.max(workspaceSlots, itemWorkspaceSlots)
        const freeSlots = Math.max(1, limit - workspaceSlots - usedSlots)
        const amount = Math.min(remaining, freeSlots * stackSize)
        const slots = Math.ceil(amount / stackSize)
        current.push({ ...item, amount })
        usedSlots += slots
        remaining -= amount
        if (usedSlots >= limit - workspaceSlots) pushCurrent()
      }
    }

    pushCurrent()
    return batches
  }

  withdrawBatchNoticeSuffix (batchCount) {
    return batchCount > 1 ? `，本次会分 ${batchCount} 批` : ''
  }

  setWithdrawBatchProgress (batchIndex, totalBatches, phase) {
    if (!this.active) return
    this.active.phase = phase
    this.active.batchIndex = batchIndex
    this.active.totalBatches = totalBatches
  }

  inventorySlotsForItems (items) {
    return (items || []).reduce((sum, item) => {
      const stackSize = Math.max(1, this.catalog.getStackSize(item.itemId))
      return sum + Math.ceil(Number(item.amount || 0) / stackSize)
    }, 0)
  }

  groupMissingByDisplay (planned, delivered, missingItems = []) {
    const plannedByKey = this.sumWithdrawCoverageByKey(planned)
    const deliveredByKey = this.sumWithdrawCoverageByKey(delivered)
    // 背包已满导致的少取不是仓库缺货：单独提示，且不参与确认缺失自动修账
    const inventoryFullKeys = new Set(
      (missingItems || []).filter(item => item.inventoryFull).map(item => item.itemKey)
    )
    const notices = []
    for (const item of planned) {
      const missing = (plannedByKey.get(this.withdrawCoverageKey(item)) || 0) - (deliveredByKey.get(this.withdrawCoverageKey(item)) || 0)
      if (missing > 0) {
        const name = item.requestDisplayName || item.displayName || this.catalog.getDisplayName(item.itemId)
        const full = inventoryFullKeys.has(item.itemKey) || inventoryFullKeys.has(item.requestItemKey)
        notices.push(full
          ? `${name} 机器人背包已满，少取 ${missing} 个；仓库有货未扣库存，可稍后单独再取。`
          : `${name} 仓库实际库存不足，少取 ${missing} 个；只扣除实际交付数量。`)
      }
    }
    return [...new Set(notices)]
  }

  withdrawCoverageKey (item) {
    if (Number.isInteger(item.requestIndex)) return `request:${item.requestIndex}`
    return item.requestItemKey || item.requestItemId || item.itemKey
  }

  withdrawCoverageAmount (item) {
    const coverage = Number(item.coverageAmount || 0)
    return coverage > 0 ? coverage : Number(item.amount || 0)
  }

  withDeliveredCoverageAmount (item, amount) {
    const next = { ...item, amount }
    if (Number(item.coverageAmount || 0) > 0) {
      const perBox = Number(item.containedAmountPerBox || 0)
      next.coverageAmount = perBox > 0
        ? Math.min(Number(item.coverageAmount || 0), amount * perBox)
        : Math.ceil(Number(item.coverageAmount || 0) * (amount / Math.max(1, Number(item.amount || 1))))
    }
    return next
  }

  sumWithdrawCoverageByKey (items) {
    const result = new Map()
    for (const item of items || []) {
      const key = this.withdrawCoverageKey(item)
      result.set(key, (result.get(key) || 0) + this.withdrawCoverageAmount(item))
    }
    return result
  }

  subtractLeftoverFromDelivered (delivered, leftover) {
    const leftoverByKey = sumBy(leftover, item => item.itemKey)
    const result = []
    for (const item of delivered || []) {
      const left = leftoverByKey.get(item.itemKey) || 0
      const subtract = Math.min(Number(item.amount || 0), left)
      const amount = Math.max(0, Number(item.amount || 0) - subtract)
      leftoverByKey.set(item.itemKey, left - subtract)
      if (amount > 0) result.push(this.withDeliveredCoverageAmount(item, amount))
    }
    return result
  }

  resolveByAliasChain (name, playerUuid) {
    const shortCodeItem = this.resolveStoredItemByShortCode(name)
    if (shortCodeItem) return { layer: 'shortCode', item: shortCodeItem }
    const personalAliasItem = this.db.findItemByPlayerAlias(playerUuid, name)
    if (personalAliasItem) return { layer: 'personal', item: personalAliasItem }
    const globalAliasItem = this.db.findItemByGlobalAlias(name, playerUuid)
    if (globalAliasItem) return { layer: 'global', item: globalAliasItem }
    if (this.db.isGlobalItemAliasDisabled(playerUuid, name)) return { layer: 'disabled', item: null }
    return { layer: 'none', item: null }
  }

  resolveStoredItem (name, playerUuid = '') {
    const alias = this.resolveByAliasChain(name, playerUuid)
    if (alias.item) return alias.item
    if (alias.layer === 'disabled') throw new Error(`你已禁用全局别名：${name}`)

    try {
      return this.catalog.resolveName(name)
    } catch (error) {
      const matches = this.db.findItemsByDisplayQuery(name, playerUuid)
      if (!matches.length) throw error
      const exact = matches.filter(item => item.displayName.toLowerCase() === String(name).trim().toLowerCase())
      const candidates = exact.length ? exact : matches
      if (candidates.length > 1) {
        const names = candidates.map(item => this.formatCandidateForWithdraw(item)).slice(0, 5).join('，')
        throw new Error(`物品名不够精确：${name}，匹配到 ${names}`)
      }
      const item = candidates[0]
      return {
        itemKey: item.itemKey,
        itemId: item.itemId,
        displayName: item.displayName
      }
    }
  }

  resolveStoredItemForWithdraw (name, playerUuid = '', storageOwner = null) {
    try {
      return this.resolveStoredItem(name, playerUuid)
    } catch (error) {
      const enchantedBook = this.resolveHighestStockedEnchantedBook(name, playerUuid, storageOwner)
      if (enchantedBook) return enchantedBook
      throw error
    }
  }

  resolveHighestStockedEnchantedBook (name, playerUuid = '', storageOwner = null) {
    const query = String(name || '').trim()
    if (!query || !storageOwner || typeof this.db.findItemsByDisplayQuery !== 'function') return null

    const ownerUuids = this.withdrawSourceOwners({ uuid: playerUuid }, storageOwner).map(owner => owner.uuid)
    const candidates = this.db.findItemsByDisplayQuery(query, playerUuid)
      .filter(item => item.itemId === 'minecraft:enchanted_book')
      .map(item => {
        const meta = this.catalog.parseStoredJson(item.metaJson, {})
        const enchantment = this.catalog.extractEnchantments(meta.components)
          .find(entry => String(entry.displayName || '').toLowerCase() === query.toLowerCase())
        return enchantment ? { item, level: Number(enchantment.level || 0) } : null
      })
      .filter(Boolean)
      .filter(candidate => ownerUuids.some(ownerUuid => {
        const loose = this.db.getOwnerItemsByItemKey(ownerUuid, candidate.item.itemKey)
        if (loose.length) return true
        const shulkers = this.db.getOwnerShulkersContainingItemKey(ownerUuid, candidate.item.itemKey)
        return shulkers.length > 0
      }))
      .sort((a, b) => b.level - a.level)

    if (!candidates.length) return null
    const highest = candidates.filter(candidate => candidate.level === candidates[0].level)
    if (highest.length > 1) {
      const names = highest.map(candidate => this.formatCandidateForWithdraw(candidate.item)).slice(0, 5).join('，')
      throw new Error(`最高等级附魔书不够精确：${query}，匹配到 ${names}`)
    }
    const item = highest[0].item
    return {
      itemKey: item.itemKey,
      itemId: item.itemId,
      displayName: item.displayName
    }
  }

  resolveStoredItemForOwnerQuery (ownerUuid, name, playerUuid = '') {
    const items = this.resolveStoredItemsForOwnerQuery(ownerUuid, name, playerUuid)
    if (!items.length) return null
    if (items.length > 1) {
      const names = items
        .map(item => `${this.formatCandidateForWithdraw(item)} x${item.amount}`)
        .slice(0, 5)
        .join('，')
      throw new Error(`物品名不够精确：${name}，匹配到 ${names}`)
    }
    return items[0]
  }

  resolveStoredItemsForOwnerQuery (ownerUuid, name, playerUuid = '') {
    const alias = this.resolveByAliasChain(name, playerUuid)
    if (alias.item) {
      const amount = this.db.getOwnerTotalByItemKey(ownerUuid, alias.item.itemKey)
      return amount > 0 ? [{ ...alias.item, amount }] : []
    }
    if (alias.layer === 'disabled') return []

    const raw = String(name || '').trim()
    try {
      const resolved = this.catalog.resolveName(raw)
      const rows = this.db.getOwnerItemsByItemId(ownerUuid, resolved.itemId)
      if (rows.length) return rows
      return []
    } catch (error) {
      const matches = this.db.findOwnerItemsByDisplayQuery(ownerUuid, raw, playerUuid)
      if (!matches.length) return []
      const exact = matches.filter(item => item.displayName.toLowerCase() === raw.toLowerCase())
      return exact.length ? exact : matches
    }
  }

  resolveShulkerRowsForWithdraw (ownerUuid, request) {
    if (request.itemKey) {
      return this.db.getOwnerShulkersContainingItemKey(ownerUuid, request.itemKey)
    }
    return this.db.getOwnerShulkersContainingItemId(ownerUuid, request.itemId)
  }

  resolveShulkerContentsForOwnerQuery (ownerUuid, name, playerUuid = '') {
    const alias = this.resolveByAliasChain(name, playerUuid)
    if (alias.item) {
      return this.db.getOwnerShulkersContainingItemKey(ownerUuid, alias.item.itemKey)
    }
    if (alias.layer === 'disabled') return []

    const raw = String(name || '').trim()
    try {
      const resolved = this.catalog.resolveName(raw)
      return this.db.getOwnerShulkersContainingItemId(ownerUuid, resolved.itemId)
    } catch {
      return this.db.findOwnerShulkersByContainedDisplayQuery(ownerUuid, raw)
    }
  }

  shulkerRowToAllocation (row, amount, requestedDisplayName = '', request = null, coveredAmount = 0) {
    return {
      itemKey: row.shulkerItemKey,
      itemId: row.shulkerItemId,
      displayName: row.shulkerDisplayName,
      nbtJson: row.shulkerNbtJson || '',
      metaJson: row.shulkerMetaJson || '',
      amount,
      shulkerForItem: requestedDisplayName,
      containedAmountPerBox: Number(row.containedAmount || 0),
      requestIndex: Number.isInteger(request?.requestIndex) ? request.requestIndex : undefined,
      requestItemKey: request?.itemKey || '',
      requestItemId: request?.itemId || '',
      requestDisplayName: requestedDisplayName,
      coverageAmount: Number(coveredAmount || 0)
    }
  }

  shulkerRowToExtractionAllocation (row, sourceBoxCount, requestedDisplayName = '', request = null, amount = 0) {
    const itemKey = request?.itemKey || row.containedItemKey || ''
    if (!itemKey) throw new Error(`潜影盒内容缺少物品指纹：${requestedDisplayName || row.containedItemId || 'unknown'}`)
    return {
      withdrawMode: 'shulker_extract',
      itemKey,
      itemId: row.containedItemId || request?.itemId || '',
      displayName: row.containedDisplayName || requestedDisplayName,
      amount: Number(amount || 0),
      sourceShulkerItemKey: row.shulkerItemKey,
      sourceShulkerItemId: row.shulkerItemId,
      sourceShulkerDisplayName: row.shulkerDisplayName,
      sourceShulkerNbtJson: row.shulkerNbtJson || '',
      sourceShulkerMetaJson: row.shulkerMetaJson || '',
      sourceBoxCount: Number(sourceBoxCount || 0),
      sourceContainedAmountPerBox: Number(row.containedAmount || 0),
      reservationItemKey: row.shulkerItemKey,
      reservationAmount: Number(sourceBoxCount || 0),
      shulkerForItem: requestedDisplayName,
      requestIndex: Number.isInteger(request?.requestIndex) ? request.requestIndex : undefined,
      requestItemKey: request?.itemKey || '',
      requestItemId: request?.itemId || '',
      requestDisplayName: requestedDisplayName
    }
  }

  resolveStoredItemByShortCode (name) {
    const code = String(name || '').trim().replace(/^#/, '')
    if (!/^[0-9a-fA-F]{6}$/.test(code)) return null
    const item = this.db.findItemByShortCode(code)
    if (!item) return null
    return {
      itemKey: item.itemKey,
      itemId: item.itemId,
      displayName: item.displayName,
      nbtJson: item.nbtJson || '',
      metaJson: item.metaJson || ''
    }
  }

  itemShortCode (item) {
    const match = String(item?.itemKey || '').match(/\|([0-9a-f]{6})/i)
    return match ? match[1].toLowerCase() : ''
  }

  formatItemNameWithCode (item) {
    const name = item.displayName || this.catalog.getDisplayName(item.itemId) || item.itemId
    const code = this.itemShortCode(item)
    return code ? `${name}(${code})` : name
  }

  formatQueryItemNameWithCode (item) {
    const code = this.itemShortCode(item)
    const baseName = this.catalog.getDisplayName(item.itemId) || item.itemId
    const customName = this.extractStoredCustomName(item)
    if (customName && customName !== baseName) {
      return code ? `${customName}/${baseName}(${code})` : `${customName}/${baseName}`
    }
    return this.formatItemNameWithCode(item)
  }

  extractStoredCustomName (item) {
    const meta = this.catalog.parseStoredJson(item?.metaJson, {})
    return this.catalog.extractCustomName(meta.components) || ''
  }

  formatWithdrawToken (item) {
    return this.itemShortCode(item) || item.displayName || this.catalog.getDisplayName(item.itemId) || item.itemId
  }

  formatCandidateForWithdraw (item) {
    return this.formatQueryItemNameWithCode(item)
  }

  sendQueryResult (username, prefix, items, shulkers = []) {
    if (!items.length) {
      this.msg(username, `${prefix}没有散装匹配库存。`)
    } else if (items.length === 1) {
      const item = items[0]
      this.msg(username, `${prefix}有 ${this.formatQueryItemNameWithCode(item)} x${item.amount}`)
    } else {
      const total = items.reduce((sum, item) => sum + item.amount, 0)
      const lines = items.slice(0, 6).map(item => `${this.formatQueryItemNameWithCode(item)} x${item.amount}`)
      this.msg(username, `${prefix}共有 ${total} 个，分为 ${items.length} 种：${lines.join('；')}`)
      if (items.length > 6) {
        this.msg(username, `还有 ${items.length - 6} 种未显示，请输入更精确的名字。`)
      }
    }

    if (shulkers.length) {
      this.msg(username, `潜影盒内有：${this.formatShulkerContentRows(shulkers)}`)
    }
  }

  formatShulkerContentRows (rows) {
    const lines = rows.slice(0, 5).map(row => {
      const box = this.formatItemNameWithCode({
        itemKey: row.shulkerItemKey,
        itemId: row.shulkerItemId,
        displayName: row.shulkerDisplayName,
        nbtJson: row.shulkerNbtJson || '',
        metaJson: row.shulkerMetaJson || ''
      })
      const containedNames = String(row.containedDisplayNames || this.catalog.getDisplayName(row.containedItemId) || row.containedItemId)
        .split(',')
        .filter(Boolean)
        .slice(0, 3)
        .join('/')
      const total = Number(row.totalContainedAmount || 0)
      const boxes = Number(row.shulkerAmount || 0)
      return `${box} x${boxes}盒，内含 ${containedNames} x${total}`
    })
    const suffix = rows.length > 5 ? `；还有 ${rows.length - 5} 种未显示` : ''
    return `${lines.join('；')}${suffix}`
  }

  formatShulkerAllocationList (items) {
    return items.map(item => `${this.formatItemNameWithCode(item)} x${item.amount}盒`).join('，')
  }

  parseWithdraw (text, playerUuid = '', storageOwner = null) {
    const tokens = text.split(/\s+/).filter(Boolean)
    const requests = []
    let nameParts = []

    const addRequest = (name, amountText = '1', source = name) => {
      const item = this.resolveStoredItemForWithdraw(name, playerUuid, storageOwner)
      const amount = this.parsePositiveAmount(amountText, `数量：${source}`)
      requests.push({ ...item, amount })
    }

    const canResolve = name => {
      try {
        this.resolveStoredItemForWithdraw(name, playerUuid, storageOwner)
        return true
      } catch {
        return false
      }
    }

    const flushDefaultRequest = () => {
      if (!nameParts.length) return
      const name = nameParts.join(' ')
      addRequest(name, '1', name)
      nameParts = []
    }

    for (const token of tokens) {
      if (/^[0-9a-fA-F]{6}$/.test(token) && this.resolveStoredItemByShortCode(token)) {
        nameParts.push(token)
        continue
      }

      const shortCodeCombined = token.match(/^([0-9a-fA-F]{6})(\d+)$/)
      if (shortCodeCombined && this.resolveStoredItemByShortCode(shortCodeCombined[1])) {
        addRequest(shortCodeCombined[1], shortCodeCombined[2], token)
        nameParts = []
        continue
      }

      if (/^\d+$/.test(token)) {
        if (!nameParts.length) {
          if (this.resolveStoredItemByShortCode(token)) {
            nameParts.push(token)
            continue
          }
          throw new Error(`无法解析：${token}，格式示例 石头64 或 石头 64`)
        }
        addRequest(nameParts.join(' '), token, `${nameParts.join(' ')} ${token}`)
        nameParts = []
        continue
      }

      const combined = token.match(/^(.+?)(\d+)$/)
      if (combined) {
        const name = [...nameParts, combined[1]].join(' ')
        if (!nameParts.length || canResolve(name)) {
          addRequest(name, combined[2], `${name}${combined[2]}`)
        } else {
          flushDefaultRequest()
          addRequest(combined[1], combined[2], token)
        }
        nameParts = []
        continue
      }

      if (nameParts.length && canResolve(nameParts.join(' '))) flushDefaultRequest()
      nameParts.push(token)
    }

    flushDefaultRequest()
    return requests
  }

  parsePositiveAmount (value, label = '数量') {
    const text = String(value ?? '').trim()
    if (!/^\d+$/.test(text)) throw new Error(`${label}必须是大于 0 的整数。`)
    const amount = Number(text)
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`${label}必须是大于 0 的整数。`)
    return amount
  }

  parseWithdrawCommand (text, owner, fallbackTarget = '', playerUuid = '') {
    const raw = this.extractWithdrawText(text, owner).trim()
    if (!raw) return { requests: [], targetUsername: fallbackTarget }

    const targetMatch = raw.match(/\s+([A-Za-z0-9_]{3,16})$/)
    if (targetMatch) {
      const candidateTarget = targetMatch[1]
      const itemText = raw.slice(0, -targetMatch[0].length).trim()
      if (itemText) {
        try {
          return {
            requests: this.parseWithdraw(itemText, playerUuid, owner),
            targetUsername: candidateTarget
          }
        } catch {
          // If the prefix is not a valid withdraw list, parse the whole text normally.
        }
      }
    }

    return {
      requests: this.parseWithdraw(raw, playerUuid, owner),
      targetUsername: fallbackTarget
    }
  }

  async flushResidual () {
    if (this.db.hasPendingCraft?.(this.botId)) throw new Error('存在合成恢复记录，禁止将其残留物记入 momo；请执行 !合成恢复。')
    const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    const task = this.db.getRecoveryTask(this.botId)
    if (!held.length) {
      const pendingRepack = this.db.getShulkerRepackRecovery?.(this.botId)
      if (pendingRepack && !this.clearOrphanedPreparedShulkerRepack(pendingRepack, task, held)) {
        console.warn(`[shulker-repack-recovery] no held items while recovery remains pending; keeping the record and continuing task: bot=${this.botId} state=${pendingRepack.state}`)
      }
      return
    }

    const pendingRepack = this.resolvePreparedShulkerRepackRecovery()
    if (task?.type === 'deposit') {
      const owner = this.recoveryOwnerFromTask(task)
      console.warn(`[residual-recovery] continuing pending deposit before task: actor=${task.actorUsername}, owner=${owner.uuid}, held=${this.formatItemList(held)}`)
      const result = await this.warehouse.depositInventoryForOwner(owner.uuid, owner.username)
      if (result.leftover?.length) {
        throw new Error(`机器人背包里还有上次 ${task.actorUsername || owner.username} 存入的物品未能入库：${this.formatItemList(result.leftover)}。请先检查仓库路径或空间。`)
      }
      this.db.addTransaction('deposit_residual_recovery', result.deposited.length ? 'ok' : 'empty', owner.uuid, owner.username, result.deposited, `actor=${task.actorUsername}, phase=${task.phase}`)
      this.db.clearRecoveryTask(this.botId)
      return
    }

    if (task?.type === 'withdraw') {
      console.warn(`[residual-recovery] returning pending withdraw items before task: actor=${task.actorUsername}, target=${task.targetUsername}, held=${this.formatItemList(held)}`)
      const owner = this.recoveryOwnerFromTask(task)
      const delivered = this.isWithdrawDeliveryPhase(task.phase) && task.items?.length
        ? this.subtractLeftoverFromDelivered(task.items, held)
        : []
      const result = await this.warehouse.depositInventoryWithoutBalance('withdraw_residual_recovery', `actor=${task.actorUsername}, target=${task.targetUsername}, phase=${task.phase}`)
      if (result.leftover?.length) {
        throw new Error(`机器人背包里还有上次取货未交付物品未能回收入库：${this.formatItemList(result.leftover)}。请先检查仓库路径或空间。`)
      }
        if (delivered.length) {
          this.recordWithdrawDeduction(owner, delivered, `actor=${task.actorUsername}, target=${task.targetUsername}, phase=${task.phase}, recovery=residual`, this.recoveryDeductionKey(task))
        }

      if (pendingRepack) this.commitRecoveredShulkerRepack(result, 'residual')
      this.db.clearRecoveryTask(this.botId)
      return
    }

    if (pendingRepack) {
      console.warn(`[shulker-repack-recovery] returning pending repack without generic task bot=${this.botId}`)
      const result = await this.warehouse.depositInventoryWithoutBalance('shulker_repack_residual_recovery', `bot=${this.botId}`)
      this.commitRecoveredShulkerRepack(result, 'residual_without_task')
      return
    }

    const unaccounted = this.unaccountedResidualItems(held)
    if (unaccounted.length) {
      this.accountResidualAsMomo(unaccounted, 'flush residual before task')
    }

    const result = await this.warehouse.depositInventoryWithoutBalance('momo_residual_physical_store', 'already_accounted_as_momo')
    if (result.deposited.length) {
      this.markAccountedResidualStored(result.deposited)
      console.warn(`Residual inventory physically stored for momo: ${this.formatItemList(result.deposited)}`)
    }
    if (result.leftover?.length) {
      throw new Error(`机器人背包仍有已记为 momo 的残留物品无法入库，为避免影响下一个玩家，已停止本次服务：${this.formatItemList(result.leftover)}`)
    }
  }

  accountResidualAsMomo (items, message = '') {
    const normalized = this.mergeItems(items || []).filter(item => item.amount > 0)
    if (!normalized.length) return
    this.db.addBalanceItems(this.config.momoOwner, normalized)
    this.db.addTransaction('residual_to_momo', 'ok', this.config.momoOwner, 'momo', normalized, message)
    for (const item of normalized) {
      this.accountedResidual.set(item.itemKey, (this.accountedResidual.get(item.itemKey) || 0) + item.amount)
    }
    console.warn(`Residual inventory accounted as momo: ${this.formatItemList(normalized)} ${message}`)
  }

  unaccountedResidualItems (held) {
    const result = []
    for (const item of held) {
      const accounted = this.accountedResidual.get(item.itemKey) || 0
      const amount = item.amount - accounted
      if (amount > 0) result.push({ ...item, amount })
    }
    return result
  }

  markAccountedResidualStored (items) {
    for (const item of items || []) {
      const current = this.accountedResidual.get(item.itemKey) || 0
      const next = Math.max(0, current - item.amount)
      if (next > 0) this.accountedResidual.set(item.itemKey, next)
      else this.accountedResidual.delete(item.itemKey)
    }
  }

  isActiveCancelled () {
    return Boolean(this.active?.cancelled || this.active?.dead)
  }

  // 解析玩家的当前实体。bot.players[name].entity 在跨维度传送后会失效
  // （旧维度引用被清空或指向旧坐标），此时扫 bot.entities 里的玩家实体兜底。
  // 返回 { entity, source }：source 记录命中途径，供日志区分。
  resolvePlayerEntity (username) {
    const name = String(username || '')
    if (!name) return { entity: null, source: '' }
    const direct = this.bot.players?.[name]
    if (direct?.entity?.position) {
      return { entity: direct.entity, source: 'players' }
    }
    const lower = name.toLowerCase()
    // 大小写变体（含改名/装饰符号）：players 表里按前缀找
    const variantKey = Object.keys(this.bot.players || {}).find(key =>
      key.toLowerCase() === lower && this.bot.players[key]?.entity?.position)
    if (variantKey) return { entity: this.bot.players[variantKey].entity, source: 'players-variant' }
    // 实体表兜底：跨维度后 spawn 包已到、players 引用未重新关联时，
    // bot.entities 里有真实玩家实体（username 与玩家名一致）。
    const entities = this.bot.entities || {}
    const entityValues = typeof entities.values === 'function' ? [...entities.values()] : Object.values(entities)
    const match = entityValues.find(entity =>
      entity?.type === 'player' &&
      typeof entity.username === 'string' &&
      entity.username.toLowerCase() === lower &&
      entity.position)
    if (match) return { entity: match, source: 'entities' }
    return { entity: null, source: '' }
  }

  getPlayer (username) {
    const rawUuid = this.bot.players[username]?.uuid || `name:${username}`
    // upsertPlayer 内部会再过一次 canonical + v3→v4 改挂；这里先 canonical 是为了
    // 返回给调用方的 uuid 就是最终归属，避免调用方拿旧 v3 去写 balances。
    const uuid = this.db.resolveOfflineUuidToMojang(this.db.canonicalPlayerUuid(rawUuid), username)
    this.db.upsertPlayer(uuid, username)
    return { uuid, username }
  }

  resolvePlayer (username) {
    const onlineName = Object.keys(this.bot.players).find(name => name.toLowerCase() === username.toLowerCase())
    const online = onlineName ? this.bot.players[onlineName] : null
    if (online?.uuid) {
      const uuid = this.db.resolveOfflineUuidToMojang(this.db.canonicalPlayerUuid(online.uuid), onlineName)
      this.db.upsertPlayer(uuid, onlineName)
      return { uuid, username: onlineName }
    }

    const known = this.db.getPlayerByUsername(username)
    if (known) return known

    const fallback = { uuid: `name:${username}`, username }
    this.db.upsertPlayer(fallback.uuid, fallback.username)
    return fallback
  }

  touchPlayer (username) {
    this.getPlayer(username)
  }

  resolveCustomWarehouseOwner (warehouse) {
    return {
      uuid: `vault:${warehouse.nameLower}`,
      username: `仓库:${warehouse.name}`,
      vaultName: warehouse.name,
      scope: 'custom'
    }
  }

  defaultStorageOwnerForPlayer (player) {
    const ownerUuid = this.db.getEffectiveDefaultOwnerUuid(player.uuid)
    if (ownerUuid.startsWith('vault:')) {
      const warehouse = this.db.getCustomWarehouse(ownerUuid.slice(6))
      if (warehouse && this.db.isCustomWarehouseMember(warehouse.name, player.uuid)) {
        return this.resolveCustomWarehouseOwner(warehouse)
      }
    }
    if (ownerUuid === player.uuid && this.db.hasPersonalWarehouse(player.uuid)) return { ...player, scope: 'personal' }
    throw new Error('你目前没有可用仓库。请联系云仓库管理员创建个人仓库，或让组织仓库管理员把你加入仓库。')
  }

  defaultOwnerLabel (owner) {
    if (owner?.scope === 'custom') return `自定义仓库 ${owner.vaultName}`
    return '个人仓库'
  }

  resolveStorageOwnerByKeyword (username, text) {
    const raw = String(text || '').trim()
    const player = this.getPlayer(username)
    if (!raw || raw === '个人') {
      if (!this.db.hasPersonalWarehouse(player.uuid)) throw new Error('你没有个人仓库。请联系云仓库管理员创建。')
      return { ...player, scope: 'personal' }
    }
    const warehouse = this.db.getCustomWarehouse(raw)
    if (!warehouse) throw new Error(`找不到自定义仓库：${raw}`)
    if (!this.db.isCustomWarehouseMember(warehouse.name, player.uuid)) {
      throw new Error(`你不是仓库 ${warehouse.name} 的成员。`)
    }
    return this.resolveCustomWarehouseOwner(warehouse)
  }

  resolveQuotaOwnerArgument (text) {
    const raw = String(text || '').trim()
    if (!raw) throw new Error('目标不能为空。')
    if (raw.startsWith('仓库:') || raw.toLowerCase().startsWith('vault:')) {
      const name = raw.startsWith('仓库:') ? raw.slice(3).trim() : raw.slice(6).trim()
      if (!name) throw new Error('仓库名不能为空。')
      const warehouse = this.db.getCustomWarehouse(name)
      if (!warehouse) throw new Error(`找不到自定义仓库：${name}`)
      return this.resolveCustomWarehouseOwner(warehouse)
    }
    const onlineName = Object.keys(this.bot.players).find(name => name.toLowerCase() === raw.toLowerCase())
    const online = onlineName ? this.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      const uuid = this.db.canonicalPlayerUuid(online.uuid)
      if (!this.db.hasPersonalWarehouse(uuid)) throw new Error(`${onlineName} 还没有个人仓库。请先创建仓库。`)
      return { uuid, username: onlineName, scope: 'personal' }
    }
    const known = this.db.getPlayerByUsername(raw)
    if (!known) {
      throw new Error(`找不到玩家：${raw}。设置额度需要玩家至少使用过机器人或在线。`)
    }
    if (!this.db.hasPersonalWarehouse(known.uuid)) throw new Error(`${known.username} 还没有个人仓库。请先创建仓库。`)
    return { ...known, scope: 'personal' }
  }

  validateCustomWarehouseName (name) {
    const text = String(name || '').trim()
    if (!text) return '仓库名不能为空。'
    if (/\s/.test(text)) return '仓库名不能包含空格。'
    if ([...text].length > 15) return '仓库名最多 15 个字。'
    return null
  }

  ownerScopeName (owner) {
    if (owner?.scope === 'custom') return `自定义仓库 ${owner.vaultName}`
    return '仓库'
  }

  ownerSubjectName (owner) {
    if (owner?.scope === 'custom') return `仓库 ${owner.vaultName}`
    return '你的仓库'
  }

  ownerActionPrefix (owner) {
    if (owner?.scope === 'custom') return `${owner.vaultName} `
    return ''
  }

  queryOwnerLabel (owner) {
    if (owner?.uuid === this.config.momoOwner) return 'momo 当前'
    if (owner?.scope === 'custom') return `${owner.vaultName} 当前`
    return '你当前'
  }

  extractWithdrawText (text, owner) {
    if (owner?.strictPersonal) {
      return text.replace(/^!个人\s+取\s*/, '')
    }
    if (/^!(取物品|取)\s*/.test(text)) {
      return text.replace(/^!(取物品|取)\s*/, '')
    }
    if (owner?.scope === 'custom') {
      const escaped = owner.vaultName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return text.replace(new RegExp(`^!${escaped}\\s+取\\s*`), '')
    }
    return text.replace(/^!(取物品|取)\s*/, '')
  }

  isAdmin (username) {
    const uuid = this.bot.players[username]?.uuid || null
    return this.db.isAdmin(username, uuid)
  }

  isSelfUsername (username) {
    if (!username) return false
    return String(username).toLowerCase() === String(this.bot.username || '').toLowerCase()
  }

  async teleportToPlayer (username, options = {}) {
    const commandTemplate = this.config.commands.tpa || '/tpa {player}'
    const timeoutMs = this.config.timing.teleportRequestTimeoutMs || 15000
    const radius = this.config.timing.teleportDetectRadius || 8

    if (options.notify !== false) {
      this.msg(username, '已向你发送传送请求，请在15秒内接受。')
    }
    this.bot.chat(commandTemplate.replace('{player}', username))

    const ok = await this.waitForPlayerNearby(username, timeoutMs, radius, options)
    if (ok) {
      if (this.config.debug) console.log(`[teleport] arrived near ${username}`)
      await this.waitForTeleportChunksReady(username, { ignoreCancellation: options.ignoreCancellation })
      return true
    }

    const resolved = this.resolvePlayerEntity(username)
    const resolvedPos = resolved.entity?.position
    const botPos = this.bot.entity?.position
    const resolvedDistance = resolvedPos && botPos ? resolvedPos.distanceTo(botPos) : null
    console.warn(`[teleport] /tpa ${username} timed out after ${timeoutMs}ms` +
      ` (resolve=${resolved.source || 'none'}, distance=${resolvedDistance === null ? 'unknown' : Math.round(resolvedDistance)}, bot=${this.describePosition(botPos)})`)
    this.msg(username, '15秒内没有检测到你在附近，本次操作已取消；如果稍后看到这条传送请求，请不要再接受。')
    return false
  }

  // 传送后不等区块全量加载：只要 bot 自己和目标玩家所在区块都已就绪，
  // 就让调用方立即瞄准丢物。postTeleportWaitMs 的含义由"固定等待时长"
  // 改为"等待上限"，超时仍继续交付（玩家已在传送检测半径内）。
  async waitForTeleportChunksReady (username, { ignoreCancellation = false } = {}) {
    const timeoutMs = Number(this.config.timing.postTeleportWaitMs) || 500
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (!ignoreCancellation && this.isActiveCancelled()) return false
      const botPos = this.bot.entity?.position
      const targetPos = this.resolvePlayerEntity(username).entity?.position
      const botChunkReady = Boolean(botPos && this.bot.world?.getColumnAt?.(botPos))
      const targetChunkReady = Boolean(targetPos && this.bot.world?.getColumnAt?.(targetPos))
      if (botChunkReady && targetChunkReady) return true
      await sleep(250)
    }
    return false
  }

  // 等玩家出现在传送检测半径内。三条判定路径：
  //   1. 玩家实体距离 ≤ radius —— 常规同维度传送；
  //   2. 跨维度传送已生效（bot 自身坐标大幅跳变）后，players 引用可能失效：
  //      此时用实体表兜底解析并重试一段时间（宽限窗口）；
  //   3. 宽限窗结束时实体表仍无该玩家，但 bot 明确已传送到别处
  //      （跳变 > 50 格且自身区块已就绪）——按"传送已生效但实体未知"降级放行。
  //      放行是安全的：后续 lookAtPlayer/dropItemsToPlayer 同样用兜底解析器，
  //      解析不到会显式报错，不会丢歪。
  async waitForPlayerNearby (username, timeoutMs, radius, options = {}) {
    const startedAt = Date.now()
    const startPos = this.bot.entity?.position?.clone()
    let movedLogged = false
    let teleportJumped = false
    const graceMs = 5000
    let graceLogged = false

    while (Date.now() - startedAt < timeoutMs) {
      if (!options.ignoreCancellation && this.isActiveCancelled()) return false

      const botPos = this.bot.entity?.position
      const resolved = this.resolvePlayerEntity(username)
      if (resolved.entity && botPos) {
        const distance = resolved.entity.position.distanceTo(botPos)
        if (distance <= radius) {
          if (resolved.source && resolved.source !== 'players') {
            console.log(`[teleport] near ${username} resolved via ${resolved.source}, distance=${Math.round(distance)}`)
          }
          return true
        }
      }

      if (!movedLogged && startPos && botPos && botPos.distanceTo(startPos) > 3) {
        movedLogged = true
        if (this.config.debug) {
          console.log(`[teleport] bot position changed while waiting for ${username}: ${this.describePosition(startPos)} -> ${this.describePosition(botPos)}`)
        }
      }

      // 传送已生效的信号：bot 自身坐标相对发出 tpa 时大幅跳变。
      // 说明玩家已接受传送（tpa 只会把 bot 传过去），此时玩家实体
      // 引用失效是跨维度重置的已知模式，不该死磕 8 格判定。
      if (!teleportJumped && startPos && botPos && botPos.distanceTo(startPos) > 50) {
        teleportJumped = true
        console.log(`[teleport] bot jumped ${Math.round(botPos.distanceTo(startPos))} blocks while waiting for ${username}: teleport accepted, player entity may be detached (cross-dimension). Grace window ${graceMs}ms starts.`)
      }
      if (teleportJumped && !graceLogged) {
        graceLogged = true
        // 宽限窗：给 spawn/respawn 包时间到达，期间每轮继续尝试上面的实体判定
        const graceDeadline = Math.min(Date.now() + graceMs, startedAt + timeoutMs)
        while (Date.now() < graceDeadline) {
          if (!options.ignoreCancellation && this.isActiveCancelled()) return false
          const graceResolved = this.resolvePlayerEntity(username)
          const graceBotPos = this.bot.entity?.position
          if (graceResolved.entity && graceBotPos) {
            const graceDistance = graceResolved.entity.position.distanceTo(graceBotPos)
            if (graceDistance <= radius) {
              console.log(`[teleport] near ${username} after teleport grace, distance=${Math.round(graceDistance)}, source=${graceResolved.source || 'players'}`)
              return true
            }
          }
          await sleep(250)
        }
        // 宽限窗结束：实体表仍找不到该玩家。bot 确实传送了（tpa 不会失败成
        // "bot 坐标跳到别处"），此时大概率站在玩家身边只是实体未关联。
        // 自身区块就绪即降级放行；不就绪再等到主循环超时。
        const botReady = Boolean(this.bot.entity?.position && this.bot.world?.getColumnAt?.(this.bot.entity.position))
        if (botReady) {
          console.log(`[teleport] player entity for ${username} unresolved after grace window; teleport was accepted, passing through (drop will fail loudly if aim fails).`)
          return true
        }
      }

      await sleep(250)
    }

    return false
  }

  describePosition (pos) {
    if (!pos) return '?'
    return `${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}`
  }

  msg (username, message) {
    const template = this.config.commands.msg
    const chunks = this.splitMessage(String(message), 80)
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      const privateCommand = template.replace('{player}', username).replace('{message}', chunk)
      if (this.config.debugChat) console.log(`[reply] ${this.redactSensitiveText(privateCommand)}`)
      this.traceReply(username, chunk, chunks.length > 1 ? `${index + 1}/${chunks.length}` : '')
      this.bot.chat(privateCommand)
      this.db.addCommandReply({
        targetUsername: username,
        channel: 'private',
        botId: this.botId,
        botName: this.bot.username || this.config.server?.botName || this.botId,
        message: this.redactSensitiveText(chunk)
      })
      if (this.config.commands.publicFallback) {
        const publicMessage = `@${username} ${chunk}`
        if (this.config.debugChat) console.log(`[reply:publicFallback] ${this.redactSensitiveText(publicMessage)}`)
        this.bot.chat(publicMessage)
        this.db.addCommandReply({
          targetUsername: username,
          channel: 'public',
          botId: this.botId,
          botName: this.bot.username || this.config.server?.botName || this.botId,
          message: this.redactSensitiveText(publicMessage)
        })
      }
    }
  }

  // 机器人回复玩家：挂在当前任务链路上；任务之外的回复（如机器人忙、查询结果）单独成行。
  traceReply (to, message, chunk = '') {
    const data = { to, message: this.redactSensitiveText(message) }
    if (chunk) data.chunk = chunk
    const trace = this.warehouse?.activeTrace
    if (trace) traceEvent(trace, 'reply', 'bot_reply', data)
    else traceStandalone('reply', 'reply', 'bot_reply', { bot: this.botId, ...data })
  }

  redactSensitiveText (text) {
    const value = String(text || '')
    if (!/设置密钥|设置密码|登录/.test(value)) return value
    return value
      .replace(/(!设置(?:密钥|密码))\s+.+$/u, '$1 [已隐藏]')
      .replace(/(已设置(?:密钥|密码)：)[^。 ]+/gu, '$1[已隐藏]')
      .replace(/(!登录)\s+\d{6}$/u, '$1 [验证码已隐藏]')
      .replace(/(登录)\s+\d{6}$/u, '$1 [验证码已隐藏]')
  }

  normalizeCommandText (message) {
    const text = this.stripChatCommandSuffix(String(message || '').trim())
    return text.startsWith('！') ? `!${text.slice(1)}` : text
  }

  stripChatCommandSuffix (text) {
    return text
      .replace(/\s*喵[~～!！。.]?\s*$/u, '')
      .trim()
  }

  normalizePrivateCommandText (message, source) {
    const text = this.normalizeCommandText(message)
    if (!this.isPrivateSource(source) || text.startsWith('!')) return text
    if (text === '修装备' || text.startsWith('修装备 ')) return `!${text}`

    const commandNames = [
      '创建仓库',
      '我的仓库',
      '默认仓库',
      '设置默认仓库',
      '个人',
      '查询',
      '查',
      '额度',
      '加管理员',
      '加管理',
      '指令',
      '切换',
      '设置密钥',
      '设置密码',
      '登录',
      '设置额度',
      '增加',
      '减少',
      '清空库存',
      '清理库存',
      '同步木桶',
      '同步仓库',
      '同步',
      '急救',
      '热重载',
      '存物品',
      '存取',
      '取存',
      '热重载',
      '存',
      '取物品',
      '取'
    ]

    for (const name of commandNames) {
      if (text === name || text.startsWith(`${name} `)) {
        return `!${text}`
      }
    }

    if (/^\S{1,15}\s+(添加成员|加成员|删除成员|删成员|添加管理|添加管理员|加管理|加管理员|删除管理|删除管理员|删管理|删管理员|查|存|取|仓库成员|成员|查看成员|成员列表)(?:\s+.*)?$/.test(text)) {
      return `!${text}`
    }

    return text
  }

  isPrivateSource (source) {
    return String(source || '').includes('private') || String(source || '').includes('whisper')
  }

  splitMessage (message, maxLength) {
    const chunks = []
    let text = message
    while (text.length > maxLength) {
      chunks.push(text.slice(0, maxLength))
      text = text.slice(maxLength)
    }
    chunks.push(text)
    return chunks
  }

  totalAmount (items) {
    return items.reduce((sum, item) => sum + item.amount, 0)
  }

  itemTypeCount (items) {
    return new Set((items || []).map(item => item.itemKey || item.itemId).filter(Boolean)).size
  }

  mergeItems (items) {
    const byKey = new Map()
    for (const item of items || []) {
      if (!item?.itemKey || !item.amount) continue
      const existing = byKey.get(item.itemKey)
      if (existing) {
        existing.amount += item.amount
        if (Number(item.coverageAmount || 0) > 0 || Number(existing.coverageAmount || 0) > 0) {
          existing.coverageAmount = Number(existing.coverageAmount || 0) + Number(item.coverageAmount || 0)
        }
      } else {
        byKey.set(item.itemKey, { ...item })
      }
    }
    return [...byKey.values()]
  }

  formatItemList (items) {
    if (!items.length) return '无'
    return items.map(item => `${this.formatItemNameWithCode(item)} x${item.amount}`).join('，')
  }

  formatDepositSummary (items) {
    const typeCount = this.itemTypeCount(items)
    return `${typeCount}种物品`
  }

  formatWithdrawSummary (items) {
    return `${this.itemTypeCount(items)}种物品，共${this.totalAmount(items)}个`
  }

  getStorageQuota (ownerUuid, scope = 'personal') {
    const quotaSlots = this.subscriptions
      ? this.subscriptions.getOwnerEntitlement(ownerUuid).quotaSlots
      : this.db.getQuotaSlots(ownerUuid, scope === 'custom'
        ? (this.config.storage?.defaultCustomWarehouseQuotaSlots || this.config.storage?.defaultQuotaSlots || 270)
        : (this.config.storage?.defaultQuotaSlots || 270))
    const rows = this.db.getOwnerBalances(ownerUuid)
    let usedSlots = 0
    let usedItems = 0

    for (const row of rows) {
      const stackSize = Math.max(1, this.catalog.getStackSize(row.itemId))
      usedSlots += Math.ceil(row.amount / stackSize)
      usedItems += row.amount
    }

    return { usedSlots, quotaSlots, usedItems }
  }
}

module.exports = CloudStoreService
