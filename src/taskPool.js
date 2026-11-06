class AsyncMutex {
  constructor () {
    this.tail = Promise.resolve()
  }

  async run (fn) {
    const previous = this.tail
    let release
    this.tail = new Promise(resolve => { release = resolve })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

class BotTaskPool {
  constructor (config = {}) {
    this.config = config
    this.workers = new Set()
    this.queue = []
    this.sequence = 0
    this.seenMessages = new Map()
    // Retain the execution lease even when death/reconnect changes worker.active
    // or unregisters a disconnected worker. Its network calls may still drain.
    this.inFlight = new Map()
    this.drainWaiters = new Set()
    this.warehouseMutex = new AsyncMutex()
    this.warehouseState = { revision: 0, chestRevisions: new Map() }
  }

  register (service) {
    this.workers.add(service)
    this.dispatch()
  }

  unregister (service) {
    this.workers.delete(service)
    this.dispatch()
  }

  cancelQueuedForWorker (worker) {
    const cancelled = []
    this.queue = this.queue.filter(task => {
      if (task.stickyWorker !== worker) return true
      cancelled.push(task)
      task.resolve?.(null)
      return false
    })
    if (cancelled.length) this.dispatch()
    return cancelled.length
  }

  cancelQueuedCraftRecovery (botId) {
    const cancelled = []
    this.queue = this.queue.filter(task => {
      if (task.type !== 'craft_recovery' || task.stickyWorker?.botId !== botId) return true
      cancelled.push(task)
      task.resolve?.(null)
      return false
    })
    if (cancelled.length) this.dispatch()
    return cancelled.length
  }

  acceptIncoming (username, message, source = '') {
    if (!String(message || '').trim().startsWith('!')) return true
    const now = Date.now()
    const ttl = Math.max(500, Number(this.config.timing?.commandDedupeMs || 1500))
    const key = `${String(username).toLowerCase()}|${source}|${String(message).trim()}`
    const seenAt = this.seenMessages.get(key) || 0
    if (now - seenAt < ttl) return false
    this.seenMessages.set(key, now)
    for (const [entry, timestamp] of this.seenMessages) {
      if (now - timestamp > ttl * 4) this.seenMessages.delete(entry)
    }
    return true
  }

  enqueue (task) {
    return new Promise((resolve, reject) => {
      const queued = {
        ...task,
        id: ++this.sequence,
        resolve,
        reject,
        enqueuedAt: Date.now()
      }
      this.queue.push(queued)
      task.onQueued?.(this.queue.length)
      this.dispatch()
    })
  }

  eligibleWorkerForTask (task) {
    // Craft recovery is bound to the bot that owns its physical inventory and
    // durable journal. Unlike ordinary private tasks, it must never fall back.
    if (task.type === 'craft_recovery') {
      const original = task.stickyWorker
      const sticky = this.workers.has(original) ? original : original?.botId
        ? [...this.workers].find(worker => worker.botId === original.botId)
        : null
      if (!sticky) return null
      return sticky.ready && !sticky.connectionInvalidated && !sticky.active && !this.inFlight.has(sticky) &&
        !(sticky.botId && this.hasInFlightCraft(sticky.botId)) && !sticky.recoveringFromDeath && !sticky.emergencyRescueActive ? sticky : null
    }
    // 私聊进来的业务任务绑定接收私信的机器人；该机器人掉线后退回任意空闲机器人，避免任务卡死。
    if (task.stickyWorker && this.workers.has(task.stickyWorker)) {
      const sticky = task.stickyWorker
      return sticky.ready && !sticky.active && !this.inFlight.has(sticky) && !sticky.recoveringFromDeath && !sticky.emergencyRescueActive ? sticky : null
    }
    return [...this.workers].find(candidate => candidate.ready && !candidate.active && !this.inFlight.has(candidate) && !candidate.recoveringFromDeath && !candidate.emergencyRescueActive) || null
  }

  hasInFlightCraft (botId = '') {
    return [...this.inFlight].some(([worker, task]) =>
      (task.type === 'craft' || task.type === 'craft_recovery') && (!botId || worker.botId === botId))
  }

  waitForCraftDrain (botId = '') {
    if (!this.hasInFlightCraft(botId)) return Promise.resolve()
    return new Promise(resolve => this.drainWaiters.add({ botId, resolve }))
  }

  resolveCraftDrainWaiters () {
    for (const waiter of this.drainWaiters) {
      if (!this.hasInFlightCraft(waiter.botId)) {
        this.drainWaiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  snapshot () {
    const active = [...this.workers]
      .filter(worker => worker.active)
      .map(worker => ({ ...worker.active, botName: worker.bot.username }))
    return {
      queued: this.queue.map(task => ({
        id: task.id,
        type: task.type,
        username: task.username,
        stickyBotName: this.workers.has(task.stickyWorker) ? task.stickyWorker.bot.username : ''
      })),
      active,
      onlineBots: this.workers.size
    }
  }

  dispatch () {
    if ([...this.inFlight.values()].some(task => task.exclusive)) return
    if ([...this.workers].some(worker => worker.active?.exclusive)) return
    for (let index = 0; index < this.queue.length; index++) {
      const task = this.queue[index]
      const worker = this.eligibleWorkerForTask(task)
      // An offline/busy recovery owner cannot start yet. Keep its bot binding,
      // but only make it a global barrier once that recovery can actually run.
      if (task.exclusive) {
        if (task.type === 'craft_recovery' && !worker) continue
        if (this.inFlight.size || [...this.workers].some(current => current.active) || !worker) break
        this.queue.splice(index, 1)
        this.run(worker, task)
        return
      }
      if (!worker) continue
      this.queue.splice(index, 1)
      index--
      this.run(worker, task)
    }
  }

  async run (worker, task) {
    this.inFlight.set(worker, task)
    try {
      const result = await worker.runExclusive(task.username, task.type, () => task.run(worker), {
        taskId: task.id,
        commandLogId: task.commandLogId || 0,
        exclusive: Boolean(task.exclusive)
      })
      task.resolve(result)
    } catch (error) {
      worker.handleCommandError(task.username, error)
      task.resolve(null)
    } finally {
      this.inFlight.delete(worker)
      this.resolveCraftDrainWaiters()
      this.dispatch()
    }
  }
}

module.exports = { AsyncMutex, BotTaskPool }
