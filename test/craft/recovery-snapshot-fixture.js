'use strict'

// A separate simulated server store emits the real packet boundary consumed by
// openServerContainer. It does not obtain truth from the chest-slot database.
function attachRecoverySnapshots (warehouse, bot, catalog, chestItems) {
  const Item = require('prismarine-item')(catalog.mcData)
  let windowId = 100
  warehouse.openContainerAt = async chest => {
    const container = { id: ++windowId, type: 'minecraft:generic_9x3', inventoryStart: 27, inventoryEnd: 63 }
    const items = Array.from({ length: 63 }, () => Item.toNotch(null))
    chestItems(chest).filter(value => value.count > 0).forEach((value, slot) => { items[slot] = Item.toNotch(value) })
    bot.inventory.items().forEach((value, slot) => { items[27 + slot] = Item.toNotch(value) })
    bot.currentWindow = container
    bot._client.emit('open_window', { windowId: container.id })
    bot._client.emit('window_items', { windowId: container.id, items, carriedItem: Item.toNotch(bot.inventory.selectedItem) })
    return container
  }
  warehouse.closeContainerQuietly = () => { bot.currentWindow = null }
}

module.exports = { attachRecoverySnapshots }
